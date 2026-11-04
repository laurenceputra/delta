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

test('matches direction using heading and reports three upcoming exits', () => {
  const tracker = new Tracker({ roads: [road, west] });
  const state = tracker.update(at(road, 100, 1000));
  assert.equal(state.road.direction, 'Eastbound');
  assert.deepEqual(state.exits.map(e => e.name), ['Exit 1', 'Exit 2', 'Exit 3']);
  assert.ok(Math.abs(state.exits[0].distanceM - 200) < 2);
  assert.equal(state.exits[0].forecast, true);
  assert.ok(roadLengthM(road) > 1100);
});

test('delta starts at detection, grows while stopped, and exit forecast uses current speed', () => {
  const tracker = new Tracker({ roads: [road] });
  assert.equal(tracker.update(at(road, 100, 1000)).deltaSeconds, 0);
  const moving = tracker.update(at(road, 300, 11000, 20));
  assert.ok(Math.abs(moving.deltaSeconds - 2) < 0.2);
  assert.ok(moving.exits[0].projectedDeltaSeconds > moving.deltaSeconds);
  const stopped = tracker.update(at(road, 300, 16000, 0));
  assert.ok(Math.abs(stopped.deltaSeconds - 7) < 0.2);
  assert.equal(stopped.exits[0].projectedDeltaSeconds, null);
});

test('unknown speed limit makes comparison unavailable', () => {
  const tracker = new Tracker({ roads: [{ ...road, speedLimit: null }] });
  tracker.update(at(road, 100, 1000));
  const state = tracker.update(at(road, 200, 6000));
  assert.equal(state.limitKmh, null);
  assert.equal(state.deltaSeconds, null);
  assert.equal(state.exits[0].projectedDeltaSeconds, null);
});

test('bad fix and long GPS gap invalidate accumulated delta', () => {
  const tracker = new Tracker({ roads: [road] });
  tracker.update(at(road, 100, 1000));
  assert.ok(tracker.update(at(road, 150, 6000)).deltaSeconds !== 0);
  assert.equal(tracker.update({ ...at(road, 160, 7000), accuracy: 200 }).status, 'stale');
  assert.equal(tracker.update(at(road, 170, 8000)).deltaSeconds, 0);
  assert.equal(tracker.update(at(road, 180, 30000)).deltaSeconds, 0);
});

test('tunnel reduces confidence', () => {
  const tracker = new Tracker({ roads: [{ ...road, tunnels: [{ fromM: 50, toM: 150 }] }] });
  const state = tracker.update(at(road, 100, 1000));
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
  const state = tracker.update(at(road, 100, 1000));
  assert.equal(state.confidence, 'low');
  assert.equal(state.exits[0].name, 'Unnamed exit');
});
