import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Tracker, sampleAt, roadLengthM } from './dist/engine.js';

const bundle = JSON.parse(readFileSync(new URL('./dist/data/roads.json', import.meta.url)));
const local = JSON.parse(readFileSync(new URL('./dist/data/local-roads.json', import.meta.url)));
const layered = { ...bundle, localRoads: local };
const byId = new Map(bundle.roads.map(road => [road.id, road]));
const refs = ['AYE', 'BKE', 'CTE', 'ECP', 'KJE', 'KPE', 'MCE', 'PIE', 'SLE', 'TPE'];

test('bundled geometry covers all ten expressway references with valid connected segments', () => {
  assert.deepEqual([...new Set(bundle.roads.map(road => road.ref))].sort(), refs);
  for (const road of bundle.roads) {
    assert.ok(road.coordinates.length >= 2, road.id);
    for (const [lon, lat] of road.coordinates) {
      assert.ok(lon >= 103 && lon <= 105 && lat >= 1 && lat <= 2, road.id);
    }
    for (const id of road.nextRoadIds) {
      const next = byId.get(id);
      assert.ok(next, `${road.id} references missing ${id}`);
      assert.equal(next.ref, road.ref, `${road.id} changes reference`);
      assert.deepEqual(road.coordinates.at(-1), next.coordinates[0], `${road.id} has disconnected successor`);
    }
  }
});

test('a real connected PIE transition retains timing and downstream exits', () => {
  const first = byId.get('osm-way-32877553');
  const second = byId.get('osm-way-649605845');
  assert.ok(first.nextRoadIds.includes(second.id));
  const tracker = new Tracker(layered);
  const now = Date.now();
  const fix = (road, distance, ms) => ({ ...sampleAt(road, distance), accuracy: 5, speed: 20, timestamp: now + ms });
  tracker.update(fix(first, first.lengthM - 80, 0));
  const before = tracker.update(fix(first, first.lengthM - 5, 3000));
  const after = tracker.update(fix(second, 70, 7000));
  assert.equal(after.road.id, second.id);
  assert.ok(before.exits.length > 0, 'downstream exit should be visible before crossing');
  assert.ok(after.elapsedSeconds > before.elapsedSeconds, 'connected segment crossing must preserve elapsed time');
  assert.ok(after.deltaSeconds !== 0, 'connected segment crossing must preserve pace comparison');
});

test('twenty long connected paths keep time and ordered upcoming exits', () => {
  const incoming = new Map(bundle.roads.map(road => [road.id, 0]));
  for (const road of bundle.roads) for (const next of road.nextRoadIds) incoming.set(next, incoming.get(next) + 1);
  const starts = bundle.roads.filter(road => incoming.get(road.id) === 0);
  const paths = starts.map(start => {
    const path = [], visited = new Set();
    let road = start;
    while (road && !visited.has(road.id)) {
      visited.add(road.id);
      path.push(road);
      road = road.nextRoadIds.map(id => byId.get(id))
        .filter(next => next && !visited.has(next.id))
        .sort((a, b) => b.lengthM - a.lengthM)[0];
    }
    return path;
  }).sort((a, b) => b.reduce((n, road) => n + road.lengthM, 0) - a.reduce((n, road) => n + road.lengthM, 0));
  assert.ok(paths.length >= 20);
  const selected = paths.slice(0, 20);
  let resets = 0, transitions = 0, exitStates = 0, duplicates = 0, firstReset, firstDuplicate;
  for (const path of selected) {
    const tracker = new Tracker({ roads: path, localRoads: local });
    let tick = 0, previous = null;
    for (const road of path) {
      // Sample each segment, including short ways, while keeping a realistic
      // 25 m/s progression between consecutive one-second fixes.
      const steps = Math.max(1, Math.ceil(road.lengthM / 25));
      for (let i = 0; i <= steps; i++) {
        const at = road.lengthM * i / steps;
        const state = tracker.update({ ...sampleAt(road, at), accuracy: 5,
          speed: 25, timestamp: 1_800_000_000_000 + tick++ * 1000 });
        if (previous?.status === 'tracking' && state.status === 'tracking' &&
            previous.limitKmh && state.limitKmh && previous.road?.ref === state.road?.ref) {
          transitions++;
          if (state.elapsedSeconds + 0.001 < previous.elapsedSeconds) {
            resets++;
            firstReset ||= `${road.ref} ${road.id} at ${at.toFixed(1)}m: ${previous.road?.id} ${previous.elapsedSeconds}s -> ${state.road?.id} ${state.elapsedSeconds}s`;
          }
        }
        const exits = state.exits || [];
        if (exits.length) exitStates++;
        assert.ok(exits.length <= 3);
        assert.ok(exits.every(exit => exit.distanceM > 0));
        assert.ok(exits.every((exit, index) => index === 0 || exits[index - 1].distanceM <= exit.distanceM));
        if (new Set(exits.map(exit => `${exit.name}|${exit.distanceM.toFixed(1)}`)).size !== exits.length) {
          duplicates++;
          firstDuplicate ||= `${road.ref} ${road.id} at ${at.toFixed(1)}m: ${JSON.stringify(exits)}`;
        }
        previous = state;
      }
    }
  }
  assert.ok(transitions > 1000, `only ${transitions} comparable samples`);
  assert.ok(exitStates > 0, 'no upcoming exits seen');
  assert.equal(resets, 0, `${resets} elapsed-time resets across ${transitions} comparable samples; first ${firstReset}`);
  assert.equal(duplicates, 0, `${duplicates} samples displayed duplicate exits; first ${firstDuplicate}`);
});

test('local layer contains motor roads and retains unknown names', () => {
  const allowed = new Set(['residential', 'primary', 'secondary', 'tertiary', 'unclassified',
    'trunk', 'motorway', 'motorway_link', 'primary_link', 'secondary_link', 'tertiary_link', 'trunk_link', 'living_street']);
  assert.ok(local.roads.length > 70000);
  assert.ok(local.roads.every(road => allowed.has(road.highway) && road.expressway === false));
  assert.ok(local.roads.some(road => road.name == null));
  assert.ok(local.roads.every(road => road.name == null || typeof road.name === 'string'));
});

test('local road reports its mapped name and GPS speed without expressway delta', () => {
  const road = local.roads.find(r => r.name && r.highway === 'residential' && r.coordinates.length >= 2);
  const tracker = new Tracker({ roads: [], localRoads: [road] });
  const point = sampleAt(road, 10);
  const fix = { ...point, speed: 12, accuracy: 5, timestamp: 1_800_000_000_000 };
  tracker.update(fix);
  const state = tracker.update({ ...fix, timestamp: fix.timestamp + 1000 });
  assert.equal(state.status, 'local');
  assert.equal(state.road.name, road.name);
  assert.equal(state.speedKmh, 43.2);
  assert.equal(state.deltaSeconds, null);
  assert.equal(state.limitKmh, null);
  assert.deepEqual(state.exits, []);
});

test('real TPE ramp requires confirmed exit before showing local road without delta', () => {
  const mainline = byId.get('osm-way-62272687');
  const ramp = local.roads.find(road => road.id === 'osm-way-32790032');
  assert.ok(mainline.exits.some(exit => exit.id === ramp.id));
  const tracker = new Tracker({ roads: [mainline], localRoads: [ramp] });
  let timestamp = 1_800_000_000_000;
  const update = (road, fraction) => tracker.update({ ...sampleAt(road, roadLengthM(road) * fraction),
    accuracy: 5, speed: 15, timestamp: timestamp += 1000 });
  update(mainline, .3);
  const expressway = update(mainline, .5);
  const uncertain = update(ramp, .2);
  const localState = update(ramp, .6);
  assert.equal(expressway.status, 'tracking');
  assert.equal(uncertain.status, 'exiting');
  assert.equal(uncertain.deltaSeconds, null);
  assert.equal(localState.status, 'local');
  assert.equal(localState.road.id, ramp.id);
  assert.equal(localState.speedKmh, 54);
  assert.equal(localState.deltaSeconds, null);
  assert.deepEqual(localState.exits, []);
});
