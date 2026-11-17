// Advisory motion smoothness only. Device axes are not vehicle axes; this module
// cannot identify braking or turning without a separately established heading.
const magnitude = vector => Math.hypot(...vector);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const clamp = value => Math.min(1, Math.max(0, value));
const vector3 = value => {
  const values = Array.isArray(value) ? value : value &&
    [value.x ?? value.alpha, value.y ?? value.beta, value.z ?? value.gamma];
  return values?.length === 3 && values.every(Number.isFinite) ? values : null;
};
const angle = (a, b) => {
  const denominator = magnitude(a) * magnitude(b);
  return denominator > 0 ? Math.acos(Math.max(-1, Math.min(1, dot(a, b) / denominator))) * 180 / Math.PI : null;
};
const orientationDifference = (a, b, ignoreYaw = false) => a && b ?
  Math.max(...a.map((value, i) => ignoreYaw && i === 0 ? 0 :
    Math.abs(((value - b[i] + 540) % 360) - 180))) : null;
const rounded = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
const roundedVector = value => value?.map(rounded) || null;

export class MotionSmoothness {
  constructor() { this.reset(); }

  reset() {
    this.status = 'unavailable';
    this.reason = 'needs-calibration';
    this.gravityBaseline = null;
    this.orientationBaseline = null;
    this.calibration = null;
    this.lastTime = null;
    this.filtered = null;
    this.jerk = null;
    this.severity = 0;
    this.candidate = null;
    this.event = null;
    this.resumeSamples = 0;
    this.gravityShift = null;
    return this.snapshot();
  }

  calibrate() {
    this.reset();
    this.status = 'calibration';
    this.reason = 'park-and-hold-still';
    return this.snapshot();
  }

  snapshot(extra = {}) {
    return { status: this.status, reason: this.reason,
      severity: this.status === 'ready' ? rounded(this.severity) : 0,
      confidence: this.status === 'ready' ? this.confidence : 'none',
      filteredAcceleration: this.status === 'ready' ? roundedVector(this.filtered) : null,
      jerk: this.status === 'ready' ? roundedVector(this.jerk) : null,
      accelerationMagnitude: this.status === 'ready' && this.filtered ?
        rounded(magnitude(this.filtered)) : null,
      jerkMagnitude: this.status === 'ready' && this.jerk ?
        rounded(magnitude(this.jerk)) : null,
      event: this.status === 'ready' && this.event ? { ...this.event,
        peakSeverity: rounded(this.event.peakSeverity) } : null,
      diagnostic: { source: null, dtMs: null, rawAcceleration: null,
        rotationMagnitude: null, gravityAngleDeg: null, ...extra } };
  }

  update(input = {}) {
    const time = input.time == null ? NaN : Number(input.time);
    const acceleration = vector3(input.acceleration);
    const includingGravity = vector3(input.gravity);
    const rotation = vector3(input.rotation);
    const orientation = vector3(input.orientation);
    const speedKmh = input.speedKmh == null ? NaN : Number(input.speedKmh);
    const gpsFresh = input.gpsFresh === true;
    const freshMoving = gpsFresh && Number.isFinite(speedKmh) && speedKmh > 3;
    const parkedDeclaration = input.parked === true && !freshMoving;
    const rotationMagnitude = rotation ? magnitude(rotation) : null;
    const gravityAngleDeg = includingGravity && this.gravityBaseline ?
      angle(includingGravity, this.gravityBaseline) : null;
    const source = acceleration ? 'linear' : includingGravity ? 'gravity-compensated' : null;
    const raw = acceleration || includingGravity && this.gravityBaseline &&
      includingGravity.map((value, i) => value - this.gravityBaseline[i]);
    const diagnostic = { source, rawAcceleration: roundedVector(raw),
      rotationMagnitude: rounded(rotationMagnitude), gravityAngleDeg: rounded(gravityAngleDeg) };

    if (this.status === 'unavailable') return this.snapshot(diagnostic);
    if (!Number.isFinite(time)) {
      if (this.status !== 'calibration') this.pause('sensor-gap');
      return this.snapshot(diagnostic);
    }
    const dtMs = this.lastTime == null ? null : time - this.lastTime;
    diagnostic.dtMs = rounded(dtMs);
    if (dtMs != null && (dtMs <= 0 || dtMs > 500)) {
      if (this.status === 'calibration') this.calibration = null;
      else this.pause('sensor-gap');
    }
    this.lastTime = time;
    if (this.status === 'calibration')
      return this.updateCalibration({ time, acceleration, includingGravity, rotationMagnitude,
        orientation, speedKmh, gpsFresh, parkedDeclaration, diagnostic });
    if (this.reason === 'mount-moved') return this.snapshot(diagnostic);
    if (!raw) {
      this.pause('sensor-gap');
      return this.snapshot(diagnostic);
    }
    const mountRotation = rotationMagnitude != null && rotationMagnitude > 40;
    // Compass yaw changes with the car's heading even when the phone is fixed.
    const mountOrientation = orientationDifference(orientation, this.orientationBaseline, true);
    const stationaryHandling = (parkedDeclaration || gpsFresh &&
      Number.isFinite(speedKmh) && speedKmh <= 3) && magnitude(raw) > 1.8;
    if (mountRotation || mountOrientation != null && mountOrientation > 15 ||
        stationaryHandling) {
      this.pause('mount-moved');
      return this.snapshot(diagnostic);
    }
    const gravityShift = source === 'gravity-compensated' && !rotation && !orientation &&
      gravityAngleDeg != null && gravityAngleDeg > 25 &&
      magnitude(includingGravity) >= 7.5 && magnitude(includingGravity) <= 11.5;
    if (gravityShift) {
      const prior = this.gravityShift;
      this.gravityShift = prior && time - prior.time <= 350 &&
        angle(includingGravity, prior.vector) <= 8 ?
        { count: prior.count + 1, time, vector: includingGravity } :
        { count: 1, time, vector: includingGravity };
      this.pause(this.gravityShift.count >= 3 ? 'mount-moved' : 'gravity-axis-uncertain');
      return this.snapshot(diagnostic);
    }
    this.gravityShift = null;
    if (magnitude(raw) > 30) {
      this.pause('sensor-outlier');
      return this.snapshot(diagnostic);
    }
    let justResumed = false;
    if (this.status === 'paused') {
      this.resumeSamples++;
      this.filtered = [...raw];
      this.jerk = null;
      if (this.resumeSamples < 2) return this.snapshot(diagnostic);
      this.status = 'ready';
      this.reason = null;
      this.severity = 0;
      this.event = null;
      this.candidate = null;
      justResumed = true;
    }
    this.confidence = !gpsFresh ? 'low' : !Number.isFinite(speedKmh) ||
      source === 'gravity-compensated' || !rotation && !orientation ? 'medium' : 'high';
    this.reason = null;
    const previous = justResumed ? null : this.filtered;
    const dt = Math.max(0.02, (dtMs || 100) / 1000);
    const alpha = 1 - Math.exp(-dt / 0.12);
    this.filtered = previous ? previous.map((value, i) => value + alpha * (raw[i] - value)) : [...raw];
    this.jerk = previous && dtMs != null && dtMs <= 500 ?
      this.filtered.map((value, i) => (value - previous[i]) / dt) : null;
    this.severity *= Math.exp(-dt / 2.4);
    if (this.event && time - this.event.lastAt > 450) this.event = null;
    const accelerationMagnitude = magnitude(this.filtered);
    const jerkMagnitude = this.jerk ? magnitude(this.jerk) : 0;
    const active = accelerationMagnitude > 1.1 || jerkMagnitude > 3.5;
    if (active) {
      const intensity = clamp(Math.max((accelerationMagnitude - 0.5) / 4,
        (jerkMagnitude - 2) / 18));
      if (!this.candidate || time - this.candidate.lastAt > 300)
        this.candidate = { since: time, lastAt: time, count: 1, peak: intensity };
      else {
        this.candidate.count++;
        this.candidate.lastAt = time;
        this.candidate.peak = Math.max(this.candidate.peak, intensity);
      }
      if (this.candidate.count >= 2 && time - this.candidate.since >= 60) {
        const vertical = this.gravityBaseline && accelerationMagnitude > 0.9 &&
          Math.abs(dot(this.filtered, this.gravityBaseline)) /
            (accelerationMagnitude * magnitude(this.gravityBaseline)) >= 0.65;
        const kind = vertical ? 'vertical-bump' : 'abrupt-motion';
        if (this.event && time - this.event.lastAt <= 450) {
          this.event.lastAt = time;
          this.event.peakSeverity = Math.max(this.event.peakSeverity, this.candidate.peak);
          if (vertical) this.event.kind = kind;
        } else this.event = { kind, startedAt: this.candidate.since,
          lastAt: time, peakSeverity: this.candidate.peak };
        this.severity = Math.max(this.severity, this.event.peakSeverity);
      }
    } else this.candidate = null;
    return this.snapshot(diagnostic);
  }

  updateCalibration({ time, acceleration, includingGravity, rotationMagnitude,
    orientation, speedKmh, gpsFresh, parkedDeclaration, diagnostic }) {
    const parked = parkedDeclaration || gpsFresh && Number.isFinite(speedKmh) && speedKmh <= 3;
    const gravityValid = !includingGravity || magnitude(includingGravity) >= 7.5 &&
      magnitude(includingGravity) <= 11.5;
    const still = parked && gravityValid && !!(acceleration || includingGravity) &&
      (!acceleration || magnitude(acceleration) <= 0.35) &&
      (rotationMagnitude == null || rotationMagnitude <= 8);
    if (!still) {
      this.calibration = null;
      this.reason = parked ? 'hold-still' : 'park-and-hold-still';
      return this.snapshot(diagnostic);
    }
    const prior = this.calibration;
    if (!prior || prior.gravity && includingGravity && angle(prior.gravity,
        includingGravity) > 6 || orientationDifference(orientation, prior?.orientation) > 5) {
      this.calibration = { since: time, count: 1,
        gravity: includingGravity && [...includingGravity], orientation };
      this.reason = 'calibrating';
      return this.snapshot(diagnostic);
    }
    prior.count++;
    if (includingGravity) prior.gravity = prior.gravity ? prior.gravity.map((value, i) =>
      value + (includingGravity[i] - value) / prior.count) : [...includingGravity];
    if (time - prior.since < 1800 || prior.count < 8) {
      this.reason = 'calibrating';
      return this.snapshot(diagnostic);
    }
    this.gravityBaseline = prior.gravity;
    this.orientationBaseline = prior.orientation;
    this.status = 'ready';
    this.reason = null;
    this.confidence = !gpsFresh ? 'low' : this.gravityBaseline &&
      Number.isFinite(speedKmh) && (rotationMagnitude != null || orientation) ?
      'high' : 'medium';
    this.filtered = [0, 0, 0];
    this.jerk = null;
    this.calibration = null;
    return this.snapshot(diagnostic);
  }

  pause(reason) {
    this.status = 'paused';
    this.reason = reason;
    this.filtered = null;
    this.jerk = null;
    this.candidate = null;
    this.event = null;
    this.severity = 0;
    this.resumeSamples = 0;
  }
}
