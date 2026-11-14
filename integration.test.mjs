import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Tracker, sampleAt, roadLengthM } from './dist/engine.js';

const bundle = JSON.parse(readFileSync(new URL('./dist/data/roads.json', import.meta.url)));
const local = JSON.parse(readFileSync(new URL('./dist/data/local-roads.json', import.meta.url)));
const layered = { ...bundle, localRoads: local };
const byId = new Map(bundle.roads.map(road => [road.id, road]));
const refs = ['AYE', 'BKE', 'CTE', 'ECP', 'KJE', 'KPE', 'MCE', 'PIE', 'SLE', 'TPE'];

test('bundled ramp graph contains real joining, leaving, and multi-link transfer paths', () => {
  const cases = [
    ['joining', 'osm-way-996698202', 'osm-way-174552486', ['osm-way-22674815', 'osm-way-480919517', 'osm-way-480919516', 'osm-way-121882988']],
    ['leaving', 'osm-way-756847962', 'osm-way-628738331', ['osm-way-139718132']],
    ['transfer', 'osm-way-670121242', 'osm-way-633601611', ['osm-way-32605139', 'osm-way-140562826', 'osm-way-528189241']],
  ];
  const links = new Map(bundle.rampGraph.links.map(link => [link.id, link]));
  for (const [kind, fromRoadId, toRoadId, linkIds] of cases) {
    const path = bundle.rampGraph.paths.find(path => path.kind === kind && path.fromRoadId === fromRoadId && path.toRoadId === toRoadId && linkIds.every((id, i) => path.linkIds[i] === id));
    assert.ok(path, `${kind} ${fromRoadId} -> ${toRoadId}`);
    assert.ok(path.lengthM > 0);
    assert.ok(linkIds.every(id => links.has(id)), `${kind} has a missing link`);
    assert.ok(byId.has(kind === 'joining' ? toRoadId : fromRoadId));
    if (kind === 'transfer') assert.ok(byId.has(toRoadId));
  }
});

test('bundled MCE to ECP transfers retain verified directed connectors beyond four links', () => {
  const links = new Map(bundle.rampGraph.links.map(link => [link.id, link]));
  const paths = bundle.rampGraph.paths.filter(path => path.kind === 'transfer' &&
    path.fromRoadId === 'osm-way-654863071' &&
    ['osm-way-39477474', 'osm-way-635104341'].includes(path.toRoadId));
  assert.deepEqual(paths.map(path => path.linkIds.length).sort((a, b) => a - b), [6, 14]);
  for (const path of paths) {
    assert.equal(byId.get(path.fromRoadId)?.ref, 'MCE');
    assert.equal(byId.get(path.toRoadId)?.ref, 'ECP');
    assert.ok(path.linkIds.every(id => links.has(id)), 'every directed connector is mapped');
    assert.ok(path.lengthM > 1000, 'the transfer is not a fabricated zero-length shortcut');
  }
  const source = byId.get('osm-way-654863071');
  const interior = source.routeNextRoadIds.find(link => link.roadId === 'osm-way-39477474');
  assert.equal(interior.connectorIds.length, 14);
  assert.ok(Math.abs(interior.entryOffsetM - 399.8) < 1,
    'ECP entry begins about 400m into the destination way');
  assert.deepEqual(interior.entryCoordinate,
    paths.find(path => path.toRoadId === 'osm-way-39477474').endCoordinate);
});

test('real Marina approach reconstructs a directed MCE to ECP journey without using the opposite branch', () => {
  const tracker = new Tracker(layered);
  const approach = local.roads.find(road => road.id === 'osm-way-244842555');
  const ecp = byId.get('osm-way-635104341');
  const base = 1_800_000_000_000;
  const fix = (road, distance, elapsed) => ({ ...sampleAt(road, distance),
    accuracy: 5, speed: 25, timestamp: base + elapsed });
  const first = tracker.update(fix(approach, 20, 0));
  assert.equal(first.timingBasis, 'since entrance approach');
  tracker.invalidate('GPS lost before MCE mainline', true);
  const pending = tracker.update(fix(ecp, 60, 130000));
  assert.equal(pending.deltaSeconds, null);
  const recovered = tracker.update(fix(ecp, 100, 132000));
  const route = tracker.recoveryRoute(approach, ecp, 20, 100, 10000);
  assert.equal(route.routeCount, 1);
  assert.deepEqual(route.refs, ['MCE', 'ECP']);
  assert.equal(recovered.reconstructionStatus, 'reconstructed');
  assert.equal(recovered.road.id, ecp.id);
  assert.equal(recovered.entryTime, first.entryTime);
  assert.equal(recovered.sessionId, first.sessionId);
  assert.equal(recovered.expresswayEntryTime, null, 'no mainline boundary was observed');
  assert.ok(Math.abs(recovered.deltaSeconds - (132 - route.reference)) < 0.02);
});

test('Marina Boulevard ramp has mapped directed MCE approach toward KPE', () => {
  const path = bundle.rampGraph.paths.find(path => path.kind === 'joining' &&
    path.fromRoadId === 'osm-way-649773813' && path.toRoadId === 'osm-way-265150827');
  assert.ok(path);
  assert.deepEqual(path.linkIds, [
    'osm-way-244842555', 'osm-way-265150888', 'osm-way-244842552',
  ]);
  assert.ok(path.lengthM > 600 && path.lengthM < 700);
  assert.equal(byId.get(path.toRoadId).ref, 'MCE');
  assert.ok(local.roads.some(road => road.id === path.linkIds[0]));
  assert.ok(byId.has('osm-way-633601611'));
});

test('shared ECP to KPE ramp identifies transfer but withholds ambiguous physical boundary', () => {
  const path = bundle.rampGraph.paths.find(path => path.kind === 'transfer' &&
    path.fromRoadId === 'osm-way-670121242' && path.toRoadId === 'osm-way-633601611');
  assert.ok(path);
  const alternate = { ...path, linkIds: [path.linkIds[0], 'alternate-tail'],
    startCoordinate: [path.startCoordinate[0] + .0001, path.startCoordinate[1]] };
  const graph = { ...bundle.rampGraph,
    links: [...bundle.rampGraph.links, { ...bundle.rampGraph.links.find(link => link.id === path.linkIds.at(-1)), id: 'alternate-tail' }],
    paths: [path, alternate] };
  const tracker = new Tracker({ roads: [byId.get(path.fromRoadId), byId.get(path.toRoadId)],
    localRoads: local.roads.filter(road => path.linkIds.includes(road.id)), rampGraph: graph });
  const transition = tracker.classifyRamp(local.roads.find(road => road.id === path.linkIds[0]), byId.get(path.fromRoadId));
  assert.equal(transition.classification, 'transfer');
  assert.equal(transition.originRef, 'ECP');
  assert.equal(transition.destinationRef, 'KPE');
  assert.equal(transition.pathCount, 1);
  assert.equal(transition.exactPathCount, 2);
  assert.equal(transition.boundary, null);
});

test('real PIE exit keeps leaving role while two destinations share the same ramp prefix', () => {
  const tracker = new Tracker(layered);
  const base = 1_800_000_000_000;
  const at = (id, fraction, ms) => {
    const road = byId.get(id) || local.roads.find(road => road.id === id);
    return tracker.update({ ...sampleAt(road, roadLengthM(road) * fraction),
      accuracy: 5, speed: 15, timestamp: base + ms });
  };
  at('osm-way-738989173', .2, 0);
  const live = at('osm-way-738989173', .8, 1000);
  const first = at('osm-way-655169346', .2, 2000);
  assert.equal(first.rampTransition.classification, 'leaving');
  assert.equal(first.rampTransition.confidence, 'provisional');
  assert.equal(first.rampTransition.originRef, 'PIE');
  assert.equal(first.rampTransition.destinationRef, null);
  assert.equal(first.rampTransition.toRoadId, null);
  assert.equal(first.rampTransition.exactPathCount, 2);
  assert.deepEqual(first.rampTransition.linkIds, [
    'osm-way-655169346', 'osm-way-123220700', 'osm-way-794544011',
  ]);
  const switched = at('osm-way-655169346', .7, 4000);
  assert.equal(switched.rampTransition.classification, 'leaving');
  assert.equal(switched.rampTransition.confidence, 'confirmed');
  assert.equal(switched.rampTransition.destinationRef, null);
  assert.equal(switched.visualRoad.id, 'osm-way-655169346');
  assert.equal(switched.previousDelta.value, live.deltaSeconds);
  at('osm-way-123220700', .5, 6000);
  const shared = at('osm-way-794544011', .5, 8000);
  assert.equal(shared.rampTransition.toRoadId, null);
  const branch = at('osm-way-655169345', .5, 10000);
  assert.equal(branch.rampTransition.classification, 'leaving');
  assert.equal(branch.rampTransition.toRoadId, 'osm-way-1057560070');
  assert.equal(branch.rampTransition.exactPathCount, 1);
});

test('confirmed TPE mainline remains visual road beside a six-metre parallel exit ramp', () => {
  const mainline = byId.get('osm-way-756847962');
  const tracker = new Tracker(layered);
  const base = 1_800_000_000_000;
  const at = (fraction, ms) => tracker.update({
    ...sampleAt(mainline, roadLengthM(mainline) * fraction),
    accuracy: 5, speed: 15, timestamp: base + ms,
  });
  at(.2, 0);
  const live = at(.7, 2000);
  assert.equal(live.status, 'tracking');
  const besideRamp = at(.9, 4000);
  const candidate = tracker.diagnosticSnapshot().candidates.find(c => c.id === 'osm-way-139718132');
  assert.ok(candidate?.distanceM < 10);
  assert.equal(besideRamp.visualRoad.id, mainline.id);
  assert.equal(besideRamp.status, 'tracking');
  assert.equal(besideRamp.previousDelta, null);
  assert.equal(besideRamp.sessionId, live.sessionId);
});

test('pre-mainline Marina Boulevard ramp anchor survives long GPS gap into downstream KPE', () => {
  const ramp = local.roads.find(road => road.id === 'osm-way-244842555');
  const kpe = byId.get('osm-way-633601611');
  const tracker = new Tracker(layered);
  const base = 1_800_000_000_000;
  const at = (road, distance, ms) => tracker.update({ ...sampleAt(road, distance),
    accuracy: 5, speed: 22, timestamp: base + ms });
  const approach = at(ramp, roadLengthM(ramp) / 2, 0);
  assert.equal(approach.approachTime, base);
  assert.equal(approach.mainlineEntryTime, null);
  assert.equal(approach.deltaSeconds, null);
  tracker.invalidate('Tunnel GPS unavailable');
  const first = at(kpe, 80, 180000);
  assert.equal(first.approachTime, base);
  assert.equal(first.deltaSeconds, null);
  const recovered = at(kpe, 120, 182000);
  assert.equal(recovered.status, 'tracking');
  assert.equal(recovered.entryTime, base);
  assert.equal(recovered.approachTime, base);
  assert.equal(recovered.mainlineEntryTime, null);
  assert.equal(recovered.timingBasis, 'since entrance approach');
  assert.equal(recovered.reconstructionStatus, 'reconstructed');
  assert.ok(Number.isFinite(recovered.deltaSeconds));
});

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

test('unproven TPE ramp does not force a completed expressway exit', () => {
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
  assert.equal(localState.status, 'exiting');
  assert.equal(localState.road.id, mainline.id);
  assert.equal(localState.rampTransition, null);
  assert.equal(localState.deltaSeconds, null);
  assert.equal(localState.completedSession, null);
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
  assert.equal(confirmed.timingBasis, 'since mainline entry');
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
  const firstReturn = tracker.update(fix(130, 5000));
  assert.equal(firstReturn.deltaSeconds, null);
  const reacquired = tracker.update(fix(150, 6000));
  assert.equal(reacquired.road.id, road.id);
  assert.equal(reacquired.entryTime, confirmed.entryTime);
  assert.equal(reacquired.timingBasis, 'since mainline entry');
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
  const firstReturn = tracker.update(fix(b, 2200, 180000));
  assert.equal(firstReturn.deltaSeconds, null);
  const after = tracker.update(fix(b, 2225, 181000));
  assert.equal(after.road.id, b.id);
  assert.equal(after.entryTime, base);
  assert.equal(after.elapsedClockSeconds, 181);
  assert.equal(after.timingBasis, 'since mainline entry');
  assert.ok(after.elapsedSeconds >= 181);
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
  tracker.update(fix(d, 600, 106000));
  const after = tracker.update(fix(d, 625, 107000));
  assert.equal(after.road.id, a.id);
  assert.equal(after.entryTime, before.entryTime);
  assert.equal(after.deltaSeconds, null);
  assert.equal(after.deltaStatus, 'unresolved');
});

test('ambiguous tunnel recovery retires once after ten reliable mainline seconds, excluding weak and missing GPS', () => {
  const road = (id, coordinates, nextRoadIds) => ({ id, ref: 'PIE', name: 'PIE',
    direction: 'Eastbound', tunnel: true, speedLimit: 90, nextRoadIds, coordinates });
  const a = road('budget-a', [[103.9, 1.35], [103.91, 1.35]], ['budget-b', 'budget-c']);
  const b = road('budget-b', [[103.91, 1.35], [103.92, 1.35]], ['budget-d']);
  const c = road('budget-c', [[103.91, 1.35], [103.915, 1.351], [103.92, 1.35]], ['budget-d']);
  const d = road('budget-d', [[103.92, 1.35], [103.93, 1.35]], []);
  const tracker = new Tracker({ roads: [a, b, c, d] });
  const base = 1_800_000_000_000;
  const fix = (segment, distance, ms, accuracy = 5) => ({ ...sampleAt(segment, distance),
    accuracy, speed: 20, timestamp: base + ms });
  tracker.update(fix(a, 50, 0));
  const original = tracker.update(fix(a, 100, 2000));
  tracker.invalidate('Tunnel GPS unavailable');
  tracker.update(fix(d, 500, 100000));
  const twoSeconds = tracker.update(fix(d, 550, 102000));
  assert.equal(twoSeconds.entryTime, original.entryTime);
  assert.equal(twoSeconds.deltaSeconds, null);
  tracker.update(fix(d, 575, 104000, 90));
  tracker.invalidate('Second weak GPS interval');
  const resumed = tracker.update(fix(d, 600, 108000));
  assert.equal(resumed.entryTime, original.entryTime);
  const sixSeconds = tracker.update(fix(d, 650, 112000));
  assert.equal(sixSeconds.entryTime, original.entryTime);
  assert.equal(sixSeconds.deltaSeconds, null);
  const retired = tracker.update(fix(d, 700, 116000));
  assert.equal(retired.completedSession?.sessionId, original.sessionId);
  assert.equal(retired.completedSession?.finalDeltaSeconds, null);
  assert.equal(retired.incompleteHistory?.length, 1);
  assert.equal(retired.incompleteHistory[0].sessionId, original.sessionId);
  assert.equal(retired.timingBasis, 'since GPS recovery');
  assert.equal(retired.entryTime, base + 108000, 'fallback uses the first fix of the final continuous recovery segment');
  assert.notEqual(retired.sessionId, original.sessionId);
  assert.equal(retired.road.id, d.id, 'current road must leave the frozen pre-gap road');
  assert.equal(retired.visualRoad.id, d.id);
  assert.equal(retired.gpsStatus, 'fresh');
  assert.equal(retired.roadMatchStatus, 'identified');
  assert.ok(retired.speedKmh > 0);
  const subsequent = tracker.update(fix(d, 750, 118000));
  assert.equal(subsequent.incompleteHistory.length, 1, 'fallback archives the old session once');
  assert.equal(subsequent.entryTime, base + 108000);
  assert.ok(Number.isFinite(subsequent.deltaSeconds), 'new pace starts from observed recovery segment');
});

test('materially equivalent tunnel forks can reconstruct without inventing a chosen physical branch', () => {
  const road = (id, coordinates, nextRoadIds) => ({ id, ref: 'PIE', name: 'PIE',
    direction: 'Eastbound', tunnel: true, speedLimit: 90, nextRoadIds, coordinates });
  const a = road('equal-a', [[103.9, 1.35], [103.91, 1.35]], ['equal-b', 'equal-c']);
  const b = road('equal-b', [[103.91, 1.35], [103.92, 1.35]], ['equal-d']);
  const c = road('equal-c', [[103.91, 1.35], [103.92, 1.35]], ['equal-d']);
  const d = road('equal-d', [[103.92, 1.35], [103.93, 1.35]], []);
  const tracker = new Tracker({ roads: [a, b, c, d] });
  const base = 1_800_000_000_000;
  const fix = (segment, distance, ms) => ({ ...sampleAt(segment, distance),
    accuracy: 5, speed: 20, timestamp: base + ms });
  tracker.update(fix(a, 50, 0));
  const original = tracker.update(fix(a, 100, 2000));
  tracker.invalidate('Tunnel GPS unavailable');
  const first = tracker.update(fix(d, 500, 100000));
  assert.equal(first.deltaSeconds, null);
  const recovered = tracker.update(fix(d, 550, 102000));
  assert.equal(recovered.status, 'tracking');
  assert.equal(recovered.entryTime, original.entryTime);
  assert.equal(recovered.reconstructionStatus, 'reconstructed');
  assert.ok(Number.isFinite(recovered.deltaSeconds));
  assert.equal(recovered.completedSession, null);
});

test('accurate stationary fixes on a confirmed downstream mainline advance ambiguous recovery budget', () => {
  const road = (id, coordinates, nextRoadIds) => ({ id, ref: 'PIE', name: 'PIE',
    direction: 'Eastbound', tunnel: true, speedLimit: 90, nextRoadIds, coordinates });
  const a = road('stopped-a', [[103.9, 1.35], [103.91, 1.35]], ['stopped-b', 'stopped-c']);
  const b = road('stopped-b', [[103.91, 1.35], [103.92, 1.35]], ['stopped-d']);
  const c = road('stopped-c', [[103.91, 1.35], [103.915, 1.351], [103.92, 1.35]], ['stopped-d']);
  const d = road('stopped-d', [[103.92, 1.35], [103.93, 1.35]], []);
  const tracker = new Tracker({ roads: [a, b, c, d] });
  const base = 1_800_000_000_000;
  const fix = (segment, distance, ms, stopped = false) => ({ ...sampleAt(segment, distance),
    accuracy: 5, speed: stopped ? 0 : 20, heading: stopped ? null : sampleAt(segment, distance).heading,
    timestamp: base + ms });
  tracker.update(fix(a, 50, 0));
  const original = tracker.update(fix(a, 100, 2000));
  tracker.invalidate('Tunnel GPS unavailable');
  tracker.update(fix(d, 500, 100000));
  tracker.update(fix(d, 550, 102000));
  const pause = tracker.update(fix(d, 550, 106000, true));
  assert.equal(pause.entryTime, original.entryTime);
  const fallback = tracker.update(fix(d, 550, 110000, true));
  assert.equal(fallback.timingBasis, 'since GPS recovery');
  assert.equal(fallback.completedSession.finalDeltaSeconds, null);
  assert.equal(fallback.incompleteHistory.length, 1);
});

test('weak early-return fix breaks recovery interval without crediting unseen time', () => {
  const road = (id, coordinates, nextRoadIds) => ({ id, ref: 'PIE', name: 'PIE',
    direction: 'Eastbound', tunnel: true, speedLimit: 90, nextRoadIds, coordinates });
  const a = road('weak-a', [[103.9, 1.35], [103.91, 1.35]], ['weak-b', 'weak-c']);
  const b = road('weak-b', [[103.91, 1.35], [103.92, 1.35]], ['weak-d']);
  const c = road('weak-c', [[103.91, 1.35], [103.915, 1.351], [103.92, 1.35]], ['weak-d']);
  const d = road('weak-d', [[103.92, 1.35], [103.93, 1.35]], []);
  const tracker = new Tracker({ roads: [a, b, c, d] });
  const base = 1_800_000_000_000;
  const fix = (segment, distance, ms, accuracy = 5) => ({ ...sampleAt(segment, distance),
    accuracy, speed: 20, timestamp: base + ms });
  tracker.update(fix(a, 50, 0));
  const original = tracker.update(fix(a, 100, 2000));
  tracker.invalidate('Tunnel GPS unavailable');
  tracker.update(fix(d, 500, 100000));
  tracker.update(fix(d, 550, 102000));
  tracker.update(fix(d, 575, 104000, 200));
  const resumed = tracker.update(fix(d, 600, 112000));
  assert.equal(resumed.entryTime, original.entryTime);
  assert.equal(resumed.incompleteHistory.length, 0);
  const later = tracker.update(fix(d, 650, 118000));
  assert.equal(later.incompleteHistory.length, 0, 'unreliable interval must not count toward ten seconds');
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
  const pendingReturn = tracker.update(fix(mainline, .6, 3000));
  assert.equal(pendingReturn.deltaSeconds, null);
  assert.equal(pendingReturn.gapStart, candidate.gapStart);
  assert.equal(pendingReturn.entryTime, confirmed.entryTime);
  assert.equal(pendingReturn.sessionId, confirmed.sessionId);
  const returned = tracker.update(fix(mainline, .65, 4000));
  assert.equal(returned.status, 'tracking');
  assert.equal(returned.road.id, mainline.id);
  assert.equal(returned.entryTime, confirmed.entryTime);
  assert.equal(returned.deltaStatus, 'live');
  assert.equal(returned.timingBasis, 'since mainline entry');
  assert.ok(Math.abs(returned.deltaSeconds -
    (4 - (roadLengthM(mainline) * .35) / (90 / 3.6))) < .1);
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
  assert.equal(after.timingBasis, 'since mainline entry');
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
  const firstReturn = tracker.update(fix(kpe, 150, 180000));
  assert.equal(firstReturn.deltaSeconds, null);
  const after = tracker.update(fix(kpe, 175, 181000));
  assert.equal(after.status, 'tracking');
  assert.equal(after.road.id, kpe.id);
  assert.equal(after.entryTime, before.entryTime);
  assert.equal(after.elapsedClockSeconds, 181);
  assert.equal(after.timingBasis, 'since mainline entry');
  assert.ok(Number.isFinite(after.deltaSeconds));
});

test('exit forecast projects current speed against piecewise future speed-limit reference', () => {
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
  const expectedReference = 80 / (90 / 3.6) + 150 / (70 / 3.6);
  const expectedProjection = state.deltaSeconds + 230 / (120 / 3.6) - expectedReference;
  assert.ok(Math.abs(state.exits[0].projectedDeltaSeconds - expectedProjection) < .05,
    `forecast ${state.exits[0].projectedDeltaSeconds}s, expected ${expectedProjection}s`);
  const stopped = tracker.update({ ...sampleAt(road, 20), accuracy: 5, speed: 0,
    timestamp: base + 2000 });
  assert.equal(stopped.exits[0].projectedDeltaSeconds, null);
  const stale = tracker.invalidate('GPS signal lost');
  assert.deepEqual(stale.exits, []);
});

test('optional private PIE replay reproduces the three current-speed exit projections',
  { skip: !process.env.DELTA_PRIVATE_TRACE }, async () => {
    const { parseExport } = await import('./scripts/replay-diagnostics.mjs');
    const trace = parseExport(readFileSync(process.env.DELTA_PRIVATE_TRACE));
    const tracker = new Tracker(layered);
    let target = null;
    for (const event of trace.events) {
      if (event.type === 'fix') {
        const state = tracker.update(event.fix);
        if (event.recordedAt?.startsWith('2026-11-09T06:19:24.')) target = state;
      } else if (event.type === 'error') tracker.invalidate(event.reason || 'GPS unavailable');
    }
    assert.ok(target);
    assert.equal(target.road.ref, 'PIE');
    assert.equal(target.exits.length, 3);
    for (const [exit, distance, projection] of target.exits.map((exit, index) =>
      [exit, [222, 1533, 3144][index], [-3.059, -3.968, -5.085][index]])) {
      assert.ok(Math.abs(exit.distanceM - distance) < 1);
      assert.ok(Math.abs(exit.projectedDeltaSeconds - projection) < .005);
    }
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
  assert.equal(confirmed.timingBasis, 'since mainline entry');
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

test('provisional CTE gap across a fork cannot invent full-session pace', () => {
  const road = (id, coordinates, nextRoadIds) => ({ id, ref: 'CTE', name: 'CTE',
    direction: 'Eastbound', tunnel: true, speedLimit: 90, nextRoadIds, coordinates });
  const a = road('provisional-a', [[103.9, 1.35], [103.91, 1.35]], ['provisional-b', 'provisional-c']);
  const b = road('provisional-b', [[103.91, 1.35], [103.92, 1.35]], ['provisional-d']);
  const c = road('provisional-c', [[103.91, 1.35], [103.915, 1.351], [103.92, 1.35]], ['provisional-d']);
  const d = road('provisional-d', [[103.92, 1.35], [103.93, 1.35]], []);
  const tracker = new Tracker({ roads: [a, b, c, d] });
  const base = 1_800_000_000_000;
  const fix = (segment, metres, ms) => ({ ...sampleAt(segment, metres),
    accuracy: 5, speed: 25, timestamp: base + ms });
  assert.equal(tracker.update(fix(a, 50, 0)).provisional, true);
  const gap = tracker.invalidate('Tunnel GPS unavailable');
  assert.equal(gap.entryTime, base);
  const returned = tracker.update(fix(d, 500, 100000));
  assert.equal(returned.deltaSeconds, null);
  assert.notEqual(returned.reconstructionStatus, 'reconstructed');
});

test('CTE outage holds one delta then reconstructs exact full-session pace after two fixes', () => {
  const cte = byId.get('osm-way-16894437');
  const tracker = new Tracker({ roads: [cte] });
  const base = 1_800_000_000_000;
  const fix = (metres, ms) => ({ ...sampleAt(cte, metres), accuracy: 5,
    speed: 20, timestamp: base + ms });
  tracker.update(fix(100, 0));
  const before = tracker.update(fix(150, 2000));
  assert.equal(before.deltaStatus, 'live');
  assert.ok(Math.abs(before.deltaSeconds - (2 - 50 / (50 / 3.6))) < .05);
  const held = tracker.invalidate('Tunnel GPS unavailable');
  assert.equal(held.deltaStatus, 'held');
  assert.equal(held.deltaSeconds, null);
  assert.equal(held.lastValidDeltaSeconds, before.deltaSeconds);
  assert.equal(held.entryTime, base);
  assert.equal(held.speedKmh, null);
  assert.deepEqual(held.exits, []);
  const first = tracker.update(fix(500, 22000));
  assert.equal(first.deltaStatus, 'recovering');
  assert.equal(first.deltaSeconds, null);
  const recovered = tracker.update(fix(550, 23000));
  assert.equal(recovered.deltaStatus, 'live');
  assert.equal(recovered.entryTime, base);
  assert.equal(recovered.elapsedSeconds, 23);
  assert.ok(Math.abs(recovered.deltaSeconds - (23 - 450 / (50 / 3.6))) < .05);
});

test('duplicate fixes and repeated outage errors cannot count elapsed time twice', () => {
  const cte = byId.get('osm-way-16894437');
  const tracker = new Tracker({ roads: [cte] });
  const base = 1_800_000_000_000;
  const fix = (metres, ms) => ({ ...sampleAt(cte, metres), accuracy: 5,
    speed: 20, timestamp: base + ms });
  tracker.update(fix(100, 0));
  const before = tracker.update(fix(150, 2000));
  const duplicate = tracker.update(fix(150, 2000));
  const older = tracker.update(fix(140, 1000));
  assert.equal(duplicate.deltaSeconds, before.deltaSeconds);
  assert.equal(older.deltaSeconds, before.deltaSeconds);
  assert.equal(older.entryTime, base);
  const firstGap = tracker.invalidate('Tunnel GPS unavailable');
  const secondGap = tracker.invalidate('Tunnel GPS unavailable');
  assert.equal(secondGap.gapStart, firstGap.gapStart);
  assert.equal(secondGap.lastValidDeltaSeconds, before.deltaSeconds);
  assert.equal(secondGap.entryTime, base);
  const bad = tracker.update({ ...fix(160, 4000), accuracy: 200 });
  assert.equal(bad.gapStart, firstGap.gapStart);
  assert.equal(bad.lastValidDeltaSeconds, before.deltaSeconds);
  tracker.update(fix(500, 22000));
  const recovered = tracker.update(fix(550, 23000));
  assert.ok(Math.abs(recovered.deltaSeconds - (23 - 450 / (50 / 3.6))) < .05);
});

test('two CTE outages reconstruct once each from the original entry anchor', () => {
  const cte = byId.get('osm-way-16894437');
  const tracker = new Tracker({ roads: [cte] });
  const base = 1_800_000_000_000;
  const fix = (metres, ms) => ({ ...sampleAt(cte, metres), accuracy: 5,
    speed: 20, timestamp: base + ms });
  tracker.update(fix(100, 0));
  tracker.update(fix(150, 2000));
  tracker.invalidate('First tunnel loss');
  tracker.update(fix(500, 22000));
  const first = tracker.update(fix(550, 23000));
  assert.equal(first.deltaStatus, 'live');
  tracker.invalidate('Second tunnel loss');
  tracker.invalidate('Second tunnel loss repeated');
  tracker.update(fix(800, 42000));
  const second = tracker.update(fix(850, 43000));
  assert.equal(second.deltaStatus, 'live');
  assert.equal(second.entryTime, base);
  assert.equal(second.elapsedSeconds, 43);
  assert.ok(Math.abs(second.deltaSeconds - (43 - 750 / (50 / 3.6))) < .05);
});

test('unproven ramp candidate preserves session despite six-second hold', () => {
  const mainline = byId.get('osm-way-62272687');
  const ramp = local.roads.find(road => road.id === 'osm-way-32790032');
  const tracker = new Tracker({ roads: [mainline], localRoads: [ramp] });
  const base = 1_800_000_000_000;
  const fix = (road, fraction, ms) => ({ ...sampleAt(road, roadLengthM(road) * fraction),
    accuracy: 5, speed: 15, timestamp: base + ms });
  tracker.update(fix(mainline, .3, 0));
  const live = tracker.update(fix(mainline, .5, 1000));
  const candidate = tracker.update(fix(ramp, .2, 2000));
  assert.equal(candidate.deltaStatus, 'recovering');
  assert.equal(candidate.completedSession, null);
  const completed = tracker.update(fix(ramp, .9, 8000));
  assert.equal(completed.status, 'exiting');
  assert.equal(completed.deltaSeconds, null);
  assert.equal(completed.entryTime, live.entryTime);
  assert.equal(completed.completedSession, null);
  assert.equal(completed.rampTransition, null);
});

test('two-second visual switch needs twenty seconds of reliable local-road evidence to clear journey', () => {
  const mainline = byId.get('osm-way-62272687');
  const street = { ...local.roads.find(road => road.id === 'osm-way-32790032'),
    id: 'street-a', name: 'Street A', highway: 'residential' };
  const tracker = new Tracker({ roads: [mainline], localRoads: [street] });
  const base = 1_800_000_000_000;
  const at = (road, fraction, ms) => tracker.update({ ...sampleAt(road, roadLengthM(road) * fraction),
    accuracy: 5, speed: 15, timestamp: base + ms });
  at(mainline, .3, 0);
  const live = at(mainline, .5, 1000);
  const first = at(street, .2, 2000);
  assert.equal(first.visualRoad.id, mainline.id);
  const switched = at(street, .5, 4000);
  assert.equal(switched.visualRoad.id, street.id);
  assert.equal(switched.visualSpeedKmh, 54);
  assert.equal(switched.previousDelta.value, live.deltaSeconds);
  assert.equal(tracker.localEvidenceMs, 0);
  assert.equal(tracker.tick(base + 60000).sessionId, live.sessionId,
    'wall-clock time alone cannot clear a recoverable journey');
  at(street, .6, 8000);
  at(street, .7, 18000);
  assert.equal(tracker.localEvidenceMs, 14000);
  const complete = at(street, .9, 28000);
  assert.equal(complete.status, 'local');
  assert.equal(complete.completedSession.status, 'completed-local-evidence');
  assert.equal(complete.completedSession.sessionId, live.sessionId);
  assert.equal(complete.completedSession.exitTime, null);
  assert.equal(complete.completedSession.finalDeltaSeconds, null);
  assert.equal(complete.entryTime, null);
  assert.equal(complete.approachTime, null);
  assert.equal(complete.mainlineEntryTime, null);
  assert.equal(complete.sessionId, null);
  assert.equal(complete.previousDelta, null);
});

test('GPS outage before visual switch restarts the two-fix road confirmation', () => {
  const mainline = byId.get('osm-way-62272687');
  const street = { ...local.roads.find(road => road.id === 'osm-way-32790032'),
    id: 'street-a', name: 'Street A', highway: 'residential' };
  const tracker = new Tracker({ roads: [mainline], localRoads: [street] });
  const base = 1_800_000_000_000;
  const at = (road, fraction, ms) => tracker.update({ ...sampleAt(road, roadLengthM(road) * fraction),
    accuracy: 5, speed: 15, timestamp: base + ms });
  at(mainline, .3, 0);
  at(mainline, .5, 1000);
  at(street, .2, 2000);
  tracker.invalidate('GPS unavailable');
  const afterGap = at(street, .5, 10000);
  assert.equal(afterGap.visualRoad.id, mainline.id);
  assert.equal(afterGap.previousDelta, null);
  const switched = at(street, .7, 12000);
  assert.equal(switched.visualRoad.id, street.id);
  assert.equal(tracker.localEvidenceMs, 0);
});

test('GPS gap after local switch pauses reliable-road evidence and cannot count missing time', () => {
  const mainline = byId.get('osm-way-62272687');
  const street = { ...local.roads.find(road => road.id === 'osm-way-32790032'),
    id: 'street-a', name: 'Street A', highway: 'residential' };
  const tracker = new Tracker({ roads: [mainline], localRoads: [street] });
  const base = 1_800_000_000_000;
  const at = (road, fraction, ms) => tracker.update({ ...sampleAt(road, roadLengthM(road) * fraction),
    accuracy: 5, speed: 15, timestamp: base + ms });
  at(mainline, .3, 0);
  const live = at(mainline, .5, 1000);
  at(street, .2, 2000);
  at(street, .5, 4000);
  at(street, .6, 8000);
  assert.equal(tracker.localEvidenceMs, 4000);
  tracker.invalidate('GPS unavailable');
  const resumed = at(street, .7, 40000);
  assert.equal(resumed.sessionId, live.sessionId);
  assert.equal(resumed.previousDelta.value, live.deltaSeconds);
  assert.equal(tracker.localEvidenceMs, 4000);
  const later = at(street, .8, 50000);
  assert.equal(later.completedSession, null);
  assert.equal(tracker.localEvidenceMs, 14000);
  const complete = at(street, .9, 56000);
  assert.equal(complete.completedSession.status, 'completed-local-evidence');
});

test('endpoint-connected named streets contribute to one reliable local departure window', () => {
  const mainline = byId.get('osm-way-62272687');
  const streetA = { ...local.roads.find(road => road.id === 'osm-way-32790032'),
    id: 'street-a', name: 'Street A', highway: 'residential' };
  const end = streetA.coordinates.at(-1), prior = streetA.coordinates.at(-2);
  const streetB = { ...streetA, id: 'street-b', name: 'Street B',
    coordinates: [end, [end[0] + end[0] - prior[0], end[1] + end[1] - prior[1]]] };
  const tracker = new Tracker({ roads: [mainline], localRoads: [streetA, streetB] });
  const base = 1_800_000_000_000;
  const at = (road, fraction, ms) => tracker.update({ ...sampleAt(road, roadLengthM(road) * fraction),
    accuracy: 5, speed: 15, timestamp: base + ms });
  at(mainline, .3, 0);
  at(mainline, .5, 1000);
  at(streetA, .2, 2000);
  at(streetA, .5, 4000);
  at(streetA, .6, 8000);
  assert.equal(tracker.localEvidenceMs, 4000);
  at(streetB, .2, 10000);
  const onSecondStreet = at(streetB, .8, 18000);
  assert.equal(onSecondStreet.visualRoad.id, streetB.id);
  assert.equal(tracker.localEvidenceMs, 14000);
  const complete = at(streetB, .9, 24000);
  assert.equal(complete.completedSession.status, 'completed-local-evidence');
});

test('weak local GPS fix pauses departure evidence without crediting the uncertain interval', () => {
  const mainline = byId.get('osm-way-62272687');
  const street = { ...local.roads.find(road => road.id === 'osm-way-32790032'),
    id: 'street-a', name: 'Street A', highway: 'residential' };
  const tracker = new Tracker({ roads: [mainline], localRoads: [street] });
  const base = 1_800_000_000_000;
  const at = (road, fraction, ms, accuracy = 5) => tracker.update({
    ...sampleAt(road, roadLengthM(road) * fraction), accuracy, speed: 15, timestamp: base + ms });
  at(mainline, .3, 0);
  at(mainline, .5, 1000);
  at(street, .2, 2000);
  at(street, .5, 4000);
  at(street, .6, 8000);
  assert.equal(tracker.localEvidenceMs, 4000);
  at(street, .7, 10000, 70);
  const resumed = at(street, .8, 20000);
  assert.equal(resumed.completedSession, null);
  assert.equal(tracker.localEvidenceMs, 4000);
  at(street, .9, 30000);
  assert.equal(tracker.localEvidenceMs, 14000);
});

test('stale transfer context cannot block twenty-second reliable local departure cleanup', () => {
  const lastLink = local.roads.find(road => road.id === 'osm-way-528189241');
  const end = lastLink.coordinates.at(-1), prior = lastLink.coordinates.at(-2);
  const street = { ...lastLink, id: 'street-after-transfer', name: 'Street After Transfer',
    highway: 'residential', coordinates: [end,
      [end[0] + 3 * (end[0] - prior[0]), end[1] + 3 * (end[1] - prior[1])]] };
  const tracker = new Tracker({ ...layered, localRoads: [...local.roads, street] });
  const base = 1_800_000_000_000;
  const at = (id, fraction, ms) => {
    const road = id === street.id ? street : byId.get(id) || local.roads.find(road => road.id === id);
    return tracker.update({ ...sampleAt(road, roadLengthM(road) * fraction),
      accuracy: 5, speed: 15, timestamp: base + ms });
  };
  at('osm-way-670121242', .2, 0);
  const live = at('osm-way-670121242', .7, 1000);
  at('osm-way-32605139', .2, 2000);
  at('osm-way-140562826', .2, 4000);
  const transfer = at(lastLink.id, .2, 6000);
  assert.equal(transfer.rampTransition.classification, 'transfer');
  at(street.id, .2, 8000);
  at(street.id, .6, 10000);
  at(street.id, .7, 20000);
  const complete = at(street.id, .9, 30000);
  assert.equal(complete.status, 'local');
  assert.equal(complete.completedSession.status, 'completed-local-evidence');
  assert.equal(complete.completedSession.sessionId, live.sessionId);
  assert.equal(complete.entryTime, null);
  assert.equal(complete.previousDelta, null);
});

test('compatible mainline return before confirmed local departure restores original entry', () => {
  const mainline = byId.get('osm-way-62272687');
  const ramp = local.roads.find(road => road.id === 'osm-way-32790032');
  const tracker = new Tracker({ roads: [mainline], localRoads: [ramp] });
  const base = 1_800_000_000_000;
  const at = (road, fraction, ms) => tracker.update({ ...sampleAt(road, roadLengthM(road) * fraction),
    accuracy: 5, speed: 15, timestamp: base + ms });
  at(mainline, .3, 0);
  const live = at(mainline, .5, 1000);
  at(ramp, .2, 2000);
  const switched = at(ramp, .6, 4000);
  assert.equal(switched.visualRoad.id, ramp.id);
  assert.equal(switched.previousDelta.sessionId, live.sessionId);
  at(ramp, .9, 6000);
  const returnCandidate = at(mainline, .55, 20000);
  assert.equal(returnCandidate.entryTime, live.entryTime);
  const recovered = at(mainline, .8, 22000);
  assert.equal(recovered.status, 'tracking');
  assert.equal(recovered.deltaStatus, 'live');
  assert.equal(recovered.entryTime, live.entryTime);
  assert.equal(recovered.sessionId, live.sessionId);
  assert.equal(recovered.visualRoad.id, mainline.id);
  assert.equal(recovered.previousDelta, null);
  assert.equal(recovered.completedSession, null);
});

test('GPS-only outage does not start the visual-switch expiry window', () => {
  const mainline = byId.get('osm-way-62272687');
  const tracker = new Tracker({ roads: [mainline] });
  const base = 1_800_000_000_000;
  const at = (fraction, ms) => tracker.update({
    ...sampleAt(mainline, roadLengthM(mainline) * fraction),
    accuracy: 5, speed: 15, timestamp: base + ms,
  });
  at(.3, 0);
  const live = at(.5, 1000);
  tracker.invalidate('GPS unavailable', true);
  const afterMinute = tracker.tick(base + 61000);
  assert.equal(afterMinute.previousDelta, null);
  assert.equal(afterMinute.entryTime, live.entryTime);
  assert.equal(afterMinute.sessionId, live.sessionId);
  assert.equal(afterMinute.completedSession, null);
  assert.equal(afterMinute.lastValidDeltaSeconds, live.deltaSeconds);
});

test('proven TPE exit followed by mapped TPE re-entry starts a new session within retention window', () => {
  const tracker = new Tracker(layered);
  const base = 1_800_000_000_000;
  const at = (id, fraction, ms) => {
    const road = byId.get(id) || local.roads.find(road => road.id === id);
    return tracker.update({ ...sampleAt(road, roadLengthM(road) * fraction),
      accuracy: 5, speed: 15, timestamp: base + ms });
  };
  at('osm-way-756847962', .2, 0);
  const original = at('osm-way-756847962', .7, 1000);
  at('osm-way-139718132', .2, 2000);
  at('osm-way-139718132', .7, 4000);
  at('osm-way-139718132', .9, 9000);
  at('osm-way-628738331', .2, 10000);
  const exited = at('osm-way-628738331', .7, 12000);
  assert.equal(exited.completedSession.sessionId, original.sessionId);
  assert.equal(exited.previousDelta, null);
  at('osm-way-655615941', .5, 14000);
  for (const [id, ms] of [
    ['osm-way-349477708', 16000], ['osm-way-726148961', 18000],
    ['osm-way-349477686', 20000], ['osm-way-349477701', 22000],
    ['osm-way-349477704', 24000],
  ]) at(id, .5, ms);
  const reentered = at('osm-way-629360446', .2, 26000);
  assert.notEqual(reentered.sessionId, original.sessionId);
  assert.ok(reentered.entryTime >= base + 16000 && reentered.entryTime < base + 26000);
  assert.equal(reentered.completedSession.sessionId, original.sessionId);
  assert.equal(reentered.previousDelta, null);
});

test('mapped TPE exit archives the ramp divergence time before six-second confirmation', () => {
  const mainline = byId.get('osm-way-756847962');
  const ramp = local.roads.find(road => road.id === 'osm-way-139718132');
  const destination = local.roads.find(road => road.id === 'osm-way-628738331');
  const tracker = new Tracker(layered);
  const base = 1_800_000_000_000;
  const at = (road, fraction, ms) => tracker.update({
    ...sampleAt(road, roadLengthM(road) * fraction), accuracy: 5, speed: 15, timestamp: base + ms,
  });
  at(mainline, .2, 0);
  const live = at(mainline, .7, 1000);
  const leaving = at(ramp, .2, 2000);
  assert.equal(leaving.rampTransition.classification, 'leaving');
  assert.equal(leaving.rampTransition.boundary.timing, 'estimated');
  assert.equal(leaving.completedSession, null);
  at(ramp, .7, 3000);
  at(ramp, .9, 9000);
  at(destination, .2, 10000);
  const localState = at(destination, .7, 12000);
  assert.equal(localState.status, 'local');
  assert.equal(localState.completedSession.entryTime, live.entryTime);
  assert.equal(localState.completedSession.finalTimingStatus, 'estimated-boundary');
  assert.equal(localState.completedSession.exitTime, leaving.rampTransition.boundary.estimatedTime);
  assert.ok(localState.completedSession.exitTime < base + 2000);
  assert.ok(localState.completedSession.confirmationTime - localState.completedSession.exitTime > 6000);
});

test('real ECP to KPE three-link ramp transfer retains one expressway session', () => {
  const tracker = new Tracker(layered);
  const base = 1_800_000_000_000;
  let ms = 0;
  const at = (id, fraction) => {
    const road = byId.get(id) || local.roads.find(road => road.id === id);
    return tracker.update({ ...sampleAt(road, roadLengthM(road) * fraction),
      accuracy: 5, speed: 15, timestamp: base + (ms += 2000) });
  };
  at('osm-way-670121242', .2);
  const ecp = at('osm-way-670121242', .7);
  assert.equal(ecp.status, 'tracking');
  for (const id of ['osm-way-32605139', 'osm-way-140562826', 'osm-way-528189241']) {
    const ramp = at(id, .2);
    assert.equal(ramp.rampTransition.classification, 'transfer', id);
    assert.equal(ramp.rampTransition.pathCount, 1, id);
    assert.equal(ramp.status, 'tracking', id);
    assert.equal(ramp.entryTime, ecp.entryTime, id);
    assert.equal(ramp.completedSession, null, id);
  }
  const kpe = at('osm-way-633601611', .1);
  assert.equal(kpe.status, 'tracking');
  assert.equal(kpe.entryTime, ecp.entryTime);
  assert.equal(kpe.rampTransition, null);
  assert.equal(kpe.completedSession, null);
});

test('real Upper Cross joining ramp starts CTE timing at the mainline boundary', () => {
  const tracker = new Tracker(layered);
  const base = 1_800_000_000_000;
  let ms = 0;
  const at = (id, distance) => {
    const road = byId.get(id) || local.roads.find(road => road.id === id);
    return tracker.update({ ...sampleAt(road, Math.min(distance, roadLengthM(road) - 1)),
      accuracy: 5, speed: 15, timestamp: base + (ms += 2000) });
  };
  at('osm-way-996698202', 70);
  for (const id of ['osm-way-22674815', 'osm-way-480919517', 'osm-way-480919516']) at(id, 20);
  at('osm-way-121882988', 20);
  const ramp = at('osm-way-121882988', 80);
  assert.equal(ramp.rampTransition.classification, 'joining');
  assert.equal(ramp.entryTime, base + 4000);
  assert.equal(ramp.approachTime, base + 4000);
  assert.equal(ramp.mainlineEntryTime, null);
  assert.equal(ramp.deltaSeconds, null);
  const cte = at('osm-way-174552486', 4);
  assert.equal(cte.status, 'tracking');
  assert.equal(cte.approachTime, ramp.approachTime);
  assert.equal(cte.entryTime, cte.mainlineEntryTime);
  assert.ok(cte.mainlineEntryTime >= base + 12_000 && cte.mainlineEntryTime <= base + 14_000);
  assert.equal(cte.rampTransition, null);
  const successor = at('osm-way-121882983', 30);
  assert.equal(successor.status, 'tracking');
  assert.equal(successor.entryTime, cte.entryTime);
  assert.equal(successor.rampTransition, null);
});

test('unresolved fork candidate can later recover on a unique true road', () => {
  const road = (id, coordinates, nextRoadIds) => ({ id, ref: 'PIE', name: 'PIE',
    speedLimit: 90, nextRoadIds, coordinates });
  const a = road('uncertain-a', [[103.9, 1.35], [103.91, 1.35]], ['uncertain-b', 'uncertain-c']);
  const b = road('uncertain-b', [[103.91, 1.35], [103.92, 1.35]], ['uncertain-d']);
  const c = road('uncertain-c', [[103.91, 1.35], [103.915, 1.351], [103.92, 1.35]], ['uncertain-d']);
  const d = road('uncertain-d', [[103.92, 1.35], [103.93, 1.35]], []);
  const tracker = new Tracker({ roads: [a, b, c, d] });
  const base = 1_800_000_000_000;
  const fix = (segment, metres, ms) => ({ ...sampleAt(segment, metres),
    accuracy: 5, speed: 25, timestamp: base + ms });
  tracker.update(fix(a, 50, 0));
  const before = tracker.update(fix(a, 100, 2000));
  tracker.invalidate('Tunnel GPS unavailable');
  const unresolved = tracker.update(fix(d, 500, 100000));
  assert.equal(unresolved.deltaStatus, 'unresolved');
  assert.equal(unresolved.lastValidDeltaSeconds, before.deltaSeconds);
  const firstTrue = tracker.update(fix(a, 150, 101000));
  assert.equal(firstTrue.deltaSeconds, null);
  const recovered = tracker.update(fix(a, 200, 102000));
  assert.equal(recovered.deltaStatus, 'live');
  assert.equal(recovered.entryTime, base);
  assert.ok(Math.abs(recovered.deltaSeconds - (102 - 150 / (90 / 3.6))) < .05);
});
