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
  const road = local.roads.find(r => r.name && r.highway === 'residential' &&
    r.speedLimit == null && r.coordinates.length >= 2);
  const tracker = new Tracker({ roads: [], localRoads: [road] });
  const point = sampleAt(road, 10);
  const fix = { ...point, speed: 12, accuracy: 5, timestamp: 1_800_000_000_000 };
  tracker.update(fix);
  const state = tracker.update({ ...fix, timestamp: fix.timestamp + 1000 });
  assert.equal(state.status, 'local');
  assert.equal(state.road.name, road.name);
  assert.equal(state.speedKmh, 43.2);
  assert.equal(state.deltaSeconds, null);
  assert.equal(state.limitKmh, 50);
  assert.equal(state.limitAssumed, true);
  assert.deepEqual(state.exits, []);
});

test('real TPE ramp requires confirmed exit before showing local road without delta', () => {
  const mainline = byId.get('osm-way-62272687');
  const ramp = local.roads.find(road => road.id === 'osm-way-32790032');
  assert.ok(mainline.exits.some(exit => exit.id === ramp.id));
  const tracker = new Tracker({ roads: [mainline], localRoads: [ramp] });
  let timestamp = 1_800_000_000_000;
  const update = (road, fraction, intervalMs = 1000) => tracker.update({ ...sampleAt(road, roadLengthM(road) * fraction),
    accuracy: 5, speed: 15, timestamp: timestamp += intervalMs });
  update(mainline, .3);
  const expressway = update(mainline, .5);
  const uncertain = update(ramp, .2);
  const stillExiting = update(ramp, .6);
  const localState = update(ramp, .9, 5000);
  assert.equal(expressway.status, 'tracking');
  assert.equal(uncertain.status, 'exiting');
  assert.equal(uncertain.deltaSeconds, null);
  assert.equal(stillExiting.status, 'exiting');
  assert.equal(stillExiting.road.id, mainline.id);
  assert.equal(stillExiting.deltaSeconds, null);
  assert.equal(localState.status, 'local');
  assert.equal(localState.road.id, ramp.id);
  assert.equal(localState.speedKmh, 54);
  assert.equal(localState.deltaSeconds, null);
  assert.equal(localState.limitKmh, ramp.speedLimit ?? 50);
  assert.equal(localState.limitAssumed, ramp.speedLimit == null);
  assert.deepEqual(localState.exits, []);
});

test('mainline entry buffers earliest credible fix through six-second confirmation', () => {
  const mainline = byId.get('osm-way-32877553');
  const localRoad = { id: 'parallel-local', name: 'Local road', highway: 'primary',
    coordinates: mainline.coordinates.map(([lon, lat]) => [lon, lat + .0015]) };
  const tracker = new Tracker({ roads: [mainline], localRoads: [localRoad] });
  const base = 1_800_000_000_000;
  const fix = (road, metres, ms) => ({ ...sampleAt(road, metres), accuracy: 5,
    speed: 15, timestamp: base + ms });
  tracker.update(fix(localRoad, 50, 0));
  assert.equal(tracker.update(fix(localRoad, 60, 1000)).status, 'local');
  const first = tracker.update(fix(mainline, 100, 2000));
  const candidate = tracker.update(fix(mainline, 130, 3000));
  assert.equal(first.status, 'entering');
  assert.equal(candidate.status, 'entering');
  assert.equal(candidate.deltaSeconds, null);
  assert.deepEqual(candidate.exits, []);
  const confirmed = tracker.update(fix(mainline, 230, 8000));
  assert.equal(confirmed.status, 'tracking');
  assert.equal(confirmed.entryTime, base + 2000);
  assert.equal(confirmed.entrySource, 'first-mainline-fix');
  assert.equal(confirmed.entryConfidence, 'approximate');
  assert.equal(confirmed.elapsedClockSeconds, 6);
  assert.equal(confirmed.timingBasis, 'since detection');
});

test('tunnel GPS loss keeps road and entry context without fabricated readings', () => {
  const road = { ...byId.get('osm-way-32877553'), tunnel: true };
  const tracker = new Tracker({ roads: [road] });
  const base = 1_800_000_000_000;
  const fix = (metres, ms) => ({ ...sampleAt(road, metres), accuracy: 5,
    speed: 20, timestamp: base + ms });
  tracker.update(fix(50, 0));
  const confirmed = tracker.update(fix(100, 1000));
  assert.equal(confirmed.status, 'tracking');
  const missing = tracker.invalidate('Tunnel GPS unavailable');
  assert.equal(missing.status, 'stale');
  assert.equal(missing.road.id, road.id);
  assert.equal(missing.entryTime, confirmed.entryTime);
  assert.equal(missing.speedKmh, null);
  assert.equal(missing.deltaSeconds, null);
  assert.deepEqual(missing.exits, []);
  const reacquired = tracker.update(fix(130, 5000));
  assert.equal(reacquired.road.id, road.id);
  assert.equal(reacquired.entryTime, confirmed.entryTime);
  assert.equal(reacquired.timingBasis, 'since detection');
  assert.ok(Number.isFinite(reacquired.deltaSeconds));
  assert.ok(reacquired.elapsedSeconds > confirmed.elapsedSeconds);
});

test('long unique directed-chain tunnel gap restores original entry timing', () => {
  const road = (id, start, end, nextRoadIds) => ({ id, ref: 'PIE', name: 'PIE',
    direction: 'Eastbound', tunnel: true, speedLimit: 90, nextRoadIds,
    coordinates: [[start, 1.35], [end, 1.35]] });
  const a = road('tunnel-a', 103.9, 103.93, ['tunnel-b']);
  const b = road('tunnel-b', 103.93, 103.96, []);
  const tracker = new Tracker({ roads: [a, b] });
  const base = 1_800_000_000_000;
  const fix = (segment, distance, ms) => ({ ...sampleAt(segment, distance),
    accuracy: 5, speed: 25, timestamp: base + ms });
  tracker.update(fix(a, 50, 0));
  const before = tracker.update(fix(a, 100, 2000));
  const gap = tracker.invalidate('Tunnel GPS unavailable');
  assert.equal(gap.entryTime, base);
  assert.equal(gap.deltaSeconds, null);
  assert.equal(gap.speedKmh, null);
  const after = tracker.update(fix(b, 2200, 180000));
  assert.equal(after.road.id, b.id);
  assert.equal(after.entryTime, base);
  assert.equal(after.elapsedClockSeconds, 180);
  assert.equal(after.timingBasis, 'since detection');
  assert.ok(after.elapsedSeconds >= 180);
  assert.ok(Number.isFinite(after.deltaSeconds));
  assert.ok(after.elapsedSeconds > before.elapsedSeconds);
});

test('forked tunnel path does not invent full-gap reference timing', () => {
  const road = (id, coordinates, nextRoadIds) => ({ id, ref: 'PIE', name: 'PIE',
    direction: 'Eastbound', tunnel: true, speedLimit: 90, nextRoadIds, coordinates });
  const a = road('fork-a', [[103.9, 1.35], [103.91, 1.35]], ['fork-b', 'fork-c']);
  const b = road('fork-b', [[103.91, 1.35], [103.92, 1.35]], ['fork-d']);
  const c = road('fork-c', [[103.91, 1.35], [103.915, 1.351], [103.92, 1.35]], ['fork-d']);
  const d = road('fork-d', [[103.92, 1.35], [103.93, 1.35]], []);
  const tracker = new Tracker({ roads: [a, b, c, d] });
  const base = 1_800_000_000_000;
  const fix = (segment, metres, ms) => ({ ...sampleAt(segment, metres),
    accuracy: 5, speed: 25, timestamp: base + ms });
  tracker.update(fix(a, 50, 0));
  const before = tracker.update(fix(a, 100, 2000));
  tracker.invalidate('Tunnel GPS unavailable');
  const pending = tracker.update(fix(d, 500, 100000));
  assert.equal(pending.road.id, a.id);
  assert.equal(pending.deltaSeconds, null);
  const after = tracker.update(fix(d, 600, 106000));
  assert.equal(after.road.id, d.id);
  assert.equal(after.entryTime, before.entryTime);
  assert.equal(after.deltaSeconds, null);
  assert.notEqual(after.timingBasis, 'since detection');
});

test('brief ramp candidate does not replace confirmed mainline or accrue time', () => {
  const mainline = byId.get('osm-way-62272687');
  const ramp = local.roads.find(road => road.id === 'osm-way-32790032');
  const tracker = new Tracker({ roads: [mainline], localRoads: [ramp] });
  const base = 1_800_000_000_000;
  const fix = (road, fraction, ms) => ({ ...sampleAt(road, roadLengthM(road) * fraction),
    accuracy: 5, speed: 15, timestamp: base + ms });
  tracker.update(fix(mainline, .3, 0));
  const confirmed = tracker.update(fix(mainline, .5, 1000));
  const candidate = tracker.update(fix(ramp, .2, 2000));
  assert.equal(candidate.status, 'exiting');
  assert.equal(candidate.road.id, mainline.id);
  assert.equal(candidate.candidateRoad.id, ramp.id);
  assert.equal(candidate.deltaSeconds, null);
  assert.deepEqual(candidate.exits, []);
  const returned = tracker.update(fix(mainline, .6, 3000));
  assert.equal(returned.status, 'tracking');
  assert.equal(returned.road.id, mainline.id);
  assert.equal(returned.entryTime, confirmed.entryTime);
  assert.equal(returned.deltaSeconds, null);
  assert.equal(returned.timingBasis, 'since reacquisition');
});

test('one fix interval crossing multiple limit zones uses each zone distance', () => {
  const road = { id: 'multi-limit', ref: 'MCE', name: 'MCE', direction: 'Eastbound',
    coordinates: [[103.9, 1.35], [103.9027, 1.35]], speedLimit: 90, exits: [] };
  const length = roadLengthM(road);
  road.speedLimits = [
    { fromM: 0, toM: length * .3, limitKmh: 90 },
    { fromM: length * .3, toM: length * .6, limitKmh: 70 },
    { fromM: length * .6, toM: length, limitKmh: 80 }
  ];
  const tracker = new Tracker({ roads: [road] });
  const base = 1_800_000_000_000;
  const fix = (fraction, ms) => ({ ...sampleAt(road, length * fraction),
    accuracy: 5, speed: 24, timestamp: base + ms });
  tracker.update(fix(.1, 0));
  const after = tracker.update(fix(.9, 10000));
  const reference = length * (.2 / (90 / 3.6) + .3 / (70 / 3.6) + .3 / (80 / 3.6));
  assert.equal(after.status, 'tracking');
  assert.ok(Math.abs(after.deltaSeconds - (10 - reference)) < .05,
    `expected ${10 - reference}s, got ${after.deltaSeconds}s`);
});

test('bundled MCE to KPE connection keeps entry and delta without switch hold', () => {
  const mce = byId.get('osm-way-253945383');
  const kpe = byId.get('osm-way-633601611');
  assert.equal(mce.ref, 'MCE');
  assert.equal(kpe.ref, 'KPE');
  assert.ok(mce.routeNextRoadIds.some(link => link.roadId === kpe.id));
  const tracker = new Tracker({ roads: [mce, kpe], connectors: bundle.connectors });
  const base = 1_800_000_000_000;
  const fix = (road, metres, ms) => ({ ...sampleAt(road, metres),
    accuracy: 5, speed: 25, timestamp: base + ms });
  tracker.update(fix(mce, 500, 0));
  const before = tracker.update(fix(mce, 700, 8000));
  const after = tracker.update(fix(kpe, 50, 12000));
  assert.equal(before.status, 'tracking');
  assert.equal(after.status, 'tracking');
  assert.equal(after.road.id, kpe.id);
  assert.equal(after.entryTime, before.entryTime);
  assert.ok(after.elapsedSeconds > before.elapsedSeconds);
  assert.ok(Number.isFinite(after.deltaSeconds));
  assert.equal(after.timingBasis, 'since detection');
});

test('bundled MCE to KPE GPS gap reconstructs only its directed connection', () => {
  const mce = byId.get('osm-way-253945383');
  const kpe = byId.get('osm-way-633601611');
  const tracker = new Tracker({ roads: [mce, kpe], connectors: bundle.connectors });
  const base = 1_800_000_000_000;
  const fix = (road, metres, ms) => ({ ...sampleAt(road, metres),
    accuracy: 5, speed: 25, timestamp: base + ms });
  tracker.update(fix(mce, 500, 0));
  const before = tracker.update(fix(mce, 700, 8000));
  const gap = tracker.invalidate('Tunnel GPS unavailable');
  assert.equal(gap.deltaSeconds, null);
  const after = tracker.update(fix(kpe, 150, 180000));
  assert.equal(after.status, 'tracking');
  assert.equal(after.road.id, kpe.id);
  assert.equal(after.entryTime, before.entryTime);
  assert.equal(after.elapsedClockSeconds, 180);
  assert.equal(after.timingBasis, 'since detection');
  assert.ok(Number.isFinite(after.deltaSeconds));
});

test('exit forecast never assumes travel faster than each future limit', () => {
  const road = { id: 'forecast-caps', ref: 'KPE', name: 'KPE',
    coordinates: [[103.9, 1.35], [103.9027, 1.35]], speedLimit: 90,
    exits: [{ id: 'exit-a', name: 'Exit A', offsetM: 250 }],
    speedLimits: [{ fromM: 100, toM: 300, limitKmh: 70 }] };
  const tracker = new Tracker({ roads: [road] });
  const base = 1_800_000_000_000;
  const fix = (metres, ms) => ({ ...sampleAt(road, metres),
    accuracy: 5, speed: 120 / 3.6, timestamp: base + ms });
  tracker.update(fix(10, 0));
  const state = tracker.update(fix(20, 1000));
  assert.equal(state.exits.length, 1);
  assert.ok(Number.isFinite(state.exits[0].projectedDeltaSeconds));
  assert.ok(state.exits[0].projectedDeltaSeconds >= state.deltaSeconds - .05,
    `forecast ${state.exits[0].projectedDeltaSeconds}s undercuts current ${state.deltaSeconds}s`);
});

test('historical assumed reference remains flagged after returning to a known limit', () => {
  const road = { id: 'assumed-history', ref: 'MCE', name: 'MCE',
    coordinates: [[103.9, 1.35], [103.9027, 1.35]], speedLimit: null };
  const length = roadLengthM(road);
  road.speedLimits = [
    { fromM: 0, toM: length * .3, limitKmh: 90 },
    { fromM: length * .3, toM: length * .6, limitKmh: null },
    { fromM: length * .6, toM: length, limitKmh: 80 }
  ];
  const tracker = new Tracker({ roads: [road] });
  const base = 1_800_000_000_000;
  const fix = (fraction, ms) => ({ ...sampleAt(road, length * fraction),
    accuracy: 5, speed: 25, timestamp: base + ms });
  tracker.update(fix(.1, 0));
  const state = tracker.update(fix(.9, 10000));
  assert.equal(state.limitKmh, 80);
  assert.equal(state.limitAssumed, false);
  assert.equal(state.cumulativeReferenceAssumed, true);
  assert.ok(Number.isFinite(state.deltaSeconds));
});

test('GPS accuracy spanning a lower speed limit marks current limit uncertain', () => {
  const road = { id: 'boundary', ref: 'KPE', name: 'KPE',
    coordinates: [[103.9, 1.35], [103.9027, 1.35]], speedLimit: 90 };
  const length = roadLengthM(road);
  road.speedLimits = [{ fromM: length * .5, toM: length, limitKmh: 70 }];
  const tracker = new Tracker({ roads: [road] });
  const base = 1_800_000_000_000;
  tracker.update({ ...sampleAt(road, length * .46), accuracy: 5, speed: 20, timestamp: base });
  const state = tracker.update({ ...sampleAt(road, length * .505), accuracy: 5,
    speed: 20, timestamp: base + 1000 });
  assert.equal(state.limitKmh, 70);
  assert.equal(state.limitUncertain, true);
});

test('provisional CTE first fix survives tunnel GPS loss until unique route confirmation', () => {
  const cte = byId.get('osm-way-16894437');
  const next = byId.get('osm-way-666001761');
  assert.equal(cte.ref, 'CTE');
  assert.equal(cte.tunnel, true);
  assert.ok(cte.routeNextRoadIds.some(edge => edge.roadId === next.id));
  const tracker = new Tracker({ roads: [cte, next], connectors: bundle.connectors });
  const base = 1_800_000_000_000;
  const fix = (road, metres, ms) => ({ ...sampleAt(road, metres),
    accuracy: 5, speed: 20, timestamp: base + ms });
  const first = tracker.update(fix(cte, 100, 0));
  assert.equal(first.provisional, true);
  assert.equal(first.entryTime, base);
  assert.equal(first.deltaSeconds, null);
  const gap = tracker.invalidate('Tunnel GPS unavailable');
  assert.equal(gap.provisional, true);
  assert.equal(gap.entryTime, base);
  assert.equal(gap.speedKmh, null);
  assert.equal(gap.deltaSeconds, null);
  assert.deepEqual(gap.exits, []);
  const returned = tracker.update(fix(cte, 500, 20000));
  assert.equal(returned.entryTime, base);
  const confirmed = tracker.update(fix(cte, 550, 22000));
  assert.equal(confirmed.status, 'tracking');
  assert.equal(confirmed.entryTime, base);
  assert.equal(confirmed.elapsedClockSeconds, 22);
  assert.equal(confirmed.timingBasis, 'since detection');
  assert.ok(Number.isFinite(confirmed.deltaSeconds));
});

test('contradicting local road clears unconfirmed CTE entry evidence', () => {
  const cte = byId.get('osm-way-16894437');
  const localRoad = { id: 'contradicting-local', name: 'Local road', highway: 'primary',
    coordinates: cte.coordinates.map(([lon, lat]) => [lon + .002, lat]) };
  const tracker = new Tracker({ roads: [cte], localRoads: [localRoad] });
  const base = 1_800_000_000_000;
  const fix = (road, metres, ms) => ({ ...sampleAt(road, metres),
    accuracy: 5, speed: 20, timestamp: base + ms });
  assert.equal(tracker.update(fix(cte, 100, 0)).provisional, true);
  tracker.update(fix(localRoad, 150, 1000));
  const localState = tracker.update(fix(localRoad, 180, 2000));
  assert.equal(localState.status, 'local');
  assert.equal(localState.deltaSeconds, null);
  assert.equal(localState.provisional, false);
  assert.equal(localState.entryTime, null);
});

test('no fix, poor accuracy, overlap, and reset cannot fabricate provisional entry', () => {
  const cte = byId.get('osm-way-16894437');
  const base = 1_800_000_000_000;
  const fix = { ...sampleAt(cte, 100), accuracy: 5, speed: 20, timestamp: base };
  const emptyTracker = new Tracker({ roads: [cte] });
  const noFix = emptyTracker.invalidate('Tunnel GPS unavailable');
  assert.equal(noFix.entryTime, null);
  assert.equal(noFix.provisional, false);
  const inaccurate = emptyTracker.update({ ...fix, accuracy: 100 });
  assert.equal(inaccurate.entryTime, null);
  assert.equal(inaccurate.provisional, false);
  const overlap = { id: 'overlap', name: 'Overpass', highway: 'primary',
    coordinates: cte.coordinates };
  const ambiguous = new Tracker({ roads: [cte], localRoads: [overlap] });
  const ambiguousState = ambiguous.update(fix);
  assert.equal(ambiguousState.status, 'identifying');
  assert.equal(ambiguousState.entryTime, null);
  assert.equal(ambiguousState.provisional, false);
  emptyTracker.reset();
  const provisional = emptyTracker.update({ ...fix, timestamp: base + 1000 });
  assert.equal(provisional.provisional, true);
  const reset = emptyTracker.reset();
  assert.equal(reset.entryTime, null);
  assert.equal(reset.provisional, false);
});
