import test from 'node:test';
import assert from 'node:assert/strict';
import { MotionSmoothness } from './motion.js';

const fixed = (time, acceleration = [0, 0, 0], extra = {}) => ({
  time, acceleration, gravity: [0, 0, 9.81], rotation: [0, 0, 0],
  orientation: [0, 0, 0], speedKmh: 0, gpsFresh: true, ...extra,
});
const ready = (gravity = true) => {
  const motion = new MotionSmoothness();
  assert.equal(motion.calibrate().status, 'calibration');
  for (let time = 0; time <= 2000; time += 100)
    motion.update(fixed(time, gravity ? [0, 0, 0] : null));
  assert.equal(motion.status, 'ready');
  return motion;
};

test('requires an explicit parked calibration and never manufactures a vehicle forward axis', () => {
  const motion = new MotionSmoothness();
  assert.equal(motion.update(fixed(0)).status, 'unavailable');
  motion.calibrate();
  for (let time = 0; time < 2000; time += 100)
    assert.equal(motion.update(fixed(time, [0, 0, 0], { speedKmh: 40 })).status,
      'calibration');
  assert.equal(motion.update(fixed(2000, [0, 0, 0], { gpsFresh: false })).status,
    'calibration');
  for (let time = 2100; time <= 4100; time += 100) motion.update(fixed(time));
  assert.equal(motion.status, 'ready');
  assert.equal('forwardAxis' in motion.snapshot(), false);
});

test('explicit parked setup calibrates without a GPS speed, but fresh movement rejects it', () => {
  const underground = new MotionSmoothness();
  underground.calibrate();
  for (let time = 0; time <= 2000; time += 100)
    underground.update(fixed(time, [0, 0, 0],
      { parked: true, gpsFresh: false, speedKmh: null }));
  assert.equal(underground.status, 'ready');
  assert.equal(underground.snapshot().confidence, 'low');

  const unknownSpeed = new MotionSmoothness();
  unknownSpeed.calibrate();
  for (let time = 0; time <= 2000; time += 100)
    unknownSpeed.update(fixed(time, [0, 0, 0],
      { parked: true, gpsFresh: true, speedKmh: null }));
  assert.equal(unknownSpeed.status, 'ready');
  assert.equal(unknownSpeed.snapshot().confidence, 'medium');
  assert.equal(unknownSpeed.update(fixed(2100, [0, 0, 0],
    { parked: true, gpsFresh: true, speedKmh: null })).confidence, 'medium');

  const moving = new MotionSmoothness();
  moving.calibrate();
  for (let time = 0; time <= 2000; time += 100)
    moving.update(fixed(time, [0, 0, 0],
      { parked: true, gpsFresh: true, speedKmh: 12 }));
  assert.equal(moving.status, 'calibration');
});

test('quiet sensor noise stays neutral; sustained vertical bump rises then decays', () => {
  const motion = ready();
  for (let i = 0; i < 20; i++) {
    const state = motion.update(fixed(2100 + i * 100,
      [0.03 * (i % 3 - 1), -0.04 * (i % 2), 0.05 * (i % 3 - 1)],
      { speedKmh: 50 }));
    assert.equal(state.event, null);
    assert.equal(state.severity, 0);
  }
  const first = motion.update(fixed(4100, [0, 0, 4], { speedKmh: 50 }));
  assert.equal(first.event, null, 'single spike is not a confirmed event');
  const bump = motion.update(fixed(4200, [0, 0, 5], { speedKmh: 50 }));
  assert.equal(bump.event?.kind, 'vertical-bump');
  assert.ok(bump.severity > 0.3);
  assert.ok(bump.filteredAcceleration[2] > 2);
  assert.ok(bump.jerkMagnitude > 0);
  let decayed;
  for (let time = 4300; time <= 7200; time += 100)
    decayed = motion.update(fixed(time, [0, 0, 0], { speedKmh: 50 }));
  assert.equal(decayed.event, null);
  assert.ok(decayed.severity < bump.severity / 2);
});

test('abrupt lateral motion is generic and isolated extreme outliers are ignored', () => {
  const motion = ready();
  const outlier = motion.update(fixed(2100, [40, 0, 0], { speedKmh: 50 }));
  assert.equal(outlier.status, 'paused');
  assert.equal(outlier.reason, 'sensor-outlier');
  assert.equal(outlier.confidence, 'none');
  assert.equal(outlier.event, null);
  assert.equal(outlier.severity, 0);
  assert.equal(motion.update(fixed(2200, [0, 0, 0],
    { speedKmh: 50 })).status, 'paused');
  assert.equal(motion.update(fixed(2250, [0, 0, 0],
    { speedKmh: 50 })).status, 'ready');
  const first = motion.update(fixed(2300, [4, 0, 0], { speedKmh: 50 }));
  assert.equal(first.event, null);
  const second = motion.update(fixed(2400, [4, 0, 0], { speedKmh: 50 }));
  assert.equal(second.event?.kind, 'abrupt-motion');
  assert.ok(second.severity > 0);
  assert.equal(JSON.stringify(second).includes('braking'), false);
  assert.equal(JSON.stringify(second).includes('turning'), false);
});

test('gravity-inclusive fallback works, while missing gravity direction limits event label', () => {
  const motion = ready(false);
  const first = motion.update(fixed(2100, null, { gravity: [0, 0, 13.8], speedKmh: 50 }));
  assert.equal(first.event, null);
  const second = motion.update(fixed(2200, null, { gravity: [0, 0, 14.8], speedKmh: 50 }));
  assert.equal(second.diagnostic.source, 'gravity-compensated');
  assert.equal(second.event?.kind, 'vertical-bump');
  const noAxis = new MotionSmoothness();
  noAxis.calibrate();
  for (let time = 0; time <= 2000; time += 100)
    noAxis.update(fixed(time, [0, 0, 0], { gravity: null }));
  noAxis.update(fixed(2100, [0, 0, 4], { gravity: null, speedKmh: 50 }));
  const generic = noAxis.update(fixed(2200, [0, 0, 5],
    { gravity: null, speedKmh: 50 }));
  assert.equal(generic.event?.kind, 'abrupt-motion');
});

test('nearby sustained pulses merge into one event without a severity reset', () => {
  const motion = ready();
  motion.update(fixed(2100, [0, 0, 4], { speedKmh: 45 }));
  const first = motion.update(fixed(2200, [0, 0, 5], { speedKmh: 45 }));
  const startedAt = first.event.startedAt;
  motion.update(fixed(2300, [0, 0, 0], { speedKmh: 45 }));
  motion.update(fixed(2400, [0, 0, 4], { speedKmh: 45 }));
  const merged = motion.update(fixed(2500, [0, 0, 5], { speedKmh: 45 }));
  assert.equal(merged.event.startedAt, startedAt);
  assert.equal(merged.event.lastAt, 2500);
  assert.ok(merged.severity >= first.severity * .9);
});

test('irregular intervals, missing samples, and GPS loss preserve honest confidence', () => {
  const motion = ready();
  for (const time of [2080, 2210, 2450, 2560]) {
    const state = motion.update(fixed(time, [0.05, 0, 0], { speedKmh: 35 }));
    assert.equal(state.status, 'ready');
    assert.equal(state.event, null);
    assert.ok(Number.isFinite(state.jerkMagnitude));
  }
  const noGps = motion.update(fixed(2660, [0, 0, 0],
    { speedKmh: null, gpsFresh: false }));
  assert.equal(noGps.status, 'ready');
  assert.equal(noGps.confidence, 'low');
  const gap = motion.update(fixed(3300, [0, 0, 0], { speedKmh: 35 }));
  assert.equal(gap.status, 'paused');
  assert.equal(gap.severity, 0);
  const resumed = motion.update(fixed(3400, [0, 0, 0], { speedKmh: 35 }));
  assert.equal(resumed.status, 'ready');
  assert.equal(resumed.jerkMagnitude, null);
  assert.equal(resumed.event, null);
  const missing = motion.update(fixed(3500, null,
    { gravity: null, speedKmh: 35 }));
  assert.equal(missing.status, 'paused');
  const noTimestamp = motion.update({ ...fixed(3600), time: null });
  assert.equal(noTimestamp.status, 'paused');
});

test('phone rotation, orientation change, and parked handling latch neutral until recalibration', () => {
  for (const changed of [
    { rotation: [60, 0, 0] },
    { orientation: [0, 90, 0] },
    { acceleration: [3, 0, 0] },
  ]) {
    const motion = ready();
    const held = motion.update(fixed(2100, [0, 0, 0], changed));
    assert.equal(held.status, 'paused');
    assert.equal(held.reason, 'mount-moved');
    assert.equal(held.severity, 0);
    assert.equal(held.confidence, 'none');
    assert.equal(motion.update(fixed(2200)).status, 'paused');
    assert.equal(motion.calibrate().status, 'calibration');
  }
  const fixedMount = ready();
  assert.equal(fixedMount.update(fixed(2100, [0, 0, 0],
    { orientation: [90, 0, 0], speedKmh: 35 })).status, 'ready',
    'vehicle heading change alone is not phone handling');
});

test('gravity-only mount shift pauses before false jerk and latches after a stable rotation', () => {
  const motion = ready(false);
  const rotated = [4.905, 0, 8.496];
  for (const [time, reason] of [[2100, 'gravity-axis-uncertain'],
    [2200, 'gravity-axis-uncertain'], [2300, 'mount-moved']]) {
    const state = motion.update(fixed(time, null,
      { gravity: rotated, rotation: null, orientation: null, speedKmh: 40 }));
    assert.equal(state.status, 'paused');
    assert.equal(state.reason, reason);
    assert.equal(state.event, null);
    assert.equal(state.severity, 0);
    assert.equal(state.jerkMagnitude, null);
  }
  assert.equal(motion.update(fixed(2400, null,
    { rotation: null, orientation: null, speedKmh: 40 })).reason, 'mount-moved');
  assert.equal(motion.calibrate().status, 'calibration');

  const transient = ready(false);
  assert.equal(transient.update(fixed(2100, null,
    { gravity: rotated, rotation: null, orientation: null, speedKmh: 40 })).status,
  'paused');
  transient.update(fixed(2200, null,
    { rotation: null, orientation: null, speedKmh: 40 }));
  const resumed = transient.update(fixed(2300, null,
    { rotation: null, orientation: null, speedKmh: 40 }));
  assert.equal(resumed.status, 'ready');
  assert.equal(resumed.event, null);
  assert.equal(resumed.jerkMagnitude, null);
});
