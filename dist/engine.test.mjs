import test from 'node:test';
import assert from 'node:assert/strict';
import { Tracker, sampleAt, roadLengthM } from './engine.js';

const road = {
  id: 'east', ref: 'TPE', name: 'Tampines Expressway', direction: 'Eastbound',
  coordinates: [[103.9, 1.35], [103.91, 1.35]], speedLimit: 90,
  exits: [300, 600, 900, 1100].map((offsetM, i) => ({ name: `Exit ${i + 1}`, offsetM }))
};
const west = { ...road, id: 'west', direction: 'Westbound',
  coordinates: [...road.coordinates].reverse() };
const epoch = 1793750400000;
const at = (r, metres, timestamp, speed = 20, heading) =>
  ({ ...sampleAt(r, metres), accuracy: 5, timestamp: epoch + timestamp, speed,
    ...(heading == null ? {} : { heading }) });
const start = (tracker, r, metres = 100) => {
  assert.equal(tracker.update(at(r, metres, 0)).status, 'entering');
  return tracker.update(at(r, metres, 1000));
};

test('joining ramp approach is a provisional clock with separate mainline evidence', () => {
  const local = { id: 'street', highway: 'residential', speedLimit: 50,
    coordinates: [[103.899, 1.35], [103.9, 1.35]] };
  const ramp = { id: 'join', highway: 'motorway_link', speedLimit: 50, oneway: true,
    coordinates: [[103.9, 1.35], [103.901, 1.35]] };
  const main = { ...road, id: 'main', coordinates: [[103.901, 1.35], [103.91, 1.35]] };
  const tracker = new Tracker({ roads: [main], localRoads: [local, ramp], rampGraph: {
    links: [{ id: 'join' }], paths: [{ kind: 'joining', fromRoadId: 'street',
      toRoadId: 'main', linkIds: ['join'], endCoordinate: [103.901, 1.35] }] } });
  const approach = tracker.update(at(ramp, 30, 0));
  assert.equal(approach.approachTime, epoch);
  assert.equal(approach.expresswayEntryTime, null);
  assert.equal(approach.deltaSeconds, null);
  assert.equal(approach.timingBasis, 'since entrance approach');
  assert.equal(approach.roadMatchStatus, 'checking');
  tracker.invalidate('GPS unavailable');
  assert.equal(tracker.state.gpsStatus, 'unavailable');
  assert.equal(tracker.diagnosticSnapshot().state.gapAnchorRoadId, 'join');
  tracker.reset();
  assert.equal(tracker.state.approachTime, undefined);
});

test('same expressway transfer outcome keeps distinct physical boundaries unresolved', () => {
  const first = { ...road, id: 'first', ref: 'ECP', nextRoadIds: ['second'] };
  const second = { ...road, id: 'second', ref: 'ECP' };
  const target = { ...road, id: 'target', ref: 'KPE' };
  const ramp = { id: 'branch', highway: 'motorway_link', oneway: true,
    coordinates: [[103.902, 1.35], [103.903, 1.349]] };
  const tracker = new Tracker({ roads: [first, second, target], localRoads: [ramp],
    rampGraph: { links: [{ id: 'branch' }], paths: [
      { kind: 'transfer', fromRoadId: 'first', toRoadId: 'target',
        linkIds: ['branch', 'tail-a'], startCoordinate: [103.902, 1.35] },
      { kind: 'transfer', fromRoadId: 'second', toRoadId: 'target',
        linkIds: ['branch', 'tail-b'], startCoordinate: [103.9022, 1.35] }
    ] } });
  const transition = tracker.classifyRamp(ramp, first);
  assert.equal(transition.classification, 'transfer');
  assert.equal(transition.pathCount, 1);
  assert.equal(transition.exactPathCount, 2);
  assert.equal(transition.boundary, null);
});

test('matches direction using heading and reports three upcoming exits', () => {
  const tracker = new Tracker({ roads: [road, west] });
  const state = start(tracker, road);
  assert.equal(state.road.direction, 'Eastbound');
  assert.deepEqual(state.exits.map(e => e.name), ['Exit 1', 'Exit 2', 'Exit 3']);
  assert.ok(Math.abs(state.exits[0].distanceM - 200) < 2);
  assert.equal(state.exits[0].forecast, true);
  assert.ok(roadLengthM(road) > 1100);
});

test('delta starts at detection, grows while stopped, and exit forecast uses current speed', () => {
  const tracker = new Tracker({ roads: [road] });
  assert.equal(start(tracker, road).deltaSeconds, 1);
  const moving = tracker.update(at(road, 300, 11000, 20));
  assert.ok(Math.abs(moving.deltaSeconds - 3) < 0.2);
  assert.ok(moving.exits[0].projectedDeltaSeconds > moving.deltaSeconds);
  const stopped = tracker.update(at(road, 300, 16000, 0));
  assert.ok(Math.abs(stopped.deltaSeconds - 8) < 0.2);
  assert.equal(stopped.exits[0].projectedDeltaSeconds, null);
});

test('unknown speed limit uses visibly assumed 50 km/h reference', () => {
  const tracker = new Tracker({ roads: [{ ...road, speedLimit: null }] });
  start(tracker, road);
  const state = tracker.update(at(road, 200, 6000));
  assert.equal(state.limitKmh, 50);
  assert.equal(state.limitAssumed, true);
  assert.equal(state.limitSource, 'Assumed 50 km/h reference');
  assert.ok(Number.isFinite(state.deltaSeconds));
  assert.equal(state.exits[0].referenceAssumed, true);
});

test('implausible mapped speed tags use assumed reference', () => {
  const tracker = new Tracker({ roads: [{ ...road, speedLimit: 500 }] });
  const state = start(tracker, road);
  assert.equal(state.limitKmh, 50);
  assert.equal(state.limitAssumed, true);
});

test('bad fix and long GPS gap invalidate accumulated delta', () => {
  const tracker = new Tracker({ roads: [road] });
  start(tracker, road);
  assert.ok(tracker.update(at(road, 150, 6000)).deltaSeconds !== 0);
  assert.equal(tracker.update({ ...at(road, 160, 7000), accuracy: 200 }).status, 'stale');
  const reacquired = tracker.update(at(road, 170, 8000));
  assert.equal(reacquired.status, 'identifying');
  assert.equal(reacquired.deltaSeconds, null);
  const resumed = tracker.update(at(road, 180, 9000));
  assert.ok(Number.isFinite(resumed.deltaSeconds));
  assert.equal(resumed.timingBasis, 'since mainline entry');
});

test('tunnel reduces confidence', () => {
  const tracker = new Tracker({ roads: [{ ...road, tunnels: [{ fromM: 50, toM: 150 }] }] });
  const state = start(tracker, road);
  assert.equal(state.inTunnel, true);
  assert.equal(state.confidence, 'low');
});

test('connected mainline segments retain timing and show downstream exits', () => {
  const first = { ...road, id: 'first', coordinates: [[103.9, 1.35], [103.905, 1.35]],
    lengthM: 556, nextRoadIds: ['second'], exits: [] };
  const second = { ...road, id: 'second', coordinates: [[103.905, 1.35], [103.91, 1.35]],
    lengthM: 556, nextRoadIds: [], exits: [{ name: 'Exit A', offsetM: 100 },
      { name: 'Exit B', offsetM: 200 }, { name: 'Exit C', offsetM: 300 }] };
  const tracker = new Tracker({ roads: [first, second] });
  tracker.update(at(first, 400, 1000));
  const before = tracker.update(at(first, 500, 6000));
  assert.equal(before.exits.length, 3);
  assert.ok(before.exits[0].distanceM > 100);
  const after = tracker.update(at(second, 30, 10000));
  assert.equal(after.road.id, 'second');
  assert.ok(after.elapsedSeconds > before.elapsedSeconds);
  assert.ok(after.deltaSeconds !== 0);
  assert.equal(after.exits[0].name, 'Exit A');
});

test('fix can skip several short connected ways without losing timing', () => {
  const make = (id, start, end, nextRoadIds) => ({ ...road, id,
    coordinates: [[start, 1.35], [end, 1.35]], nextRoadIds,
    exits: [], travelDirection: 'Towards Changi' });
  const a = make('a', 103.9, 103.9005, ['b']);
  const b = make('b', 103.9005, 103.90051, ['c']);
  const c = make('c', 103.90051, 103.90052, ['d']);
  const d = make('d', 103.90052, 103.901, []);
  const tracker = new Tracker({ roads: [a, b, c, d] });
  tracker.update(at(a, 20, 1000));
  const before = tracker.update(at(a, 40, 2000));
  const after = tracker.update(at(d, 20, 4000));
  assert.equal(after.road.id, 'd');
  assert.equal(after.road.direction, 'Towards Changi');
  assert.ok(after.elapsedSeconds > before.elapsedSeconds);
});

test('boolean tunnel and unnamed exit fields are respected', () => {
  const tracker = new Tracker({ roads: [{ ...road, tunnel: true, exits: [{ id: 'osm-way-1', offsetM: 300 }] }] });
  const state = start(tracker, road);
  assert.equal(state.confidence, 'low');
  assert.equal(state.exits[0].name, 'Unnamed exit');
});

test('local road and ramp transition require confirmation before expressway timing', () => {
  const local = { id: 'street', name: 'Local Street', coordinates: [[103.9, 1.349], [103.91, 1.349]], oneway: false };
  const ramp = { id: 'ramp', name: 'Entry ramp', highway: 'motorway_link', coordinates: [[103.9, 1.3495], [103.91, 1.3495]], oneway: true };
  const tracker = new Tracker({ roads: [road], localRoads: { roads: [local, ramp] } });
  const localFix = { ...at(local, 100, 1000), speed: 10 };
  assert.equal(tracker.update(localFix).status, 'identifying');
  assert.equal(tracker.update({ ...localFix, timestamp: epoch + 1500 }).status, 'local');
  const rampFix = at(ramp, 150, 2000);
  assert.equal(tracker.update(rampFix).status, 'identifying');
  assert.equal(tracker.update({ ...rampFix, timestamp: epoch + 8000 }).status, 'local');
  const main = at(road, 200, 9000);
  const entering = tracker.update(main);
  assert.equal(entering.status, 'entering');
  assert.equal(entering.deltaSeconds, null);
  assert.deepEqual(entering.exits, []);
  const confirmed = tracker.update({ ...main, timestamp: epoch + 15000 });
  assert.equal(confirmed.status, 'tracking');
  assert.equal(confirmed.entryTime, epoch + 9000);
  assert.equal(confirmed.entrySource, 'first-mainline-fix');
});

test('closer parallel local road wins and unmatched fix still shows GPS speed', () => {
  const local = { id: 'parallel', name: 'Parallel Road', coordinates: [[103.9, 1.35008], [103.91, 1.35008]] };
  const tracker = new Tracker({ roads: [road], localRoads: [local] });
  const fix = at(local, 100, 1000);
  assert.equal(tracker.update(fix).road.name, 'Parallel Road');
  const unmatched = tracker.update({ ...fix, latitude: 1.36, timestamp: epoch + 2000 });
  assert.equal(unmatched.status, 'identifying');
  assert.equal(unmatched.speedKmh, 72);
});

test('overlapping local road and expressway remain unidentified', () => {
  const local = { id: 'overpass', name: 'Overpass', coordinates: road.coordinates };
  const tracker = new Tracker({ roads: [road], localRoads: [local] });
  for (let i = 0; i < 3; i++) {
    const state = tracker.update(at(road, 100 + i * 20, 1000 + i * 1000));
    assert.equal(state.status, 'identifying');
    assert.equal(state.deltaSeconds, null);
    assert.deepEqual(state.exits, []);
  }
});

test('local roads show mapped or assumed limits without timing', () => {
  const local = { id: 'local', name: 'Street', coordinates: [[103.9, 1.349], [103.91, 1.349]], speedLimit: 40 };
  const tracker = new Tracker({ roads: [road], localRoads: [local] });
  tracker.update(at(local, 100, 0));
  const mapped = tracker.update(at(local, 100, 1000));
  assert.equal(mapped.status, 'local');
  assert.equal(mapped.limitKmh, 40);
  assert.equal(mapped.limitAssumed, false);
  assert.equal(mapped.deltaSeconds, null);
  const unknown = new Tracker({ roads: [road], localRoads: [{ ...local, speedLimit: null }] });
  unknown.update(at(local, 100, 0));
  const assumed = unknown.update(at(local, 100, 1000));
  assert.equal(assumed.limitKmh, 50);
  assert.equal(assumed.limitAssumed, true);
});

test('six second road switch retains confirmed label and suppresses forecasts', () => {
  const local = { id: 'street', name: 'Street', coordinates: [[103.9, 1.349], [103.91, 1.349]] };
  const tracker = new Tracker({ roads: [road], localRoads: [local] });
  start(tracker, road);
  const first = tracker.update(at(local, 100, 2000));
  assert.equal(first.status, 'exiting');
  assert.equal(first.road.ref, 'TPE');
  assert.equal(first.candidateRoad.name, 'Street');
  assert.equal(first.deltaSeconds, null);
  assert.deepEqual(first.exits, []);
  const bounce = tracker.update(at(road, 100, 3000));
  assert.equal(bounce.status, 'identifying');
  assert.equal(bounce.deltaSeconds, null);
  assert.equal(tracker.update(at(road, 100, 4000)).status, 'tracking');
  tracker.update(at(local, 100, 5000));
  assert.equal(tracker.update(at(local, 100, 10000)).status, 'exiting');
  assert.equal(tracker.update(at(local, 100, 11000)).status, 'exiting');
});

test('stale GPS preserves last road and entry history without live readings', () => {
  const tracker = new Tracker({ roads: [road] });
  const detected = start(tracker, road);
  const stale = tracker.invalidate('Tunnel GPS gap');
  assert.equal(stale.status, 'stale');
  assert.equal(stale.road.ref, 'TPE');
  assert.equal(stale.entryTime, detected.entryTime);
  assert.equal(stale.speedKmh, null);
  assert.equal(stale.deltaSeconds, null);
  assert.deepEqual(stale.exits, []);
});

test('first detection in tunnel labels entry uncertainty', () => {
  const tunnelRoad = { ...road, tunnel: true };
  const tracker = new Tracker({ roads: [tunnelRoad] });
  const state = start(tracker, tunnelRoad);
  assert.equal(state.entrySource, 'first-mainline-fix');
  assert.equal(state.entryConfidence, 'low');
  assert.ok(state.entryUncertaintyMs > 0);
  assert.equal(state.entryTime, epoch);
});

test('long tunnel gap reconstructs unique same-chain route and original session', () => {
  const a = { ...road, id: 'a', coordinates: [[103.9, 1.35], [103.91, 1.35]],
    lengthM: 1112, nextRoadIds: ['b'], exits: [] };
  const b = { ...road, id: 'b', coordinates: [[103.91, 1.35], [103.92, 1.35]],
    lengthM: 1112, nextRoadIds: ['c'], tunnel: true, exits: [] };
  const c = { ...road, id: 'c', coordinates: [[103.92, 1.35], [103.93, 1.35]],
    lengthM: 1112, nextRoadIds: [], exits: [] };
  const tracker = new Tracker({ roads: [a, b, c] });
  start(tracker, a);
  const before = tracker.update(at(a, 500, 6000));
  const entry = before.entryTime;
  const gap = tracker.invalidate('Tunnel signal lost');
  assert.equal(gap.deltaSeconds, null);
  assert.equal(gap.speedKmh, null);
  const recovering = tracker.update(at(c, 300, 160000));
  assert.equal(recovering.deltaSeconds, null);
  const after = tracker.update(at(c, 320, 161000));
  assert.equal(after.status, 'tracking');
  assert.equal(after.entryTime, entry);
  assert.equal(after.timingBasis, 'since mainline entry');
  assert.equal(after.fullSessionAvailable, true);
  assert.ok(after.elapsedSeconds > 150);
  assert.ok(Number.isFinite(after.deltaSeconds));
});

test('branching tunnel path refuses full-session reconstruction', () => {
  const a = { ...road, id: 'a', nextRoadIds: ['b', 'c'], exits: [] };
  const b = { ...road, id: 'b', coordinates: [[103.91, 1.35], [103.92, 1.35]], nextRoadIds: ['d'] };
  const c = { ...road, id: 'c', coordinates: [[103.91, 1.35], [103.92, 1.35]], nextRoadIds: ['d'] };
  const d = { ...road, id: 'd', coordinates: [[103.92, 1.35], [103.93, 1.35]], nextRoadIds: [] };
  const tracker = new Tracker({ roads: [a, b, c, d] });
  start(tracker, a);
  tracker.invalidate('Tunnel signal lost');
  const state = tracker.update(at(d, 100, 60000));
  assert.equal(state.deltaSeconds, null);
  assert.equal(state.deltaStatus, 'unresolved');
});

test('piecewise limits and assumed history survive a mapped limit change', () => {
  const zoned = { ...road, speedLimit: 90, speedLimits: [
    { fromM: 300, toM: 500, limitKmh: 70 },
    { fromM: 500, toM: 700, limitKmh: null },
    { fromM: 700, toM: 1100, limitKmh: 80 }
  ] };
  const tracker = new Tracker({ roads: [zoned] }, { maxGapMs: 30000 });
  start(tracker, zoned, 200);
  const crossing = tracker.update(at(zoned, 600, 21000, 20));
  assert.equal(crossing.limitKmh, 50);
  assert.equal(crossing.cumulativeReferenceAssumed, true);
  const mapped = tracker.update(at(zoned, 800, 31000, 20));
  assert.equal(mapped.limitKmh, 80);
  assert.equal(mapped.cumulativeReferenceAssumed, true);
  assert.ok(Number.isFinite(mapped.deltaSeconds));
  const nearBoundary = tracker.update(at(zoned, 900, 36000, 20));
  assert.equal(nearBoundary.limitUncertain, false);
});

test('verified cross-reference connector continues timing without switch hold', () => {
  const mce = { ...road, id: 'mce', ref: 'MCE', nextRoadIds: [],
    routeNextRoadIds: [{ roadId: 'kpe', connectorIds: ['link'], lengthM: 100 }] };
  const connector = { id: 'link', coordinates: [[103.91, 1.35], [103.911, 1.35]], speedLimit: 70, lengthM: 111 };
  const kpe = { ...road, id: 'kpe', ref: 'KPE', coordinates: [[103.911, 1.35], [103.921, 1.35]],
    speedLimit: 80, nextRoadIds: [] };
  const tracker = new Tracker({ roads: [mce, kpe], connectors: [connector] }, { maxGapMs: 30000 });
  start(tracker, mce, 900);
  const after = tracker.update(at(kpe, 100, 16000));
  assert.equal(after.status, 'tracking');
  assert.equal(after.road.ref, 'KPE');
  assert.ok(after.elapsedSeconds > 1);
});

test('forecast caps each interval at future mapped speed limit', () => {
  const zoned = { ...road, speedLimit: 90,
    speedLimits: [{ fromM: 200, toM: 1100, limitKmh: 50 }] };
  const tracker = new Tracker({ roads: [zoned] });
  const state = start(tracker, zoned, 100);
  const exit = state.exits[0];
  assert.ok(exit.projectedDeltaSeconds >= state.deltaSeconds - 0.01);
});

test('uncertainty detects a short lower-limit zone inside GPS radius', () => {
  const zoned = { ...road, speedLimit: 90,
    speedLimits: [{ fromM: 295, toM: 305, limitKmh: 70 }] };
  const tracker = new Tracker({ roads: [zoned] });
  tracker.update({ ...at(zoned, 280, 0), accuracy: 25 });
  const state = tracker.update({ ...at(zoned, 280, 1000), accuracy: 25 });
  assert.equal(state.limitKmh, 90);
  assert.equal(state.limitUncertain, true);
});

test('one credible mainline fix survives a tunnel outage and anchors recovered session', () => {
  const a = { ...road, id: 'ctea', ref: 'CTE', nextRoadIds: ['cteb'], exits: [] };
  const b = { ...road, id: 'cteb', ref: 'CTE', coordinates: [[103.91, 1.35], [103.92, 1.35]], nextRoadIds: [], exits: [] };
  const tracker = new Tracker({ roads: [a, b] });
  const first = tracker.update(at(a, 100, 0));
  assert.equal(first.status, 'entering');
  assert.equal(first.provisional, true);
  assert.equal(first.entryTime, epoch);
  const stale = tracker.invalidate('GPS unavailable');
  assert.equal(stale.provisional, true);
  assert.equal(stale.road.ref, 'CTE');
  assert.equal(stale.speedKmh, null);
  assert.equal(stale.deltaSeconds, null);
  assert.deepEqual(stale.exits, []);
  const firstReturn = tracker.update(at(b, 100, 30000));
  assert.equal(firstReturn.deltaSeconds, null);
  const recovered = tracker.update(at(b, 120, 31000));
  assert.equal(recovered.status, 'tracking');
  assert.equal(recovered.entryTime, epoch);
  assert.equal(recovered.reconstructionStatus, 'reconstructed');
  assert.equal(recovered.timingBasis, 'since mainline entry');
  assert.ok(Number.isFinite(recovered.deltaSeconds));
});

test('provisional contradiction cannot backdate an unrelated route and reset clears it', () => {
  const unrelated = { ...road, id: 'other', ref: 'PIE', coordinates: [[103.92, 1.35], [103.93, 1.35]] };
  const tracker = new Tracker({ roads: [road, unrelated] });
  tracker.update(at(road, 100, 0));
  tracker.invalidate('GPS unavailable');
  const contradicted = tracker.update(at(unrelated, 100, 30000));
  assert.equal(contradicted.deltaSeconds, null);
  assert.notEqual(contradicted.reconstructionStatus, 'reconstructed');
  const reset = tracker.reset();
  assert.equal(reset.entryTime, null);
  assert.equal(tracker.provisional, null);
});

test('provisional fork cannot invent a full-session delta', () => {
  const a = { ...road, id: 'a', nextRoadIds: ['b', 'c'] };
  const b = { ...road, id: 'b', coordinates: [[103.91, 1.35], [103.92, 1.35]], nextRoadIds: ['d'] };
  const c = { ...road, id: 'c', coordinates: [[103.91, 1.35], [103.92, 1.35]], nextRoadIds: ['d'] };
  const d = { ...road, id: 'd', coordinates: [[103.92, 1.35], [103.93, 1.35]], nextRoadIds: [] };
  const tracker = new Tracker({ roads: [a, b, c, d] });
  tracker.update(at(a, 100, 0));
  tracker.invalidate('Tunnel GPS gap');
  const state = tracker.update(at(d, 100, 60000));
  assert.equal(state.deltaSeconds, null);
  assert.equal(state.reconstructionStatus, 'unresolved');
  assert.ok(tracker.provisional);
});

test('unreliable first fix cannot create provisional entry', () => {
  const tracker = new Tracker({ roads: [road] });
  const first = tracker.update({ ...at(road, 100, 0), accuracy: 55, heading: null });
  assert.equal(first.provisional, false);
  assert.equal(first.entryTime, null);
  const stale = tracker.invalidate('GPS unavailable');
  assert.equal(stale.status, 'stale');
  assert.equal(stale.entryTime, null);
});

test('held session survives repeat errors and recovers once from committed anchor', () => {
  const tracker = new Tracker({ roads: [road] });
  start(tracker, road, 100);
  const live = tracker.update(at(road, 150, 2000));
  const sessionId = live.sessionId;
  const held = tracker.invalidate('GPS lost');
  assert.equal(held.deltaStatus, 'held');
  assert.equal(held.lastValidDeltaSeconds, live.deltaSeconds);
  assert.equal(held.gapStart, epoch + 2000);
  assert.equal(held.speedKmh, null);
  assert.equal(held.lastKnownLimitKmh, 90);
  assert.equal(held.heldExits.length, 3);
  const secondError = tracker.invalidate('Still no GPS');
  assert.equal(secondError.gapStart, held.gapStart);
  const first = tracker.update(at(road, 300, 10000));
  assert.equal(first.deltaStatus, 'recovering');
  assert.equal(first.deltaSeconds, null);
  assert.equal(tracker.update(at(road, 300, 10000)).acceptedFix, false);
  const restored = tracker.update(at(road, 320, 11000));
  assert.equal(restored.deltaStatus, 'live');
  assert.equal(restored.sessionId, sessionId);
  assert.ok(Math.abs(restored.deltaSeconds - (11 - 220 / 25)) < 0.2);
  assert.equal(restored.reconstructionStatus, 'reconstructed');
});

test('unproven local road switch archives only after visual retention window', () => {
  const local = { id: 'street', name: 'Street', coordinates: [[103.9, 1.349], [103.91, 1.349]] };
  const tracker = new Tracker({ roads: [road], localRoads: [local] });
  const live = start(tracker, road);
  tracker.update(at(local, 100, 2000));
  const exiting = tracker.update(at(local, 100, 7000));
  assert.equal(exiting.deltaSeconds, null);
  const done = tracker.update(at(local, 100, 8000));
  assert.equal(done.status, 'exiting');
  assert.equal(done.sessionId, live.sessionId);
  assert.equal(done.completedSession, null);
  const expired = tracker.tick(epoch + 37000);
  assert.equal(expired.completedSession, null);
});

test('mapped leaving ramp archives delta at divergence before confirmation', () => {
  const main = { ...road, id: 'main' };
  const ramp = { id: 'ramp', name: 'Exit ramp', highway: 'motorway_link', oneway: true,
    coordinates: [[103.9027, 1.35], [103.9037, 1.3495]] };
  const local = { id: 'street', name: 'Street', coordinates: [[103.9037, 1.3495], [103.9047, 1.3495]] };
  const graph = { source: 'exact directed OSM shared nodes', links: [{ id: 'ramp', nextLinkIds: [] }],
    paths: [{ kind: 'leaving', fromRoadId: 'main', toRoadId: 'street', linkIds: ['ramp'],
      startCoordinate: ramp.coordinates[0], endCoordinate: ramp.coordinates[1] }] };
  const tracker = new Tracker({ roads: [main], rampGraph: graph }, { localRoads: [ramp, local] });
  start(tracker, main, 150);
  const live = tracker.update(at(main, 200, 2000));
  const firstRamp = tracker.update(at(ramp, 30, 3000));
  assert.equal(firstRamp.rampTransition.classification, 'leaving');
  assert.equal(firstRamp.rampTransition.boundary.timing, 'estimated');
  tracker.update(at(ramp, 80, 9000));
  tracker.update(at(local, 40, 10000));
  const confirmed = tracker.update(at(local, 70, 12000));
  assert.equal(confirmed.status, 'local');
  assert.ok(confirmed.completedSession.exitTime < epoch + 9000);
  assert.equal(confirmed.completedSession.finalTimingStatus, 'estimated-boundary');
  assert.notEqual(confirmed.completedSession.finalDeltaSeconds, live.deltaSeconds);
});

test('mapped transfer ramp does not archive session at six seconds', () => {
  const a = { ...road, id: 'a', ref: 'ECP', routeNextRoadIds: [{ roadId: 'b', connectorIds: ['ramp'], lengthM: 111 }] };
  const b = { ...road, id: 'b', ref: 'KPE', coordinates: [[103.911, 1.35], [103.921, 1.35]] };
  const ramp = { id: 'ramp', highway: 'motorway_link', coordinates: [[103.91, 1.35], [103.911, 1.35]],
    speedLimit: 70, lengthM: 111 };
  const graph = { source: 'exact directed OSM shared nodes', links: [{ id: 'ramp', nextLinkIds: [] }],
    paths: [{ kind: 'transfer', fromRoadId: 'a', toRoadId: 'b', linkIds: ['ramp'],
      startCoordinate: ramp.coordinates[0], endCoordinate: ramp.coordinates[1] }] };
  const tracker = new Tracker({ roads: [a, b], connectors: [ramp], rampGraph: graph });
  const live = start(tracker, a, 900);
  const onRamp = tracker.update(at(ramp, 30, 3000));
  assert.equal(onRamp.rampTransition.classification, 'transfer');
  assert.equal(onRamp.sessionId, live.sessionId);
  const later = tracker.update(at(ramp, 80, 9000));
  assert.equal(later.completedSession, null);
  assert.equal(later.sessionId, live.sessionId);
});

test('mapped joining ramp estimates entry before first mainline fix', () => {
  const local = { id: 'street', name: 'Street', coordinates: [[103.899, 1.349], [103.9, 1.349]] };
  const ramp = { id: 'join', highway: 'motorway_link', oneway: true,
    coordinates: [[103.9, 1.349], [103.901, 1.35]] };
  const main = { ...road, id: 'main', coordinates: [[103.901, 1.35], [103.911, 1.35]] };
  const graph = { source: 'exact directed OSM shared nodes', links: [{ id: 'join', nextLinkIds: [] }],
    paths: [{ kind: 'joining', fromRoadId: 'street', toRoadId: 'main', linkIds: ['join'],
      startCoordinate: ramp.coordinates[0], endCoordinate: ramp.coordinates[1] }] };
  const tracker = new Tracker({ roads: [main], rampGraph: graph }, { localRoads: [local, ramp] });
  tracker.update(at(local, 50, 0));
  tracker.update(at(local, 50, 1000));
  tracker.update(at(ramp, 30, 2000));
  const rampState = tracker.update(at(ramp, roadLengthM(ramp) - 30, 8000));
  assert.equal(rampState.rampTransition.classification, 'joining');
  const joined = tracker.update(at(main, 40, 9000));
  assert.equal(joined.status, 'tracking');
  assert.equal(joined.entrySource, 'mapped-ramp-boundary-estimate');
  assert.equal(joined.approachTime, epoch + 2000);
  assert.ok(joined.expresswayEntryTime > epoch + 8000 && joined.expresswayEntryTime < epoch + 9000);
  assert.equal(joined.entryTime, joined.expresswayEntryTime);
  assert.equal(joined.timingBasis, 'since mainline entry');
  assert.equal(joined.rampTransition, null);
  tracker.committed = null;
  tracker.provisional = { road: main, fix: { time: epoch + 9000, alongM: 40 },
    elapsed: joined.elapsedSeconds, reference: tracker.referenceSeconds, assumed: false };
  tracker.invalidate('Immediate tunnel outage');
  assert.equal(tracker.gapAnchor.road.id, 'main');
  assert.equal(tracker.gapAnchor.fix.time, epoch + 9000);
  assert.equal(tracker.state.entryTime, joined.expresswayEntryTime);
});

test('ambiguous ramp outcomes remain unknown and do not force an exit', () => {
  const main = { ...road, id: 'main' };
  const ramp = { id: 'ramp', highway: 'motorway_link', oneway: true,
    coordinates: [[103.9027, 1.35], [103.9037, 1.3495]] };
  const graph = { links: [{ id: 'ramp', nextLinkIds: [] }], paths: [
    { kind: 'leaving', fromRoadId: 'main', toRoadId: 'local-a', linkIds: ['ramp'], startCoordinate: ramp.coordinates[0] },
    { kind: 'transfer', fromRoadId: 'main', toRoadId: 'other-main', linkIds: ['ramp'], startCoordinate: ramp.coordinates[0] }
  ] };
  const tracker = new Tracker({ roads: [main], rampGraph: graph }, { localRoads: [ramp] });
  start(tracker, main, 200);
  const first = tracker.update(at(ramp, 30, 2000));
  assert.equal(first.rampTransition.classification, 'unknown');
  const later = tracker.update(at(ramp, 80, 9000));
  assert.equal(later.completedSession, null);
  assert.equal(later.rampTransition.pathCount, 2);
});

test('multi-link ramp keeps one transition across connected segments', () => {
  const main = { ...road, id: 'main' };
  const a = { id: 'a', highway: 'motorway_link', oneway: true,
    coordinates: [[103.9027, 1.35], [103.9032, 1.3498]] };
  const b = { id: 'b', highway: 'motorway_link', oneway: true,
    coordinates: [[103.9032, 1.3498], [103.9037, 1.3495]] };
  const graph = { links: [{ id: 'a', nextLinkIds: ['b'] }, { id: 'b', nextLinkIds: [] }],
    paths: [{ kind: 'leaving', fromRoadId: 'main', toRoadId: 'local', linkIds: ['a', 'b'],
      startCoordinate: a.coordinates[0], endCoordinate: b.coordinates[1] }] };
  const tracker = new Tracker({ roads: [main], rampGraph: graph }, { localRoads: [a, b] });
  start(tracker, main, 200);
  const first = tracker.update(at(a, 20, 2000));
  const next = tracker.update(at(b, 20, 5000));
  assert.equal(first.rampTransition.classification, 'leaving');
  assert.equal(next.rampTransition.classification, 'leaving');
  assert.equal(next.completedSession, null);
  assert.equal(tracker.recoveryCandidate.time, epoch + 2000);
});

test('same-reference transfer remains active and does not archive on ramp', () => {
  const a = { ...road, id: 'a', ref: 'PIE', routeNextRoadIds: [{ roadId: 'b', connectorIds: ['r'], lengthM: 111 }] };
  const b = { ...road, id: 'b', ref: 'PIE', coordinates: [[103.911, 1.35], [103.921, 1.35]] };
  const ramp = { id: 'r', highway: 'motorway_link', coordinates: [[103.91, 1.35], [103.911, 1.35]], lengthM: 111 };
  const graph = { links: [{ id: 'r', nextLinkIds: [] }], paths: [
    { kind: 'transfer', fromRoadId: 'a', toRoadId: 'b', linkIds: ['r'],
      startCoordinate: ramp.coordinates[0], endCoordinate: ramp.coordinates[1] }] };
  const tracker = new Tracker({ roads: [a, b], connectors: [ramp], rampGraph: graph });
  const started = start(tracker, a, 900);
  const onRamp = tracker.update(at(ramp, 30, 3000));
  assert.equal(onRamp.rampTransition.classification, 'transfer');
  const destination = tracker.update(at(b, 30, 5000));
  assert.equal(destination.sessionId, started.sessionId);
  assert.equal(destination.completedSession, null);
});

test('exit boundary estimate is withheld for long or inaccurate brackets', () => {
  const main = { ...road, id: 'main' };
  const ramp = { id: 'ramp', highway: 'motorway_link', oneway: true,
    coordinates: [[103.9027, 1.35], [103.9037, 1.3495]] };
  const graph = { links: [{ id: 'ramp', nextLinkIds: [] }], paths: [
    { kind: 'leaving', fromRoadId: 'main', toRoadId: 'street', linkIds: ['ramp'],
      startCoordinate: ramp.coordinates[0], endCoordinate: ramp.coordinates[1] }] };
  for (const [gap, priorAccuracy] of [[7000, 5], [1000, 40]]) {
    const tracker = new Tracker({ roads: [main], rampGraph: graph }, { localRoads: [ramp] });
    start(tracker, main, 150);
    tracker.update({ ...at(main, 200, 2000), accuracy: priorAccuracy });
    const state = tracker.update(at(ramp, 30, 2000 + gap));
    assert.notEqual(state.rampTransition?.boundary?.timing, 'estimated');
  }
});

test('visual road switches after two seconds; reliable local evidence ends session after twenty seconds', () => {
  const local = { id: 'street', name: 'Street', highway: 'residential', speedLimit: 40,
    coordinates: [[103.9, 1.349], [103.91, 1.349]] };
  const other = { id: 'other', name: 'Other Street', highway: 'residential', speedLimit: 30,
    coordinates: [[103.9, 1.348], [103.91, 1.348]] };
  const tracker = new Tracker({ roads: [road], localRoads: [local, other] });
  start(tracker, road);
  const live = tracker.update(at(road, 150, 2000));
  const candidate = tracker.update(at(local, 100, 3000));
  assert.equal(candidate.visualRoad.ref, 'TPE');
  const switched = tracker.update(at(local, 100, 5000));
  assert.equal(switched.visualRoad.name, 'Street');
  assert.equal(switched.visualLimitKmh, 40);
  assert.equal(switched.visualSpeedKmh, 72);
  assert.equal(switched.previousDelta.value, live.deltaSeconds);
  assert.equal(switched.previousDelta.expiresAt, undefined);
  tracker.update(at(other, 100, 6000));
  const changedAgain = tracker.update(at(other, 100, 8000));
  assert.ok(changedAgain.previousDelta);
  assert.ok(tracker.tick(epoch + 35000).previousDelta);
  assert.equal(tracker.tick(epoch + 35000).completedSession, null);
  let state;
  for (const ms of [10000, 15000, 20000, 25000, 30000, 35000])
    state = tracker.update(at(other, 100, ms));
  assert.equal(state.previousDelta, null);
  assert.equal(state.sessionId, null);
  assert.equal(state.completedSession.status, 'completed-local-evidence');
  assert.equal(state.completedSession.exitTime, null);
  assert.equal(state.completedSession.finalDeltaSeconds, null);
  assert.equal(tracker.gapAnchor, null);
});

test('GPS-only outage has no 30 second visual switch deadline', () => {
  const tracker = new Tracker({ roads: [road] });
  start(tracker, road);
  tracker.invalidate('Tunnel GPS loss');
  const later = tracker.tick(epoch + 300000);
  assert.equal(later.previousDelta, null);
  assert.ok(tracker.gapAnchor);
  assert.ok(tracker.sessionId);
});

test('local departure evidence pauses through invalid GPS and resumes only on new fixes', () => {
  const local = { id: 'side', name: 'Side Street', highway: 'residential',
    coordinates: [[103.9, 1.349], [103.91, 1.349]] };
  const tracker = new Tracker({ roads: [road], localRoads: [local] });
  start(tracker, road);
  tracker.update(at(road, 150, 2000));
  tracker.update(at(local, 100, 3000));
  tracker.update(at(local, 100, 5000));
  tracker.update(at(local, 100, 10000));
  assert.equal(tracker.localEvidenceMs, 5000);
  tracker.update({ ...at(local, 100, 11000), accuracy: 200 });
  tracker.tick(epoch + 300000);
  assert.equal(tracker.localEvidenceMs, 5000);
  tracker.update(at(local, 100, 301000));
  assert.equal(tracker.localEvidenceMs, 5000);
  tracker.update(at(local, 100, 306000));
  assert.equal(tracker.localEvidenceMs, 10000);
});

test('unproven local visual switch recovers original session after six seconds', () => {
  const local = { id: 'street', name: 'Street', highway: 'residential', speedLimit: 40,
    coordinates: [[103.9, 1.349], [103.91, 1.349]] };
  const tracker = new Tracker({ roads: [road], localRoads: [local] });
  const live = start(tracker, road);
  tracker.update(at(local, 100, 2000));
  tracker.update(at(local, 100, 4000));
  const held = tracker.update(at(local, 100, 10000));
  assert.equal(held.visualRoad.name, 'Street');
  assert.equal(held.completedSession, null);
  assert.ok(held.previousDelta);
  tracker.update(at(road, 200, 18000));
  const restored = tracker.update(at(road, 230, 19000));
  assert.equal(restored.status, 'tracking');
  assert.equal(restored.sessionId, live.sessionId);
  assert.equal(restored.entryTime, live.entryTime);
  assert.equal(restored.previousDelta, null);
  assert.equal(restored.visualRoad.ref, 'TPE');
});
