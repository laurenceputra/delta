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
const rounded = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
const roundedVector = value => value?.map(rounded) || null;
const subtract = (a, b) => a.map((value, i) => value - b[i]);
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const robustVector = samples => [0, 1, 2].map(i => median(samples.map(value => value[i])));
// DeviceMotion's alpha/beta/gamma axes correspond to device z/x/y.
const tiltRate = (rotation, gravity) => {
  if (!rotation || !gravity) return null;
  const cartesian = [rotation[1], rotation[2], rotation[0]];
  const alongGravity = dot(cartesian, gravity) / magnitude(gravity);
  return Math.sqrt(Math.max(0, magnitude(cartesian) ** 2 - alongGravity ** 2));
};

const SPILL_THRESHOLDS_G = [0.10, 0.8 / 3, 1 / 3];

const SPILL_HOLD_MS = [300, 200, 150];

export class SpillRisk {
  reset() {
    this.since = SPILL_THRESHOLDS_G.map(() => null);
    this.level = 0;
    this.belowSince = null;
    this.unevenUntil = null;
    this.lastTime = null;
  }

  constructor() { this.reset(); }

  update(time, horizontalMps2) {
    if (!Number.isFinite(horizontalMps2)) { this.reset(); return 0; }
    if (this.lastTime != null && time - this.lastTime > 250) this.reset();
    this.lastTime = time;
    let level = 0;
    for (const [index, threshold] of SPILL_THRESHOLDS_G.entries()) {
      if (!(horizontalMps2 / 9.80665 >= threshold)) this.since[index] = null;
      else {
        this.since[index] ??= time;
        if (time - this.since[index] >= SPILL_HOLD_MS[index]) level = index + 1;
      }
    }
    if (level >= 2) this.unevenUntil = time + 5000;
    if (level >= this.level) {
      this.level = level;
      this.belowSince = null;
    } else {
      if (horizontalMps2 / 9.80665 >= SPILL_THRESHOLDS_G[this.level - 1]) {
        this.belowSince = null;
        return this.level;
      }
      this.belowSince ??= time;
      if (time - this.belowSince >= 250) {
        this.level = level;
        this.belowSince = null;
      }
    }
    return this.level;
  }
}

export class MotionSmoothness {
  constructor() { this.reset(); }

  reset() {
    this.spillRisk = new SpillRisk();
    this.spillLevel = 0;
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
    this.tiltCandidate = null;
    this.stableSince = null;
    this.transition = null;
    this.forwardAxis = null;
    this.axisEvidence = [];
    this.axisFix = null;
    this.lastAxisAt = null;
    return this.snapshot();
  }

  calibrate() {
    this.reset();
    this.status = 'calibration';
    this.reason = 'warming-up';
    return this.snapshot();
  }

  snapshot(extra = {}) {
    return { status: this.status, reason: this.reason, spillLevel: this.spillLevel,
      unevenUntil: this.spillRisk.unevenUntil,
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
        rotationMagnitude: null, gravityAngleDeg: null, tiltRateDegS: null,
        transition: this.transition, ...extra } };
  }

  update(input = {}) {
    const time = input.time == null ? NaN : Number(input.time);
    const acceleration = vector3(input.acceleration);
    const includingGravity = vector3(input.gravity);
    const rotation = vector3(input.rotation);
    const orientation = vector3(input.orientation);
    const speedKmh = input.speedKmh == null ? NaN : Number(input.speedKmh);
    const gpsFresh = input.gpsFresh === true;
    const rotationMagnitude = rotation ? magnitude(rotation) : null;
    const gravityAngleDeg = includingGravity && this.gravityBaseline ?
      angle(acceleration ? subtract(includingGravity, acceleration) : includingGravity,
        this.gravityBaseline) : null;
    const gravityEstimate = includingGravity && acceleration ?
      subtract(includingGravity, acceleration) : includingGravity;
    const tiltRateDegS = tiltRate(rotation, gravityEstimate || this.gravityBaseline);
    const source = acceleration ? 'linear' : includingGravity ? 'gravity-compensated' : null;
    const raw = acceleration || includingGravity && this.gravityBaseline &&
      includingGravity.map((value, i) => value - this.gravityBaseline[i]);
    const diagnostic = { source, rawAcceleration: roundedVector(raw),
      rotationMagnitude: rounded(rotationMagnitude), gravityAngleDeg: rounded(gravityAngleDeg),
      tiltRateDegS: rounded(tiltRateDegS) };

    if (this.status === 'unavailable' || this.reason === 'needs-calibration')
      return this.snapshot(diagnostic);
    if (!Number.isFinite(time)) {
      if (this.status !== 'calibration') this.pause('sensor-gap');
      return this.snapshot(diagnostic);
    }
    const dtMs = this.lastTime == null ? null : time - this.lastTime;
    diagnostic.dtMs = rounded(dtMs);
    if (dtMs != null && (dtMs <= 0 || dtMs > 500)) {
      if (this.status === 'calibration') this.calibration = [];
      else if (this.reason === 'checking-stability') this.stableSince = null;
      else this.pause('sensor-gap');
    }
    this.lastTime = time;
    if (this.status === 'calibration')
      return this.updateCalibration({ time, acceleration, includingGravity, gravityEstimate,
        rotationMagnitude, orientation, speedKmh, gpsFresh, diagnostic });
    if (!raw) {
      if (this.reason === 'checking-stability') this.stableSince = null;
      else this.pause('sensor-gap');
      return this.snapshot(diagnostic);
    }
    // A high angular rate is handling only when sustained and transverse to gravity.
    if (tiltRateDegS != null && tiltRateDegS > 30) {
      this.tiltCandidate ??= time;
      if (time - this.tiltCandidate >= 250 && this.status !== 'paused')
        this.enterStabilityCheck(time, diagnostic, 'sustained-tilt');
    } else this.tiltCandidate = null;
    const gravityShift = gravityAngleDeg != null && gravityAngleDeg > 15 &&
      gravityEstimate && magnitude(gravityEstimate) >= 7.5 &&
      magnitude(gravityEstimate) <= 11.5;
    if (gravityShift) {
      this.gravityShift ??= { since: time, samples: [] };
      this.gravityShift.samples.push([...gravityEstimate]);
      if (this.gravityShift.samples.length > 40) this.gravityShift.samples.shift();
      if (this.status !== 'paused' && time - this.gravityShift.since >= 250)
        this.enterStabilityCheck(time, diagnostic, 'gravity-shift');
    } else this.gravityShift = null;
    if (this.reason === 'checking-stability') {
      const stable = gravityAngleDeg != null && gravityAngleDeg <= 8 &&
        (tiltRateDegS == null || tiltRateDegS < 12) && magnitude(raw) < 30;
      this.stableSince = stable ? this.stableSince ?? time : null;
      if (stable && time - this.stableSince >= 1000) {
        this.status = 'ready';
        this.reason = null;
        this.filtered = null;
        this.jerk = null;
        this.transition = { at: time, kind: 'stability-recovered',
          gravityAngleDeg: rounded(gravityAngleDeg), tiltRateDegS: rounded(tiltRateDegS) };
      } else if (this.gravityShift && time - this.gravityShift.since >= 2000 &&
          magnitude(raw) < 0.5 && (rotationMagnitude == null || rotationMagnitude < 8)) {
        const durationMs = time - this.gravityShift.since;
        this.pause('needs-calibration');
        this.transition = { at: time, kind: 'setup-required', durationMs,
          gravityAngleDeg: rounded(gravityAngleDeg), tiltRateDegS: rounded(tiltRateDegS) };
        return this.snapshot(diagnostic);
      } else return this.snapshot(diagnostic);
    }
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
    const alpha = 1 - Math.exp(-dt / 0.32);
    this.filtered = previous ? previous.map((value, i) => value + alpha * (raw[i] - value)) : [...raw];
    this.jerk = previous && dtMs != null && dtMs <= 500 ?
      this.filtered.map((value, i) => (value - previous[i]) / dt) : null;
    const up = this.gravityBaseline?.map(value => value / magnitude(this.gravityBaseline));
    const vertical = up ? dot(this.filtered, up) : null;
    const horizontal = up ? this.filtered.map((value, i) => value - vertical * up[i]) : this.filtered;
    this.learnForwardAxis(input.gpsFix, gpsFresh, horizontal, tiltRateDegS, time, up);
    const forward = this.forwardAxis;
    const longitudinal = forward ? dot(horizontal, forward) : null;
    const lateral = forward ? magnitude(horizontal.map((value, i) => value - longitudinal * forward[i])) : null;
    Object.assign(diagnostic, { verticalMps2: rounded(vertical), longitudinalMps2: rounded(longitudinal),
      lateralMps2: rounded(lateral), horizontalMps2: rounded(magnitude(horizontal)),
      axisConfidence: forward ? 'estimated' : 'unknown' });
    this.severity *= Math.exp(-dt / 0.8);
    if (this.event && time - this.event.lastAt > 450) this.event = null;
    const horizontalMagnitude = magnitude(horizontal);
    this.spillLevel = this.spillRisk.update(time, up ? horizontalMagnitude : null);
    const kind = horizontalMagnitude > 1.5 ? longitudinal < -1.65 ? 'sharp-braking' :
      longitudinal > 1.65 ? 'abrupt-acceleration' : lateral > 1.65 ? 'sharp-cornering' : 'abrupt-motion' :
      up && Math.abs(dot(raw, up)) > 3.5 && Math.abs(vertical) > 0.8 ? 'vertical-bump' : null;
    if (!kind) this.candidate = null;
    else {
      const bump = kind === 'vertical-bump';
      const intensity = bump ? 0.25 : clamp((horizontalMagnitude - 1.1) / 3.5);
      if (this.candidate?.kind !== kind) this.candidate = { kind, since: time };
      if (time - this.candidate.since >= (bump ? 80 : 300)) {
        if (this.event?.kind === kind) {
          this.event.lastAt = time;
          this.event.peakSeverity = Math.max(this.event.peakSeverity, intensity);
        } else this.event = { kind, startedAt: this.candidate.since, lastAt: time, peakSeverity: intensity };
        if (!bump) this.severity = Math.max(this.severity, intensity);
      }
    }
    diagnostic.trigger = this.event?.kind ?? null;
    return this.snapshot(diagnostic);
  }

  learnForwardAxis(fix, gpsFresh, horizontal, tilt, time, up) {
    if (this.lastAxisAt != null && time - this.lastAxisAt > 30000) {
      this.forwardAxis = null;
      this.axisEvidence = [];
      this.lastAxisAt = null;
    }
    if (!up || !gpsFresh || !fix || ![fix.timestamp, fix.speed, fix.heading, fix.accuracy].every(Number.isFinite) ||
        fix.accuracy > 20 || fix.timestamp === this.axisFix?.timestamp) return;
    const previous = this.axisFix;
    this.axisFix = fix;
    if (this.forwardAxis) this.lastAxisAt = time;
    if (!previous || Math.min(fix.speed, previous.speed) < 4 ||
        Math.abs(((fix.heading - previous.heading + 540) % 360) - 180) > 8 || tilt == null || tilt > 12) return;
    const seconds = (fix.timestamp - previous.timestamp) / 1000;
    if (seconds < 0.5 || seconds > 2.5) return;
    const gpsAcceleration = (fix.speed - previous.speed) / seconds;
    const horizontalMagnitude = magnitude(horizontal);
    if (Math.abs(gpsAcceleration) < 0.65 || horizontalMagnitude < 0.5 ||
        Math.abs(horizontalMagnitude - Math.abs(gpsAcceleration)) > 0.8) return;
    const candidate = horizontal.map(value => value * Math.sign(gpsAcceleration) / horizontalMagnitude);
    this.axisEvidence = this.axisEvidence.filter(item => time - item.time < 120000);
    this.axisEvidence.push({ time, candidate, sign: Math.sign(gpsAcceleration) });
    if (this.axisEvidence.length > 12) this.axisEvidence.shift();
    const agreeing = this.axisEvidence.filter(item => dot(item.candidate, candidate) > 0.9);
    if (agreeing.length >= 4 && new Set(agreeing.map(item => item.sign)).size === 2) {
      const estimate = agreeing.reduce((sum, item) => sum.map((value, i) => value + item.candidate[i]), [0, 0, 0]);
      this.forwardAxis = estimate.map(value => value / magnitude(estimate));
      this.lastAxisAt = time;
    }
  }

  updateCalibration({ time, acceleration, includingGravity, gravityEstimate,
    rotationMagnitude, orientation, speedKmh, gpsFresh, diagnostic }) {
    this.calibration ??= [];
    const quality = (acceleration || includingGravity) &&
      (!acceleration || magnitude(acceleration) <= 30) &&
      (!gravityEstimate || magnitude(gravityEstimate) >= 6 &&
        magnitude(gravityEstimate) <= 13) &&
      (rotationMagnitude == null || rotationMagnitude <= 150);
    if (quality) this.calibration.push({ time, gravity: gravityEstimate, orientation });
    this.calibration = this.calibration.filter(sample => time - sample.time <= 3200);
    const samples = this.calibration;
    this.reason = 'warming-up';
    if (samples.length < 20 || time - samples[0].time < 3000) return this.snapshot(diagnostic);
    const gravitySamples = samples.map(sample => sample.gravity).filter(Boolean);
    this.gravityBaseline = gravitySamples.length >= 12 ? robustVector(gravitySamples) : null;
    this.orientationBaseline = samples.find(sample => sample.orientation)?.orientation || null;
    this.status = 'ready';
    this.reason = null;
    this.confidence = !gpsFresh ? 'low' : this.gravityBaseline &&
      Number.isFinite(speedKmh) && (rotationMagnitude != null || orientation) ?
      'high' : 'medium';
    this.filtered = [0, 0, 0];
    this.jerk = null;
    this.calibration = null;
    this.transition = { at: time, kind: 'warmup-complete',
      validSamples: samples.length, gravityAvailable: !!this.gravityBaseline };
    return this.snapshot(diagnostic);
  }

  enterStabilityCheck(time, diagnostic, cause) {
    this.pause('checking-stability');
    this.forwardAxis = null;
    this.axisEvidence = [];
    this.axisFix = null;
    this.lastAxisAt = null;
    this.stableSince = null;
    const durationMs = cause === 'gravity-shift' ? time - this.gravityShift.since :
      time - this.tiltCandidate;
    this.transition = { at: time, kind: 'stability-check', cause, durationMs,
      gravityAngleDeg: diagnostic.gravityAngleDeg,
      tiltRateDegS: diagnostic.tiltRateDegS };
  }

  pause(reason) {
    this.spillRisk.reset();
    this.spillLevel = 0;
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
