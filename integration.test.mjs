import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Tracker, sampleAt } from './dist/engine.js';

const bundle = JSON.parse(readFileSync(new URL('./dist/data/roads.json', import.meta.url)));
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
  const tracker = new Tracker(bundle);
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
    const tracker = new Tracker({ roads: path });
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
