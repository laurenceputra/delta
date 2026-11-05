// Local, advisory route timing. Geometry and limits come from roads.json; no
// enforcement-zone or official timing boundaries are inferred here.
const R = 6371008.8;
const rad = degrees => degrees * Math.PI / 180;
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const normalAngle = degrees => ((degrees % 360) + 360) % 360;
const angleDifference = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

export function distanceM(a, b) {
  const p = rad(a[0]), q = rad(b[0]);
  const dp = q - p, dl = rad(b[1] - a[1]);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p) * Math.cos(q) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDegrees(a, b) {
  const p = rad(a[0]), q = rad(b[0]), dl = rad(b[1] - a[1]);
  return normalAngle(Math.atan2(Math.sin(dl) * Math.cos(q),
    Math.cos(p) * Math.sin(q) - Math.sin(p) * Math.cos(q) * Math.cos(dl)) * 180 / Math.PI);
}

function vertices(road) {
  const raw = road.geometry || road.coordinates || road.polyline || [];
  return raw.map(p => Array.isArray(p) ? (road.coordinates === raw ? [p[1], p[0]] : p) :
    [p.latitude ?? p.lat, p.longitude ?? p.lon]);
}

function cumulative(points) {
  const result = [0];
  for (let i = 1; i < points.length; i++) result.push(result[i - 1] + distanceM(points[i - 1], points[i]));
  return result;
}

export function roadLengthM(road) {
  const cum = cumulative(vertices(road));
  return cum[cum.length - 1] || 0;
}

export function sampleAt(road, distance) {
  const points = vertices(road), cum = cumulative(points);
  if (points.length < 2) return null;
  const at = clamp(distance, 0, cum.at(-1));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < at) i++;
  const portion = (at - cum[i - 1]) / Math.max(0.001, cum[i] - cum[i - 1]);
  return {
    latitude: points[i - 1][0] + (points[i][0] - points[i - 1][0]) * portion,
    longitude: points[i - 1][1] + (points[i][1] - points[i - 1][1]) * portion,
    heading: bearingDegrees(points[i - 1], points[i])
  };
}

function project(point, road) {
  const points = vertices(road);
  if (points.length < 2) return null;
  const cum = cumulative(points);
  let best = null;
  for (let i = 1; i < points.length; i++) {
    const lat = rad((points[i - 1][0] + points[i][0]) / 2);
    const x = rad(points[i][1] - points[i - 1][1]) * Math.cos(lat) * R;
    const y = rad(points[i][0] - points[i - 1][0]) * R;
    const px = rad(point[1] - points[i - 1][1]) * Math.cos(lat) * R;
    const py = rad(point[0] - points[i - 1][0]) * R;
    const t = clamp((px * x + py * y) / Math.max(0.001, x * x + y * y), 0, 1);
    const perpendicular = Math.hypot(px - t * x, py - t * y);
    if (!best || perpendicular < best.distanceM) best = {
      distanceM: perpendicular, alongM: cum[i - 1] + t * (cum[i] - cum[i - 1]),
      bearing: bearingDegrees(points[i - 1], points[i]), roadLengthM: cum.at(-1)
    };
  }
  return best;
}

function timestampMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  if (typeof value === 'number') return value < 1e11 ? value * 1000 : value;
  return NaN;
}

function limitAt(road, at) {
  const zones = road.speedLimits || [];
  const zone = zones.find(z => at >= (z.fromM ?? z.startM ?? 0) && at < (z.toM ?? z.endM ?? Infinity));
  const value = zone ? (zone.limitKmh ?? zone.speedKmh) : (road.limitKmh ?? road.speedLimitKmh ?? road.speedLimit);
  return Number.isFinite(value) && value > 0 && value <= 90 ? value : 50;
}

function limitAssumedAt(road, at) {
  const zones = road.speedLimits || [];
  const zone = zones.find(z => at >= (z.fromM ?? z.startM ?? 0) && at < (z.toM ?? z.endM ?? Infinity));
  const value = zone ? (zone.limitKmh ?? zone.speedKmh) : (road.limitKmh ?? road.speedLimitKmh ?? road.speedLimit);
  return !(Number.isFinite(value) && value > 0 && value <= 90);
}

function referenceAssumedOn(road, fromM, toM) {
  if (toM <= fromM) return false;
  const breaks = [fromM, toM];
  for (const zone of road.speedLimits || []) {
    for (const edge of [zone.fromM ?? zone.startM, zone.toM ?? zone.endM])
      if (Number.isFinite(edge) && edge > fromM && edge < toM) breaks.push(edge);
  }
  breaks.sort((a, b) => a - b);
  return breaks.slice(1).some((edge, i) => limitAssumedAt(road, (breaks[i] + edge) / 2));
}

function referenceTime(road, fromM, toM) {
  if (toM <= fromM) return 0;
  const breaks = [fromM, toM];
  for (const zone of road.speedLimits || []) {
    for (const edge of [zone.fromM ?? zone.startM, zone.toM ?? zone.endM])
      if (Number.isFinite(edge) && edge > fromM && edge < toM) breaks.push(edge);
  }
  breaks.sort((a, b) => a - b);
  let seconds = 0;
  for (let i = 1; i < breaks.length; i++) {
    const limit = limitAt(road, (breaks[i - 1] + breaks[i]) / 2);
    if (!limit) return null;
    seconds += (breaks[i] - breaks[i - 1]) / (limit / 3.6);
  }
  return seconds;
}

function cappedForecastTime(road, fromM, toM, speedMps) {
  if (toM <= fromM) return 0;
  const breaks = [fromM, toM];
  for (const zone of road.speedLimits || []) {
    for (const edge of [zone.fromM ?? zone.startM, zone.toM ?? zone.endM])
      if (Number.isFinite(edge) && edge > fromM && edge < toM) breaks.push(edge);
  }
  breaks.sort((a, b) => a - b);
  return breaks.slice(1).reduce((sum, edge, i) => sum +
    (edge - breaks[i]) / Math.min(speedMps, limitAt(road, (breaks[i] + edge) / 2) / 3.6), 0);
}

function isTunnel(road, at) {
  return road.tunnel === true || (road.tunnels || []).some(z => at >= (z.fromM ?? z.startM ?? 0) && at <= (z.toM ?? z.endM ?? 0));
}

function roadExits(road) {
  return (road.exits || []).map(e => ({ ...e, atM: e.atM ?? e.offsetM ?? e.distanceM ?? e.positionM }))
    .filter(e => Number.isFinite(e.atM));
}

function empty(status, reason = null) {
  return { status, reason, confidence: 'low', road: null, speedKmh: null,
    limitKmh: null, limitAssumed: false, limitSource: null, deltaSeconds: null, elapsedSeconds: null, exits: [],
    alongM: null, matchedDistanceM: null, inTunnel: false,
    entryTime: null, entrySource: null, entryConfidence: null, entryUncertaintyMs: null,
    timingBasis: null, elapsedClockSeconds: null, candidateRoad: null,
    limitUncertain: false, cumulativeReferenceAssumed: false, reconstructionStatus: 'none',
    provisional: false, deltaStatus: 'not-started', lastValidDeltaSeconds: null,
    lastValidDeltaAt: null, gapStart: null, sessionId: null, heldExits: [],
    lastKnownLimitKmh: null, lastKnownLimitAssumed: false, completedSession: null,
    acceptedFix: false, lastAcceptedFixAt: null };
}

export class Tracker {
  constructor(data, options = {}) {
    this.roads = (Array.isArray(data) ? data : data?.roads || []).filter(r => vertices(r).length >= 2);
    const connectorRaw = Array.isArray(data?.connectors) ? data.connectors : [];
    const connectorById = new Map(connectorRaw.map(r => [r.id, r]));
    for (const road of [...this.roads]) for (const link of road.routeNextRoadIds || []) {
      if (typeof link === 'string') continue;
      for (const id of link.connectorIds || []) {
        const source = connectorById.get(id);
        if (source && !this.roads.some(r => r.id === id)) this.roads.push({ ...source,
          ref: source.ref || road.ref, name: source.name || road.name,
          direction: source.direction || road.direction,
          travelDirection: source.travelDirection || road.travelDirection,
          connector: true });
      }
    }
    this.byId = new Map(this.roads.map(r => [r.id, r]));
    this.edges = new Map();
    const addEdge = (a, b) => {
      if (!this.byId.has(b)) return;
      if (!this.edges.has(a)) this.edges.set(a, new Set());
      this.edges.get(a).add(b);
    };
    for (const road of this.roads) {
      for (const id of road.nextRoadIds || []) addEdge(road.id, id);
      for (const link of road.routeNextRoadIds || []) {
        if (typeof link === 'string') { addEdge(road.id, link); continue; }
        const route = [...(link.connectorIds || []), link.roadId].filter(Boolean);
        let from = road.id;
        for (const id of route) { addEdge(from, id); from = id; }
      }
    }
    this.predecessors = new Map();
    for (const [from, targets] of this.edges) for (const to of targets) {
      if (!this.predecessors.has(to)) this.predecessors.set(to, new Set());
      this.predecessors.get(to).add(from);
    }
    const local = options.localRoads || data?.localRoads || [];
    this.localRoads = (Array.isArray(local) ? local : local.roads || []).filter(r => vertices(r).length >= 2 && !this.byId.has(r.id));
    this.grid = new Map();
    for (const road of [...this.roads, ...this.localRoads]) {
      const points = vertices(road);
      for (let i = 1; i < points.length; i++) {
        const loLat = Math.floor(Math.min(points[i - 1][0], points[i][0]) / 0.002);
        const hiLat = Math.floor(Math.max(points[i - 1][0], points[i][0]) / 0.002);
        const loLon = Math.floor(Math.min(points[i - 1][1], points[i][1]) / 0.002);
        const hiLon = Math.floor(Math.max(points[i - 1][1], points[i][1]) / 0.002);
        for (let a = loLat; a <= hiLat; a++) for (let b = loLon; b <= hiLon; b++) {
          const key = `${a}:${b}`;
          if (!this.grid.has(key)) this.grid.set(key, new Set());
          this.grid.get(key).add(road);
        }
      }
    }
    this.options = { maxAccuracyM: 75, maxGapMs: 12000, maxMatchM: 85, switchHoldMs: 6000, ...options };
    this.reset();
  }

  reset() {
    this.previous = null;
    this.currentRoad = null;
    this.elapsedSeconds = 0;
    this.referenceSeconds = 0;
    this.deltaValid = false;
    this.pending = null;
    this.confirmed = false;
    this.history = [];
    this.entryTime = null;
    this.entrySource = null;
    this.entryConfidence = null;
    this.entryUncertaintyMs = null;
    this.sessionStartMs = null;
    this.lastTime = null;
    this.reacquiring = false;
    this.gapAnchor = null;
    this.fullSessionAvailable = true;
    this.cumulativeReferenceAssumed = false;
    this.reconstructionStatus = 'none';
    this.provisional = null;
    this.sessionId = null;
    this.nextSessionId = (this.nextSessionId || 0) + 1;
    this.lastValidDeltaSeconds = null;
    this.lastValidDeltaAt = null;
    this.lastLiveState = null;
    this.committed = null;
    this.recoveryCandidate = null;
    this.gapStart = null;
    this.gapSequence = 0;
    this.appliedGaps = new Set();
    this.completedSession = null;
    this.lastAcceptedFixAt = null;
    this.state = empty('searching');
    return this.state;
  }

  invalidate(reason = 'GPS fix stale', preserveContext = true) {
    if (!preserveContext) this.reset();
    this.beginGap();
    return this.heldState(this.provisional && !this.confirmed ? 'entering' : 'stale', reason);
  }

  beginGap() {
    if (!this.gapAnchor) {
      const anchor = this.committed || (this.provisional ? {
        road: this.provisional.road, fix: this.provisional.fix,
        elapsed: 0, reference: 0, assumed: false, provisional: true } : null);
      if (anchor) {
        this.gapAnchor = { ...anchor, id: ++this.gapSequence };
        this.gapStart = anchor.fix.time;
      }
    }
    this.recoveryCandidate = null;
    this.reconstructionStatus = this.gapAnchor ? 'pending' : this.reconstructionStatus;
  }

  heldState(status, reason, speedKmh = null, candidateRoad = null, time = Date.now(), acceptedFix = false) {
    const prior = this.lastLiveState;
    return this.state = { ...empty(status, reason),
      road: prior?.road || this.state.road,
      candidateRoad, speedKmh,
      entryTime: this.entryTime, entrySource: this.entrySource,
      entryConfidence: this.entryConfidence, entryUncertaintyMs: this.entryUncertaintyMs,
      elapsedClockSeconds: this.entryTime == null ? null : Math.max(0, (time - this.entryTime) / 1000),
      elapsedSeconds: this.entryTime == null ? null : Math.max(0, (time - this.entryTime) / 1000),
      timingBasis: this.entryTime == null ? null : 'since detection',
      provisional: !!this.provisional, reconstructionStatus: this.reconstructionStatus,
      deltaStatus: this.gapAnchor ? this.reconstructionStatus === 'unresolved' ? 'unresolved' :
        this.recoveryCandidate ? 'recovering' : 'held' : 'not-started',
      lastValidDeltaSeconds: this.lastValidDeltaSeconds, lastValidDeltaAt: this.lastValidDeltaAt,
      gapStart: this.gapStart, sessionId: this.sessionId,
      heldExits: (prior?.exits || []).map(e => ({ name: e.name, number: e.number, distanceM: e.distanceM })),
      lastKnownLimitKmh: prior?.limitKmh ?? null,
      lastKnownLimitAssumed: prior?.limitAssumed ?? false,
      cumulativeReferenceAssumed: this.cumulativeReferenceAssumed,
      completedSession: this.completedSession,
      acceptedFix, lastAcceptedFixAt: this.lastAcceptedFixAt };
  }

  connected(from, to) {
    return !!this.forwardPath(from, to);
  }

  successors(road) {
    return [...(this.edges.get(road?.id) || [])].map(id => this.byId.get(id)).filter(Boolean);
  }

  forwardPath(from, to) {
    return this.uniquePath(from, to, 500);
  }

  gapPath(from, to) {
    return this.uniquePath(from, to, 50000);
  }

  uniquePath(from, to, maxM) {
    if (!from || !to) return null;
    if (from.id === to.id) return [from];
    const stack = [{ road: from, path: [from], seen: new Set([from.id]), length: 0 }];
    let result = null, expansions = 0;
    while (stack.length && expansions++ < 20000) {
      const item = stack.pop();
      for (const next of this.successors(item.road)) {
        if (item.seen.has(next.id)) continue;
        const length = item.length + (next.id === to.id ? 0 : next.lengthM || roadLengthM(next));
        if (length > maxM) continue;
        const path = [...item.path, next];
        if (next.id === to.id) {
          if (result) return null;
          result = path;
        } else stack.push({ road: next, path, seen: new Set([...item.seen, next.id]), length });
      }
    }
    return expansions >= 20000 ? null : result;
  }

  gapReference(path, fromM, toM) {
    let seconds = 0;
    for (let i = 0; i < path.length; i++) {
      const part = referenceTime(path[i], i ? 0 : fromM,
        i === path.length - 1 ? toM : path[i].lengthM || roadLengthM(path[i]));
      if (part == null) return null;
      seconds += part;
    }
    return seconds;
  }

  pathAssumed(path, fromM, toM) {
    return path.some((road, i) => referenceAssumedOn(road, i ? 0 : fromM,
      i === path.length - 1 ? toM : road.lengthM || roadLengthM(road)));
  }

  limitUncertain(road, at, accuracy) {
    const length = road.lengthM || roadLengthM(road);
    const before = at - accuracy, after = at + accuracy;
    const edges = [];
    for (const zone of road.speedLimits || [])
      for (const edge of [zone.fromM ?? zone.startM, zone.toM ?? zone.endM])
        if (Number.isFinite(edge) && edge > before && edge < after) edges.push(edge);
    if (edges.some(edge => limitAt(road, Math.max(0, edge - 0.01)) !==
      limitAt(road, Math.min(length, edge + 0.01)))) return true;
    if (limitAt(road, Math.max(0, before)) !== limitAt(road, Math.min(length, after))) return true;
    if (before < 0) for (const id of this.predecessors.get(road.id) || []) {
      const previous = this.byId.get(id);
      if (limitAt(previous, Math.max(0, (previous.lengthM || roadLengthM(previous)) - 0.01)) !== limitAt(road, 0)) return true;
    }
    if (after > length) for (const next of this.successors(road))
      if (limitAt(next, 0) !== limitAt(road, Math.max(0, length - 0.01))) return true;
    return false;
  }

  upcomingExits(road, alongM) {
    const result = [];
    const seenExits = new Set();
    const visited = new Set();
    let current = road, base = -alongM;
    while (current && !visited.has(current.id) && result.length < 3) {
      visited.add(current.id);
      for (const exit of roadExits(current)) {
        const distance = base + exit.atM;
        const key = exit.id || `${exit.ref || ''}:${exit.name || ''}:${Math.round(distance / 20)}`;
        if (distance > 1 && !seenExits.has(key)) {
          result.push({ exit, distanceM: distance, road: current, atM: exit.atM });
          seenExits.add(key);
        }
      }
      result.sort((a, b) => a.distanceM - b.distanceM);
      if (result.length >= 3) break;
      base += current.lengthM || roadLengthM(current);
      const choices = this.successors(current);
      current = choices[0] || null;
    }
    return result.slice(0, 3);
  }

  referenceAcross(from, fromM, to, toM) {
    if (from.id === to.id) return referenceTime(from, fromM, toM);
    const path = this.forwardPath(from, to);
    if (!path) return null;
    let seconds = 0;
    for (let i = 0; i < path.length; i++) {
      const part = referenceTime(path[i], i === 0 ? fromM : 0,
        i === path.length - 1 ? toM : path[i].lengthM || roadLengthM(path[i]));
      if (part == null) return null;
      seconds += part;
    }
    return seconds;
  }

  nearby(point) {
    const a = Math.floor(point[0] / 0.002), b = Math.floor(point[1] / 0.002);
    const found = new Set();
    for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++)
      for (const road of this.grid.get(`${a + da}:${b + db}`) || []) found.add(road);
    return found;
  }

  sameLogicalRoad(a, b) {
    if (!a || !b) return false;
    if (a.id === b.id) return true;
    if (this.byId.has(a.id) && this.byId.has(b.id))
      return !!this.forwardPath(a, b) || !!this.forwardPath(b, a);
    return !this.byId.has(a.id) && !this.byId.has(b.id) &&
      !!a.name && a.name === b.name && a.highway === b.highway &&
      distanceM(vertices(a).at(-1), vertices(b)[0]) < 60;
  }

  update(fix) {
    const time = timestampMs(fix?.timestamp);
    const latitude = fix?.latitude == null ? NaN : Number(fix.latitude);
    const longitude = fix?.longitude == null ? NaN : Number(fix.longitude);
    const accuracy = fix?.accuracy == null ? NaN : Number(fix.accuracy);
    if (!Number.isFinite(time) || !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 || Math.abs(longitude) > 180 ||
        !Number.isFinite(accuracy) || accuracy < 0 || accuracy > this.options.maxAccuracyM) {
      return this.invalidate('GPS accuracy or position unavailable');
    }
    if (this.lastTime != null && time <= this.lastTime)
      return this.state = { ...this.state, acceptedFix: false, lastAcceptedFixAt: this.lastAcceptedFixAt };
    if (this.lastTime != null && time - this.lastTime > this.options.maxGapMs) {
      this.beginGap();
    }
    this.lastTime = time;
    this.lastAcceptedFixAt = Date.now();
    this.history.push({ time, point: [latitude, longitude], accuracy, heading: fix.heading, speed: fix.speed });
    this.history = this.history.filter(h => time - h.time <= 30000);

    const heading = fix.heading == null ? NaN : Number(fix.heading);
    const speedMps = fix.speed == null ? NaN : Number(fix.speed);
    const headingUseful = Number.isFinite(heading) && (Number.isFinite(speedMps) ? speedMps > 2 : true);
    const speedKmh = Number.isFinite(speedMps) && speedMps >= 0 ? speedMps * 3.6 : null;
    const point = [latitude, longitude];
    const candidates = [...this.nearby(point)].map(road => ({ road, match: project(point, road) }))
      .filter(c => c.match && c.match.distanceM <= this.options.maxMatchM + accuracy * 0.35)
      .map(c => {
        const oneWay = c.road.oneway === true || c.road.oneway === 'yes' || c.road.oneway === '1' || c.road.oneway === '-1' || this.byId.has(c.road.id);
        const turn = headingUseful ? Math.min(angleDifference(heading, c.match.bearing),
          oneWay ? 360 : angleDifference(heading, c.match.bearing + 180)) : 0;
        const same = this.currentRoad && this.currentRoad.id === c.road.id;
        const next = this.connected(this.currentRoad, c.road);
        const progression = same && this.previous ? c.match.alongM - this.previous.alongM : 0;
        const continuityPenalty = same && this.previous && progression < -35 && oneWay ? 120 : 0;
        return { ...c, score: c.match.distanceM + (headingUseful ? turn * 0.7 : 0) +
          continuityPenalty - (same ? 5 : next ? 3 : 0), turn };
      }).sort((a, b) => a.score - b.score);
    const selected = candidates[0];
    if (!selected || (headingUseful && selected.turn > 105)) {
      this.beginGap();
      this.pending = null;
      return this.heldState('identifying', 'No reliable road match', speedKmh, null, time, true);
    }

    const selectedMainline = this.byId.has(selected.road.id);
    const ambiguous = candidates.find(c => this.byId.has(c.road.id) !== selectedMainline &&
      Math.abs(c.match.distanceM - selected.match.distanceM) < Math.max(5, accuracy / 2) &&
      c.turn < 65);
    if (ambiguous) {
      this.beginGap();
      this.pending = null;
      return this.heldState('identifying', 'Road level ambiguous', speedKmh, null, time, true);
    }

    const selectedExpressway = this.byId.has(selected.road.id);
    const credibleEntry = selectedExpressway && !this.byId.has(this.currentRoad?.id) &&
      accuracy <= 30 && selected.match.distanceM <= Math.max(15, accuracy) &&
      headingUseful && selected.turn <= 45;
    if (credibleEntry && !this.provisional && this.reconstructionStatus !== 'unresolved') {
      if (this.sessionId == null) {
        this.lastValidDeltaSeconds = null;
        this.lastValidDeltaAt = null;
        this.lastLiveState = null;
        this.committed = null;
        this.gapStart = null;
      }
      this.provisional = { road: selected.road, fix: { time, alongM: selected.match.alongM, point },
        accuracy, heading };
      this.sessionId ??= `session-${this.nextSessionId++}`;
      this.entryTime = time;
      this.entrySource = 'first-mainline-fix';
      this.entryConfidence = isTunnel(selected.road, selected.match.alongM) ? 'low' : 'approximate';
      this.entryUncertaintyMs = Math.round(accuracy / Math.max(2, speedMps || 0) * 1000);
    }
    if (this.gapAnchor) {
      const anchor = this.gapAnchor;
      if (selectedExpressway) {
        const path = this.gapPath(anchor.road, selected.road);
        const reference = path && this.gapReference(path, anchor.fix.alongM, selected.match.alongM);
        const travel = path ? path.slice(0, -1).reduce((sum, r, i) => sum +
          (r.lengthM || roadLengthM(r)) - (i ? 0 : anchor.fix.alongM), 0) +
          selected.match.alongM - (path.length === 1 ? anchor.fix.alongM : 0) : -1;
        const dt = (time - anchor.fix.time) / 1000;
        if (path && reference != null && dt > 0 && travel >= 0 && travel <= dt * 55 + accuracy * 3) {
          const prior = this.recoveryCandidate;
          if (!prior || !this.sameLogicalRoad(prior.road, selected.road) || time - prior.time < 1000) {
            if (!prior || !this.sameLogicalRoad(prior.road, selected.road))
              this.recoveryCandidate = { road: selected.road, time };
            this.reconstructionStatus = 'pending';
            return this.heldState('identifying', 'Checking route after GPS gap', speedKmh,
              { id: selected.road.id, name: selected.road.name, kind: 'expressway' }, time, true);
          }
          if (!this.appliedGaps.has(anchor.id)) {
            this.elapsedSeconds = anchor.elapsed + dt;
            this.referenceSeconds = anchor.reference + reference;
            this.cumulativeReferenceAssumed = anchor.assumed ||
              this.pathAssumed(path, anchor.fix.alongM, selected.match.alongM);
            this.appliedGaps.add(anchor.id);
          }
          this.currentRoad = selected.road;
          this.previous = { time, alongM: selected.match.alongM, point };
          this.confirmed = true;
          this.deltaValid = true;
          this.fullSessionAvailable = true;
          this.reconstructionStatus = 'reconstructed';
          this.sessionStartMs = this.entryTime;
          this.provisional = null;
          this.gapAnchor = null;
          this.recoveryCandidate = null;
          this.gapStart = null;
          this.reacquiring = false;
        } else {
          this.recoveryCandidate = null;
          this.reconstructionStatus = 'unresolved';
          return this.heldState('identifying', 'Route through GPS gap unresolved', speedKmh,
            { id: selected.road.id, name: selected.road.name, kind: 'expressway' }, time, true);
        }
      } else {
        const prior = this.recoveryCandidate;
        this.recoveryCandidate = prior && this.sameLogicalRoad(prior.road, selected.road) ? prior :
          { road: selected.road, time };
        if (time - this.recoveryCandidate.time >= this.options.switchHoldMs) {
          this.completedSession = { sessionId: this.sessionId, entryTime: this.entryTime,
            exitTime: time, lastValidDeltaSeconds: this.lastValidDeltaSeconds,
            lastValidDeltaAt: this.lastValidDeltaAt, elapsedSeconds: (time - this.entryTime) / 1000,
            referenceSeconds: this.referenceSeconds, cumulativeReferenceAssumed: this.cumulativeReferenceAssumed,
            status: 'completed-with-gap' };
          this.gapAnchor = null;
          this.provisional = null;
          this.sessionId = null;
          this.entryTime = null;
          this.entrySource = null;
          this.entryConfidence = null;
          this.entryUncertaintyMs = null;
          this.confirmed = true;
          this.currentRoad = selected.road;
          this.previous = { time, alongM: selected.match.alongM, point };
          this.reconstructionStatus = 'none';
          this.lastLiveState = null;
          this.committed = null;
          this.recoveryCandidate = null;
          this.gapStart = null;
          this.elapsedSeconds = 0;
          this.referenceSeconds = 0;
          this.deltaValid = false;
        } else return this.heldState('exiting', 'Confirming expressway exit', speedKmh,
          { id: selected.road.id, name: selected.road.name, kind: 'local' }, time, true);
      }
    }
    if (this.confirmed && this.committed && !this.sameLogicalRoad(this.currentRoad, selected.road) && !this.gapAnchor) {
      this.beginGap();
      this.recoveryCandidate = { road: selected.road, time };
      return this.heldState(selectedExpressway ? 'entering' : 'exiting',
        'Confirming road change', speedKmh,
        { id: selected.road.id, name: selected.road.name, kind: selectedExpressway ? 'expressway' : 'local' },
        time, true);
    }
    const currentExpressway = this.currentRoad && this.byId.has(this.currentRoad.id);
    const continuous = this.sameLogicalRoad(this.currentRoad, selected.road);
    const pendingSame = this.pending && this.sameLogicalRoad(this.pending.road, selected.road);
    if (!this.confirmed || !continuous) {
      this.pending = pendingSame ? { ...this.pending, road: selected.road, count: this.pending.count + 1 } :
        { road: selected.road, count: 1, firstTime: time, firstMatch: selected.match,
          firstRoad: selected.road, firstAccuracy: accuracy };
      const hold = this.confirmed ? this.options.switchHoldMs : 0;
      if (this.pending.count < (this.options.confirmationFixes || 2) || time - this.pending.firstTime < hold) {
        this.deltaValid = false;
        this.previous = null;
        this.sessionStartMs = null;
        return this.state = { ...empty(this.confirmed && currentExpressway ? 'exiting' :
          selectedExpressway && this.provisional ? 'entering' :
          this.confirmed && selectedExpressway ? 'entering' : 'identifying', 'Confirming road'),
          speedKmh, road: this.confirmed ? this.state.road : {
            id: selected.road.id, ref: selected.road.ref || null,
            name: selected.road.name || selected.road.ref || 'Unnamed road',
            direction: selected.road.travelDirection || selected.road.destination || selected.road.direction || '',
            kind: selectedExpressway ? 'expressway' : selected.road.highway === 'motorway_link' ? 'ramp' : 'local',
            isExpressway: selectedExpressway }, candidateRoad: {
            id: selected.road.id, name: selected.road.name || selected.road.ref || 'Unnamed road',
            kind: selectedExpressway ? 'expressway' : selected.road.highway === 'motorway_link' ? 'ramp' : 'local' },
          entryTime: this.entryTime, entrySource: this.entrySource,
          entryConfidence: this.entryConfidence, entryUncertaintyMs: this.entryUncertaintyMs,
          provisional: !!this.provisional,
          elapsedClockSeconds: this.entryTime == null ? null : (time - this.entryTime) / 1000,
          reconstructionStatus: this.reconstructionStatus, sessionId: this.sessionId,
          deltaStatus: this.sessionId ? 'recovering' : 'not-started',
          lastValidDeltaSeconds: this.lastValidDeltaSeconds,
          lastValidDeltaAt: this.lastValidDeltaAt,
          gapStart: this.gapStart, acceptedFix: true,
          lastAcceptedFixAt: this.lastAcceptedFixAt };
      }
      this.confirmed = true;
      this.provisional = null;
      this.previous = selectedExpressway && this.pending.firstTime < time ? {
        time: this.pending.firstTime, alongM: this.pending.firstMatch.alongM,
        point: vertices(this.pending.firstRoad)[0] } : null;
      if (currentExpressway && !this.fullSessionAvailable) this.previous = null;
      this.currentRoad = selectedExpressway && this.previous ? this.pending.firstRoad : this.currentRoad;
      this.elapsedSeconds = 0;
      this.referenceSeconds = 0;
      this.deltaValid = !!this.previous;
      this.cumulativeReferenceAssumed = false;
      this.reconstructionStatus = 'none';
      if (selectedExpressway) {
        if (!(currentExpressway && !this.fullSessionAvailable && this.entryTime != null)) {
          this.entryTime = this.pending.firstTime;
          this.entrySource = 'first-mainline-fix';
          this.entryConfidence = isTunnel(this.pending.firstRoad, this.pending.firstMatch.alongM) ||
            this.pending.firstAccuracy > 40 ? 'low' : 'approximate';
          this.entryUncertaintyMs = Math.round(this.pending.firstAccuracy / Math.max(2, speedMps || 0) * 1000);
        }
        this.sessionStartMs = currentExpressway && !this.fullSessionAvailable ? time : this.pending.firstTime;
      } else this.sessionStartMs = null;
    } else if (!this.previous) {
      this.elapsedSeconds = 0;
      this.referenceSeconds = 0;
      this.deltaValid = false;
      this.sessionStartMs = time;
      this.cumulativeReferenceAssumed = false;
      this.reacquiring = true;
    }
    this.pending = null;

    const { road, match } = selected;
    if (!selectedExpressway) {
      this.currentRoad = road;
      this.previous = { time, alongM: match.alongM, point };
      this.elapsedSeconds = 0;
      this.referenceSeconds = 0;
      this.deltaValid = false;
      return this.state = { ...empty('local'), road: { id: road.id, ref: road.ref || null,
        name: road.name || road.ref || 'Unnamed road', direction: road.destination || '',
        kind: road.highway === 'motorway_link' ? 'ramp' : 'local', isExpressway: false },
        speedKmh, limitKmh: limitAt(road, match.alongM), limitAssumed: limitAssumedAt(road, match.alongM),
        limitSource: limitAssumedAt(road, match.alongM) ? 'Assumed 50 km/h reference' : 'OSM maxspeed tag',
        matchedDistanceM: match.distanceM, alongM: match.alongM,
        confidence: accuracy > 30 || match.distanceM > 30 ? 'low' : 'medium',
        completedSession: this.completedSession, acceptedFix: true,
        lastAcceptedFixAt: this.lastAcceptedFixAt };
    }
    const oldRoad = this.currentRoad;
    const sameRoad = oldRoad?.id === road.id;
    const path = oldRoad && !sameRoad ? this.forwardPath(oldRoad, road) : null;
    const connected = !!path;
    const dt = this.previous ? (time - this.previous.time) / 1000 : 0;
    const progress = this.previous && sameRoad ? match.alongM - this.previous.alongM :
      this.previous && connected ? path.slice(0, -1).reduce((sum, r, i) => sum +
        (r.lengthM || roadLengthM(r)) - (i === 0 ? this.previous.alongM : 0), 0) + match.alongM : 0;
    const implausible = this.previous && (sameRoad || connected) &&
      (progress < -35 || progress > Math.max(120, dt * 55 + accuracy * 2));
    if ((!sameRoad && !connected) || implausible) {
      this.elapsedSeconds = 0;
      this.referenceSeconds = 0;
      this.deltaValid = false;
      this.sessionStartMs = time;
      this.cumulativeReferenceAssumed = false;
    }
    const limitKmh = limitAt(road, match.alongM);
    const priorLimit = this.previous && (sameRoad || connected) ? limitAt(oldRoad, this.previous.alongM) : null;
    if (!limitKmh) this.deltaValid = false;
    else if (this.previous && (sameRoad || connected) && !priorLimit) {
      this.elapsedSeconds = 0;
      this.referenceSeconds = 0;
      this.deltaValid = true;
    }
    else if (!this.previous || (!sameRoad && !connected) || implausible) {
      this.deltaValid = !this.reacquiring;
      this.sessionStartMs ??= time;
      this.cumulativeReferenceAssumed ||= limitAssumedAt(road, match.alongM);
    }
    else if (!this.deltaValid) {
      const reference = this.referenceAcross(oldRoad, this.previous.alongM, road, match.alongM);
      if (reference != null) {
        this.deltaValid = true;
        this.elapsedSeconds = dt;
        this.referenceSeconds = reference;
        this.cumulativeReferenceAssumed ||= this.pathAssumed(sameRoad ? [road] : path,
          this.previous.alongM, match.alongM);
      }
    }
    else if (this.deltaValid) {
      const reference = this.referenceAcross(oldRoad, this.previous.alongM, road, match.alongM);
      if (reference == null) this.deltaValid = false;
      else {
      this.elapsedSeconds += dt;
      this.referenceSeconds += reference;
      this.cumulativeReferenceAssumed ||= this.pathAssumed(sameRoad ? [road] : path,
        this.previous.alongM, match.alongM);
      }
    }
    this.currentRoad = road;
    this.previous = { time, alongM: match.alongM, point };
    this.reacquiring = false;

    const inTunnel = isTunnel(road, match.alongM);
    const confidence = inTunnel || accuracy > 40 || match.distanceM > 35 ? 'low' :
      accuracy > 20 || match.distanceM > 18 || !headingUseful ? 'medium' : 'high';
    const deltaSeconds = this.deltaValid && limitKmh ? this.elapsedSeconds - this.referenceSeconds : null;
    const exits = this.upcomingExits(road, match.alongM).map(({ exit: e, distanceM: distance, road: exitRoad, atM }) => {
        const path = road.id === exitRoad.id ? [road] : this.gapPath(road, exitRoad);
        const reference = path ? this.gapReference(path, match.alongM, atM) : null;
        const referenceAssumed = path ? this.pathAssumed(path, match.alongM, atM) : null;
        const capped = path && speedMps > 1 ? path.reduce((sum, part, i) => sum +
          cappedForecastTime(part, i ? 0 : match.alongM,
            i === path.length - 1 ? atM : part.lengthM || roadLengthM(part), speedMps), 0) : null;
        const projectedDeltaSeconds = deltaSeconds != null && capped != null && reference != null ?
          deltaSeconds + capped - reference : null;
        return { name: e.name || e.label || 'Unnamed exit', number: e.number ?? null,
          distanceM: distance, projectedDeltaSeconds, forecast: true, referenceAssumed };
      });
    this.state = {
      status: 'tracking', reason: inTunnel ? 'Tunnel: GPS confidence reduced' : null,
      confidence, road: { id: road.id, ref: road.ref || null, name: road.name || road.ref || '',
        direction: road.travelDirection || road.direction || '', kind: 'expressway', isExpressway: true },
      speedKmh, limitKmh, limitAssumed: limitAssumedAt(road, match.alongM),
      limitSource: limitAssumedAt(road, match.alongM) ? 'Assumed 50 km/h reference' : 'OSM maxspeed tag',
      limitUncertain: this.limitUncertain(road, match.alongM, accuracy),
      cumulativeReferenceAssumed: this.cumulativeReferenceAssumed,
      reconstructionStatus: this.reconstructionStatus, deltaSeconds,
      elapsedSeconds: this.elapsedSeconds, exits, alongM: match.alongM,
      matchedDistanceM: match.distanceM, inTunnel,
      entryTime: this.entryTime, entrySource: this.entrySource,
      entryConfidence: this.entryConfidence, entryUncertaintyMs: this.entryUncertaintyMs,
      elapsedClockSeconds: this.entryTime == null ? null : (time - this.entryTime) / 1000,
      timingBasis: this.sessionStartMs === this.entryTime && this.fullSessionAvailable ? 'since detection' : 'since reacquisition',
      fullSessionAvailable: this.fullSessionAvailable && this.deltaValid,
      deltaStatus: deltaSeconds == null ? 'recovering' : 'live',
      lastValidDeltaSeconds: deltaSeconds == null ? this.lastValidDeltaSeconds : deltaSeconds,
      lastValidDeltaAt: deltaSeconds == null ? this.lastValidDeltaAt : time,
      gapStart: this.gapStart, sessionId: this.sessionId,
      acceptedFix: true, lastAcceptedFixAt: this.lastAcceptedFixAt,
      completedSession: this.completedSession,
      heldExits: []
    };
    if (deltaSeconds != null) {
      this.sessionId ??= `session-${this.nextSessionId++}`;
      this.state.sessionId = this.sessionId;
      this.lastValidDeltaSeconds = deltaSeconds;
      this.lastValidDeltaAt = time;
      this.lastLiveState = this.state;
      this.committed = { road, fix: this.previous, elapsed: this.elapsedSeconds,
        reference: this.referenceSeconds, assumed: this.cumulativeReferenceAssumed };
    }
    return this.state;
  }
}
