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
  assert.equal(tracker.update(at(r, metres, 0)).status, 'identifying');
  return tracker.update(at(r, metres, 1000));
};

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
  assert.equal(start(tracker, road).deltaSeconds, 0);
  const moving = tracker.update(at(road, 300, 11000, 20));
  assert.ok(Math.abs(moving.deltaSeconds - 2) < 0.2);
  assert.ok(moving.exits[0].projectedDeltaSeconds > moving.deltaSeconds);
  const stopped = tracker.update(at(road, 300, 16000, 0));
  assert.ok(Math.abs(stopped.deltaSeconds - 7) < 0.2);
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
  assert.equal(tracker.update(at(road, 170, 8000)).status, 'identifying');
  assert.equal(tracker.update(at(road, 170, 9000)).deltaSeconds, 0);
  assert.equal(tracker.update(at(road, 180, 30000)).deltaSeconds, 0);
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
  assert.equal(tracker.update({ ...rampFix, timestamp: epoch + 3000 }).status, 'local');
  const main = at(road, 200, 4000);
  const entering = tracker.update(main);
  assert.equal(entering.status, 'entering');
  assert.equal(entering.deltaSeconds, null);
  assert.deepEqual(entering.exits, []);
  assert.equal(tracker.update({ ...main, timestamp: epoch + 5000 }).status, 'tracking');
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
