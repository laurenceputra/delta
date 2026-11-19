import test from 'node:test';
import assert from 'node:assert/strict';
import { MotionSmoothness, SpillRisk } from './motion.js';

const fixed = (time, extra = {}) => ({ time, acceleration: [0, 0, 0],
  gravity: [0, 0, 9.81], rotation: [0, 0, 0], orientation: null,
  speedKmh: 0, gpsFresh: true, ...extra });
const ready = (extra = {}) => {
  const motion = new MotionSmoothness();
  motion.calibrate();
  for (let time = -1000; time <= 2000; time += 100)
    motion.update(fixed(time, extra));
  assert.equal(motion.status, 'ready');
  return motion;
};

test('rolling warmup works while moving and tolerates isolated spikes', () => {
  const motion = new MotionSmoothness();
  assert.equal(motion.update(fixed(0)).status, 'unavailable');
  assert.equal(motion.calibrate().reason, 'warming-up');
  for (let time = 0; time <= 3000; time += 100) {
    const state = motion.update(fixed(time, { speedKmh: 55,
      acceleration: time === 1200 ? [48, 0, 0] : [0.8, 0, 0],
      gravity: time === 1200 ? [48, 0, 9.81] : [0.8, 0, 9.81] }));
    if (time < 3000) assert.equal(state.status, 'calibration');
  }
  assert.equal(motion.status, 'ready');
  assert.equal(motion.snapshot().diagnostic.transition.kind, 'warmup-complete');
  assert.equal('forwardAxis' in motion.snapshot(), false);
});

test('warmup needs usable sensor quality and derives gravity without erasing car acceleration', () => {
  const motion = new MotionSmoothness();
  motion.calibrate();
  for (let time = 0; time <= 3200; time += 100)
    motion.update(fixed(time, { acceleration: null, gravity: null,
      speedKmh: 45 }));
  assert.equal(motion.status, 'calibration');
  for (let time = 3300; time <= 6400; time += 100)
    motion.update(fixed(time, { acceleration: [1.2, 0, 0],
      gravity: [1.2, 0, 9.81], speedKmh: 45 }));
  assert.equal(motion.status, 'ready');
  assert.ok(Math.abs(motion.gravityBaseline[0]) < 0.01);
  const state = motion.update(fixed(6500, { acceleration: [1.2, 0, 0],
    gravity: [1.2, 0, 9.81], speedKmh: 45 }));
  assert.ok(state.accelerationMagnitude > 0.5);
  assert.ok(state.diagnostic.gravityAngleDeg < 1);
});

test('stationary unknown GPS speed warms up with low or medium confidence', () => {
  for (const [gpsFresh, confidence] of [[false, 'low'], [true, 'medium']]) {
    const motion = new MotionSmoothness();
    motion.calibrate();
    for (let time = 0; time <= 3000; time += 100)
      motion.update(fixed(time, { parked: true, gpsFresh, speedKmh: null }));
    assert.equal(motion.status, 'ready');
    assert.equal(motion.snapshot().confidence, confidence);
  }
});

test('quiet noise and vertical bumps do not raise the live border', () => {
  const motion = ready();
  for (let time = 2100; time <= 4000; time += 100) {
    const state = motion.update(fixed(time,
      { acceleration: [0.03, 0, 0.05] }));
    assert.equal(state.event, null);
    assert.equal(state.severity, 0);
  }
  assert.equal(motion.update(fixed(4100,
    { acceleration: [0, 0, 4], speedKmh: 50 })).event, null);
  const bump = motion.update(fixed(4200,
    { acceleration: [0, 0, 5], speedKmh: 50 }));
  assert.equal(bump.event?.kind, 'vertical-bump');
  assert.equal(bump.severity, 0);
  let decayed;
  for (let time = 4300; time <= 7200; time += 100)
    decayed = motion.update(fixed(time, { speedKmh: 50 }));
  assert.equal(decayed.event, null);
  assert.equal(decayed.severity, 0);
});

test('extreme outlier pauses neutral then two clean samples resume', () => {
  const motion = ready();
  const outlier = motion.update(fixed(2100,
    { acceleration: [40, 0, 0], speedKmh: 50 }));
  assert.equal(outlier.status, 'paused');
  assert.equal(outlier.reason, 'sensor-outlier');
  assert.equal(outlier.severity, 0);
  assert.equal(outlier.confidence, 'none');
  assert.equal(motion.update(fixed(2200)).status, 'paused');
  const resumed = motion.update(fixed(2300));
  assert.equal(resumed.status, 'ready');
  assert.equal(resumed.jerkMagnitude, null);
});

test('a single shock stays quiet and sustained lateral motion stays generic without an axis', () => {
  const motion = ready();
  const shock = motion.update(fixed(2100, { acceleration: [8, 0, 0], gravity: [8, 0, 9.81], speedKmh: 45 }));
  assert.equal(shock.severity, 0);
  for (let time = 2200; time <= 2600; time += 100) motion.update(fixed(time));
  let sustained;
  for (let time = 2700; time <= 3400; time += 100)
    sustained = motion.update(fixed(time, { acceleration: [4, 0, 0], gravity: [4, 0, 9.81], speedKmh: 45 }));
  assert.equal(sustained.event?.kind, 'abrupt-motion');
  assert.ok(sustained.severity > 0.4);
  assert.equal(sustained.diagnostic.axisConfidence, 'unknown');
});

test('gyro yaw around gravity does not imply handling', () => {
  const motion = ready();
  for (let time = 2100; time <= 2700; time += 100) {
    const state = motion.update(fixed(time,
      { rotation: [100, 2, 1], speedKmh: 45 }));
    assert.equal(state.status, 'ready');
    assert.ok(state.diagnostic.tiltRateDegS < 12);
  }
});

test('single transverse gyro spike does not pause and stability checks need sustained evidence', () => {
  const motion = ready();
  const spike = motion.update(fixed(2100,
    { rotation: [0, 80, 0], speedKmh: 45 }));
  assert.equal(spike.status, 'ready');
  assert.equal(motion.update(fixed(2200, { speedKmh: 45 })).status, 'ready');
});

test('sustained transverse gyro tilt checks stability and recovers after one second', () => {
  const motion = ready();
  for (let time = 2100; time <= 2400; time += 100)
    motion.update(fixed(time, { rotation: [1, 45, 0], speedKmh: 45 }));
  assert.equal(motion.status, 'paused');
  assert.equal(motion.reason, 'checking-stability');
  assert.equal(motion.snapshot().diagnostic.transition.cause, 'sustained-tilt');
  assert.ok(motion.snapshot().diagnostic.transition.durationMs >= 250);
  for (let time = 2500; time <= 3500; time += 100)
    motion.update(fixed(time, { speedKmh: 45 }));
  assert.equal(motion.status, 'ready');
  assert.equal(motion.snapshot().diagnostic.transition.kind, 'stability-recovered');
});

test('a gap during stability checking restarts the full stable interval', () => {
  const motion = ready();
  for (let time = 2100; time <= 2400; time += 100)
    motion.update(fixed(time, { rotation: [0, 45, 0], speedKmh: 45 }));
  for (let time = 2500; time <= 3000; time += 100)
    motion.update(fixed(time, { speedKmh: 45 }));
  assert.equal(motion.status, 'paused');
  assert.equal(motion.update(fixed(3700, { speedKmh: 45 })).status, 'paused');
  for (let time = 3800; time < 4700; time += 100)
    assert.equal(motion.update(fixed(time, { speedKmh: 45 })).status, 'paused');
  assert.equal(motion.update(fixed(4700, { speedKmh: 45 })).status, 'ready');
});

test('persistent shifted mount requires explicit setup even when parked is declared', () => {
  const motion = ready();
  const shifted = [4, 0, 8.95];
  for (let time = 2100; time <= 4500; time += 100)
    motion.update(fixed(time, { gravity: shifted, parked: true }));
  assert.equal(motion.status, 'paused');
  assert.equal(motion.reason, 'needs-calibration');
  assert.equal(motion.snapshot().severity, 0);
  assert.equal(motion.snapshot().diagnostic.transition.kind, 'setup-required');
  assert.ok(motion.snapshot().diagnostic.transition.durationMs >= 2000);
  for (let time = 4600; time <= 7000; time += 100)
    assert.equal(motion.update(fixed(time, { parked: true })).reason,
      'needs-calibration');
  assert.equal(motion.calibrate().status, 'calibration');
});

test('gravity-only transient shift pauses before false jerk, then auto recovers', () => {
  const motion = ready({ acceleration: null });
  const shifted = [4, 0, 8.95];
  for (let time = 2100; time <= 2400; time += 100)
    motion.update(fixed(time, { acceleration: null, gravity: shifted,
      rotation: null, speedKmh: 40 }));
  assert.equal(motion.status, 'paused');
  assert.equal(motion.reason, 'checking-stability');
  assert.equal(motion.snapshot().severity, 0);
  for (let time = 2500; time <= 3500; time += 100)
    motion.update(fixed(time, { acceleration: null, rotation: null, speedKmh: 40 }));
  assert.equal(motion.status, 'ready');
  assert.equal(motion.snapshot().event, null);
});

test('gaps pause; GPS loss lowers confidence without stopping motion', () => {
  const motion = ready();
  const noGps = motion.update(fixed(2100,
    { gpsFresh: false, speedKmh: null }));
  assert.equal(noGps.status, 'ready');
  assert.equal(noGps.confidence, 'low');
  assert.equal(motion.update(fixed(2800)).status, 'paused');
  assert.equal(motion.update(fixed(2900)).status, 'ready');
  assert.equal(motion.update(fixed(3000)).status, 'ready');
  assert.equal(motion.update(fixed(3100,
    { acceleration: null, gravity: null })).status, 'paused');
});

test('straight acceleration and braking establish an axis which expires without GPS', () => {
  const motion = ready();
  let speed = 12;
  let fix = { timestamp: 2000, speed, accuracy: 5, heading: 90 };
  let result;
  for (let time = 2100; time <= 8000; time += 100) {
    const acceleration = time <= 5000 ? 2 : -2;
    if (time % 1000 === 0) {
      speed += acceleration;
      fix = { ...fix, timestamp: time, speed };
    }
    result = motion.update(fixed(time, { acceleration: [acceleration, 0, 0],
      gravity: [acceleration, 0, 9.81], gpsFix: fix, speedKmh: speed * 3.6 }));
  }
  assert.equal(result.diagnostic.axisConfidence, 'estimated');
  assert.equal(result.event?.kind, 'sharp-braking');
  for (let time = 8100; time <= 38100; time += 100)
    result = motion.update(fixed(time, { gpsFresh: false }));
  assert.equal(result.diagnostic.axisConfidence, 'unknown');
});

test('spill colour requires 300 ms at each threshold and clears after a gap', () => {
  const model = new SpillRisk();
  const levels = [[0,.12,0],[100,.28,0],[200,.28,0],[300,.29,1],[400,.29,2],
    [500,.38,2],[600,.38,2],[700,.38,2],[800,.38,3],[900,.29,2],[1200,.38,0]];
  for (const [time, force, expected] of levels)
    assert.equal(model.update(time, force * 9.80665), expected, `spill level at ${time} ms`);
});
