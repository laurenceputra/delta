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
    acceptedFix: false, lastAcceptedFixAt: null, rampTransition: null,
    visualRoad: null, visualSpeedKmh: null, visualLimitKmh: null,
    visualLimitAssumed: false, visualLimitSource: null, previousDelta: null };
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
    this.rampGraph = data?.rampGraph || { links: [], paths: [] };
    this.rampLinks = new Map(this.rampGraph.links.map(link => [link.id, link]));
    this.edges = new Map();
    this.edgeEntries = new Map();
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
        if (Number.isFinite(link.entryOffsetM) && route.length)
          this.edgeEntries.set(`${route.at(-2) || road.id}:${link.roadId}`,
            link.entryOffsetM);
      }
    }
    this.predecessors = new Map();
    for (const [from, targets] of this.edges) for (const to of targets) {
      if (!this.predecessors.has(to)) this.predecessors.set(to, new Set());
      this.predecessors.get(to).add(from);
    }
    const local = options.localRoads || data?.localRoads || [];
    this.localRoads = (Array.isArray(local) ? local : local.roads || []).filter(r => vertices(r).length >= 2 && !this.byId.has(r.id));
    this.routeById = new Map([...this.roads, ...this.localRoads].map(r => [r.id, r]));
    for (const path of this.rampGraph.paths || []) {
      if (path.kind !== 'joining' && path.kind !== 'transfer') continue;
      const route = [path.fromRoadId, ...(path.linkIds || []), path.toRoadId];
      if (path.kind === 'transfer') {
        const destination = this.byId.get(path.toRoadId);
        const endpoint = path.endCoordinate;
        const entry = destination && Array.isArray(endpoint) && endpoint.length === 2 &&
          project([endpoint[1], endpoint[0]], destination);
        if (!this.byId.has(path.fromRoadId) || !entry || entry.distanceM > 2 ||
            !path.linkIds?.length || path.linkIds.some(id =>
              !this.rampLinks.has(id) || this.routeById.get(id)?.highway !== 'motorway_link') ||
            route.slice(1, -1).some((id, index) => {
              const previous = this.routeById.get(route[index]);
              const next = this.routeById.get(id);
              return !previous || !next ||
                distanceM(vertices(previous).at(-1), vertices(next)[0]) > 2;
            }) || distanceM(vertices(this.routeById.get(route.at(-2))).at(-1),
              [endpoint[1], endpoint[0]]) > 2) continue;
        const entryKey = `${route.at(-2)}:${path.toRoadId}`;
        if (this.edgeEntries.has(entryKey) &&
            (this.edgeEntries.get(entryKey) == null ||
              Math.abs(this.edgeEntries.get(entryKey) - entry.alongM) > 1))
          this.edgeEntries.set(entryKey, null);
        else this.edgeEntries.set(entryKey, entry.alongM);
      }
      for (let i = 1; i < route.length; i++)
        if (this.routeById.has(route[i - 1]) && this.routeById.has(route[i])) {
          if (!this.edges.has(route[i - 1])) this.edges.set(route[i - 1], new Set());
          this.edges.get(route[i - 1]).add(route[i]);
        }
    }
    for (const [from, targets] of this.edges) for (const to of targets) {
      if (!this.predecessors.has(to)) this.predecessors.set(to, new Set());
      this.predecessors.get(to).add(from);
    }
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
    this.incompleteHistory = [];
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
    this.approachTime = null;
    this.approachAnchor = null;
    this.expresswayEntryTime = null;
    this.timingFromMainline = false;
    this.lastFixDiagnostic = null;
    this.gpsStatus = 'unavailable';
    this.candidateDiagnostics = [];
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
    this.recovery = null;
    this.recoveryReason = null;
    this.recoveryReliableMs = 0;
    this.recoveryLastReliableAt = null;
    this.recoverySegmentAnchor = null;
    this.recoveryStart = null;
    this.sinceGpsRecovery = false;
    this.incompleteJourney = this.incompleteHistory.at(-1) || null;
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
    this.rampTransition = null;
    this.rampFirstFix = null;
    this.lastRampFix = null;
    this.joinEvidence = null;
    this.visualRoad = null;
    this.visualCandidate = null;
    this.visualSpeedKmh = null;
    this.visualLimitKmh = null;
    this.visualLimitAssumed = false;
    this.previousDelta = null;
    this.localEvidenceMs = 0;
    this.lastReliableLocal = null;
    this.state = empty('searching');
    return this.state;
  }

  invalidate(reason = 'GPS fix stale', preserveContext = true) {
    if (!preserveContext) this.reset();
    this.gpsStatus = 'unavailable';
    this.lastReliableLocal = null;
    this.visualCandidate = null;
    this.beginGap();
    return this.heldState(this.provisional && !this.confirmed ? 'entering' : 'stale', reason);
  }

  beginGap() {
    this.lastReliableLocal = null;
    this.recoveryLastReliableAt = null;
    this.recoverySegmentAnchor = null;
    if (!this.gapAnchor) {
      const provisionalAnchor = this.provisional ? {
        road: this.provisional.road, fix: this.provisional.fix,
        elapsed: this.provisional.elapsed || 0, reference: this.provisional.reference || 0,
        assumed: !!this.provisional.assumed, provisional: true } : null;
      const anchor = this.committed || (this.timingFromMainline ? provisionalAnchor :
        this.approachAnchor || provisionalAnchor);
      if (anchor) {
        this.gapAnchor = { ...anchor, id: ++this.gapSequence };
        this.gapStart = anchor.fix.time;
        this.recoveryReliableMs = 0;
        this.recoveryReason = 'awaiting-mainline';
      }
    }
    this.recoveryCandidate = null;
    this.reconstructionStatus = this.gapAnchor ? 'pending' : this.reconstructionStatus;
    if (this.gapAnchor) this.recovery = { phase: 'pending', reasonCode: this.recoveryReason,
      reliableMs: this.recoveryReliableMs };
  }

  retireUnresolvedGap(selected, time, accuracy, point) {
    const anchor = this.gapAnchor;
    const reasonCode = this.recoveryReason || 'route-unresolved';
    const archived = { sessionId: this.sessionId, entryTime: this.entryTime,
      approachTime: this.approachTime, sourceRef: anchor?.road?.ref ||
        this.rampTransition?.destinationRef || null,
      lastValidDeltaSeconds: this.lastValidDeltaSeconds,
      lastValidDeltaAt: this.lastValidDeltaAt, finalDeltaSeconds: null,
      finalTimingStatus: 'incomplete', reasonCode, endedAt: time,
      status: 'incomplete-gps-recovery' };
    this.incompleteHistory.push(archived);
    if (this.incompleteHistory.length > 20) this.incompleteHistory.shift();
    const history = this.incompleteHistory;
    const visualRoad = this.visualRoad, visualCandidate = this.visualCandidate;
    const visualSpeedKmh = this.visualSpeedKmh;
    const reliableMs = this.recoveryReliableMs;
    const segmentAnchor = this.recoverySegmentAnchor;
    const segmentRoute = segmentAnchor && this.recoveryRoute(segmentAnchor.road, selected.road,
      segmentAnchor.alongM, selected.match.alongM,
      (time - segmentAnchor.time) / 1000 * 55 + accuracy * 3);
    const observedSegment = segmentRoute?.reference != null && segmentRoute.travel >= 0 &&
      time - segmentAnchor.time <= this.options.maxGapMs;
    const recoveryStart = observedSegment ? { time: segmentAnchor.time,
      endRoadId: selected.road.id, elapsed: (time - segmentAnchor.time) / 1000,
      reference: segmentRoute.reference, assumed: segmentRoute.assumed } :
      { time, endRoadId: selected.road.id, elapsed: 0, reference: 0,
        assumed: limitAssumedAt(selected.road, selected.match.alongM) };
    this.reset();
    this.incompleteHistory = history;
    this.incompleteJourney = archived;
    this.completedSession = archived;
    this.sinceGpsRecovery = true;
    this.recoveryStart = recoveryStart;
    this.recoveryReason = reasonCode;
    this.recovery = { phase: 'retired', reasonCode, reliableMs };
    this.visualRoad = visualRoad;
    this.visualCandidate = visualCandidate;
    this.visualSpeedKmh = visualSpeedKmh;
    this.gpsStatus = 'fresh';
    this.lastTime = time;
    this.lastAcceptedFixAt = Date.now();
    this.entryTime = recoveryStart.time;
    this.entrySource = 'gps-recovery';
    this.entryConfidence = 'approximate';
    this.entryUncertaintyMs = Math.round(accuracy / 2 * 1000);
    this.sessionId = `session-${this.nextSessionId++}`;
    this.provisional = { road: selected.road, fix: { time, alongM: selected.match.alongM, point },
      accuracy, elapsed: 0, reference: 0, assumed: false };
  }

  heldState(status, reason, speedKmh = null, candidateRoad = null, time = Date.now(), acceptedFix = false) {
    const prior = this.lastLiveState;
    return this.decorate({ ...empty(status, reason),
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
      rampTransition: this.rampTransition,
      acceptedFix, lastAcceptedFixAt: this.lastAcceptedFixAt }, time);
  }

  roadView(road) {
    return { id: road.id, ref: road.ref || null, name: road.name || road.ref || 'Unnamed road',
      direction: road.travelDirection || road.destination || road.direction || '',
      kind: this.byId.has(road.id) ? 'expressway' : road.highway === 'motorway_link' ? 'ramp' : 'local',
      isExpressway: this.byId.has(road.id) };
  }

  updateVisual(selected, time, accuracy, speedKmh) {
    const road = selected.road;
    const reliable = accuracy <= 30 && selected.match.distanceM <= 30 && selected.turn <= 45;
    if (!this.visualRoad && reliable) this.visualRoad = this.roadView(road);
    else if (this.visualRoad && this.sameLogicalRoad(this.byId.get(this.visualRoad.id) ||
      this.localRoads.find(r => r.id === this.visualRoad.id), road)) {
      this.visualRoad = this.roadView(road);
      this.visualCandidate = null;
    } else if (reliable) {
      const prior = this.visualCandidate;
      this.visualCandidate = prior && this.sameLogicalRoad(prior.road, road) ? prior : { road, firstTime: time, count: 0 };
      this.visualCandidate.count++;
      if (this.visualCandidate.count >= 2 && time - this.visualCandidate.firstTime >= 2000) {
        if (!this.previousDelta && this.committed && !this.sameLogicalRoad(this.committed.road, road) &&
            this.lastValidDeltaSeconds != null) {
          this.previousDelta = { value: this.lastValidDeltaSeconds,
            sourceRef: this.committed.road.ref || null, lastValidAt: this.lastValidDeltaAt,
            sessionId: this.sessionId };
          this.localEvidenceMs = 0;
          this.lastReliableLocal = null;
        }
        this.visualRoad = this.roadView(road);
        this.visualCandidate = null;
      }
    } else this.visualCandidate = null;
    this.visualSpeedKmh = speedKmh;
    const visualSource = this.byId.get(this.visualRoad?.id) || this.localRoads.find(r => r.id === this.visualRoad?.id);
    if (visualSource?.id === road.id && reliable) {
      this.visualLimitKmh = limitAt(road, selected.match.alongM);
      this.visualLimitAssumed = limitAssumedAt(road, selected.match.alongM);
    } else if (this.visualRoad && this.visualRoad.id !== road.id) {
      this.visualLimitKmh = null;
      this.visualLimitAssumed = false;
    }
  }

  connectedLocal(a, b) {
    if (this.sameLogicalRoad(a, b)) return true;
    if (!a || !b || this.byId.has(a.id) || this.byId.has(b.id)) return false;
    const av = vertices(a), bv = vertices(b);
    return av.length > 1 && bv.length > 1 &&
      [av[0], av.at(-1)].some(p => [bv[0], bv.at(-1)].some(q => distanceM(p, q) <= 20));
  }

  updateLocalEvidence(selected, time, accuracy) {
    const road = selected.road;
    const reliable = accuracy <= 30 && selected.match.distanceM <= 30 && selected.turn <= 45;
    if (this.byId.has(road.id) && reliable) {
      this.localEvidenceMs = 0;
      this.lastReliableLocal = null;
      return false;
    }
    const visualLocal = this.localRoads.find(r => r.id === this.visualRoad?.id);
    if ((!this.sessionId && !this.gapAnchor) || this.visualRoad?.kind !== 'local' ||
        road.highway === 'motorway_link' || this.byId.has(road.id) || !reliable ||
        !this.connectedLocal(this.lastReliableLocal?.road || visualLocal, road)) {
      this.lastReliableLocal = null;
      return false;
    }
    if (this.lastReliableLocal && this.connectedLocal(this.lastReliableLocal.road, road) &&
        time - this.lastReliableLocal.time <= this.options.maxGapMs)
      this.localEvidenceMs += Math.max(0, time - this.lastReliableLocal.time);
    this.lastReliableLocal = { road, time };
    return this.localEvidenceMs >= 20000;
  }

  completeLocalFallback(selected, time, speedKmh) {
    const prior = this.previousDelta;
    const completedSession = { sessionId: this.sessionId, entryTime: this.entryTime,
      approachTime: this.approachTime, exitTime: null, confirmationTime: time,
      finalDeltaSeconds: null, finalTimingStatus: 'incomplete',
      lastValidDeltaSeconds: prior?.value ?? this.lastValidDeltaSeconds,
      lastValidDeltaAt: prior?.lastValidAt ?? this.lastValidDeltaAt,
      status: 'completed-local-evidence' };
    return this.finishLocalSession(completedSession, selected, time, speedKmh);
  }

  finishLocalSession(completedSession, selected, time, speedKmh) {
    this.reset();
    this.completedSession = completedSession;
    this.currentRoad = selected.road;
    this.visualRoad = this.roadView(selected.road);
    this.visualSpeedKmh = speedKmh;
    this.visualLimitKmh = limitAt(selected.road, selected.match.alongM);
    this.visualLimitAssumed = limitAssumedAt(selected.road, selected.match.alongM);
    this.gpsStatus = 'fresh';
    this.lastTime = time;
    this.lastAcceptedFixAt = Date.now();
    return this.decorate({ ...empty('local'), road: this.visualRoad,
      speedKmh, limitKmh: this.visualLimitKmh, limitAssumed: this.visualLimitAssumed,
      completedSession, acceptedFix: true, lastAcceptedFixAt: this.lastAcceptedFixAt }, time);
  }

  decorate(state, time = Date.now()) {
    this.tick(time, false);
    const gpsStatus = this.gpsStatus;
    const visuallyConfirmedMainline = state.acceptedFix && this.visualRoad?.isExpressway &&
      this.visualCandidate == null && this.visualRoad.id === state.candidateRoad?.id;
    const roadMatchStatus = visuallyConfirmedMainline ||
      state.acceptedFix && state.status !== 'identifying' && state.road ?
      'identified' : state.status === 'identifying' || state.candidateRoad || this.visualRoad ?
        'checking' : 'unresolved';
    const timingBasis = this.sinceGpsRecovery ? 'since GPS recovery' :
      this.timingFromMainline ? 'since mainline entry' :
      this.approachTime != null ? 'since entrance approach' :
      this.expresswayEntryTime != null ? 'since mainline entry' : state.timingBasis;
    this.state = { ...state, visualRoad: this.visualRoad,
      visualSpeedKmh: state.status === 'stale' ? null : this.visualSpeedKmh,
      visualLimitKmh: state.status === 'stale' ? null : this.visualLimitKmh,
      visualLimitAssumed: this.visualLimitAssumed,
      visualLimitSource: this.visualLimitKmh == null ? null :
        this.visualLimitAssumed ? 'Assumed 50 km/h reference' : 'OSM maxspeed tag',
      previousDelta: this.previousDelta, completedSession: this.completedSession,
      incompleteJourney: this.incompleteJourney, incompleteHistory: this.incompleteHistory,
      recovery: this.recovery, recoveryReason: this.recoveryReason,
      sessionId: this.sessionId, entryTime: this.entryTime,
      approachTime: this.approachTime, expresswayEntryTime: this.expresswayEntryTime,
      mainlineEntryTime: this.expresswayEntryTime, timingBasis,
      gpsStatus, roadMatchStatus, timingStatus: state.deltaStatus,
      routeContext: this.visualRoad?.isExpressway ? this.visualRoad : this.lastLiveState?.road || null,
      lastValidDeltaSeconds: this.lastValidDeltaSeconds,
      lastValidDeltaAt: this.lastValidDeltaAt,
      deltaStatus: this.sessionId == null && state.deltaStatus !== 'live' ? 'not-started' : state.deltaStatus };
    return this.state;
  }

  tick(now = Date.now(), updateState = true) {
    const time = timestampMs(now);
    if (updateState) this.state = { ...this.state, previousDelta: this.previousDelta,
      completedSession: this.completedSession,
      incompleteJourney: this.incompleteJourney, incompleteHistory: this.incompleteHistory,
      recovery: this.recovery, recoveryReason: this.recoveryReason,
      sessionId: this.sessionId,
      entryTime: this.entryTime,
      lastValidDeltaSeconds: this.lastValidDeltaSeconds,
      lastValidDeltaAt: this.lastValidDeltaAt,
      deltaStatus: this.state.deltaStatus,
      elapsedClockSeconds: this.entryTime == null ? null : Math.max(0, (time - this.entryTime) / 1000) };
    return this.state;
  }

  diagnosticSnapshot() {
    return { lastFix: this.lastFixDiagnostic, candidates: this.candidateDiagnostics,
      state: { status: this.state.status, reason: this.state.reason,
        gpsStatus: this.state.gpsStatus, roadMatchStatus: this.state.roadMatchStatus,
        timingStatus: this.state.timingStatus, approachTime: this.approachTime,
        expresswayEntryTime: this.expresswayEntryTime, sessionId: this.sessionId,
        gapAnchorRoadId: this.gapAnchor?.road.id || null,
        reconstructionStatus: this.reconstructionStatus, recovery: this.recovery,
        incompleteJourney: this.incompleteJourney,
        rampTransition: this.rampTransition } };
  }

  connected(from, to) {
    return !!this.forwardPath(from, to);
  }

  successors(road) {
    return [...(this.edges.get(road?.id) || [])].map(id => this.routeById.get(id)).filter(Boolean);
  }

  forwardPath(from, to) {
    if (from?.nextRoadIds?.includes(to?.id)) return [from, to];
    return this.uniquePath(from, to, 500);
  }

  gapPath(from, to) {
    return this.uniquePath(from, to, 50000);
  }

  recoveryRoute(from, to, fromM, toM, maxTravelM = 50000, requiredLinkId = null) {
    if (!from || !to) return null;
    const canReach = new Set([to.id]);
    const queue = [to.id];
    for (let i = 0; i < queue.length; i++)
      for (const predecessor of this.predecessors.get(queue[i]) || [])
        if (!canReach.has(predecessor)) {
          canReach.add(predecessor);
          queue.push(predecessor);
        }
    if (!canReach.has(from.id)) return { reasonCode: 'no-directed-route' };
    const stack = [{ road: from, path: [from], seen: new Set([from.id]), length: 0 }];
    let result = null, expansions = 0, routes = 0;
    while (stack.length && expansions++ < 20000) {
      const item = stack.pop();
      if (item.road.id === to.id) {
        if (requiredLinkId && !item.seen.has(requiredLinkId)) continue;
        if (++routes > 100) return { reasonCode: 'ambiguous-route' };
        const path = item.path;
        const reference = this.gapReference(path, fromM, toM);
        const travel = this.pathTravel(path, fromM, toM);
        const assumed = this.pathAssumed(path, fromM, toM);
        const refs = path.filter(road => this.byId.has(road.id) && !road.connector)
          .map(road => road.ref || road.id).filter((ref, i, all) => i === 0 || ref !== all[i - 1]);
        const candidate = { reference, travel, assumed, refs, routeCount: routes };
        if (reference == null || !Number.isFinite(travel)) continue;
        if (result &&
            (Math.abs(result.reference - reference) > 1e-6 ||
              Math.abs(result.travel - travel) > 0.01 || result.assumed !== assumed ||
              JSON.stringify(result.refs) !== JSON.stringify(refs)))
          return { reasonCode: 'ambiguous-route' };
        result = candidate;
        continue;
      }
      for (const next of this.successors(item.road)) {
        if (item.seen.has(next.id) || !canReach.has(next.id)) continue;
        const length = item.length + (next.id === to.id ? 0 : next.lengthM || roadLengthM(next));
        if (length <= Math.min(50000, maxTravelM + fromM))
          stack.push({ road: next, path: [...item.path, next],
          seen: new Set([...item.seen, next.id]), length });
      }
    }
    return expansions >= 20000 ? { reasonCode: 'route-search-limit' } :
      result || { reasonCode: 'no-directed-route' };
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
      const entry = this.pathEntryAt(path, i, fromM);
      const end = i === path.length - 1 ? toM : path[i].lengthM || roadLengthM(path[i]);
      if (!Number.isFinite(entry) || end < entry - 2) return null;
      const part = referenceTime(path[i], Math.min(entry, end), end);
      if (part == null) return null;
      seconds += part;
    }
    return seconds;
  }

  pathAssumed(path, fromM, toM) {
    return path.some((road, i) => referenceAssumedOn(road, this.pathEntryAt(path, i, fromM),
      i === path.length - 1 ? toM : road.lengthM || roadLengthM(road)));
  }

  pathEntryAt(path, index, fromM) {
    if (index === 0) return fromM;
    const key = `${path[index - 1].id}:${path[index].id}`;
    return this.edgeEntries.has(key) ? this.edgeEntries.get(key) ?? NaN : 0;
  }

  pathTravel(path, fromM, toM) {
    let distance = 0;
    for (let i = 0; i < path.length; i++) {
      const entry = this.pathEntryAt(path, i, fromM);
      const end = i === path.length - 1 ? toM : path[i].lengthM || roadLengthM(path[i]);
      if (!Number.isFinite(entry) || end < entry - 2) return NaN;
      distance += end - Math.min(entry, end);
    }
    return distance;
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
      const previous = this.routeById.get(id);
      if (!previous) continue;
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
    return path ? this.gapReference(path, fromM, toM) : null;
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
    if (this.rampLinks.has(a.id) && this.rampLinks.has(b.id)) {
      let current = a.id, seen = new Set(), length = 0;
      while (current && !seen.has(current) && length <= 5000 && seen.size < 64) {
        if (current === b.id) return true;
        seen.add(current);
        const link = this.rampLinks.get(current);
        length += roadLengthM(this.localRoads.find(r => r.id === current) || { coordinates: [] });
        const next = link?.nextLinkIds || [];
        current = next.length === 1 ? next[0] : null;
      }
    }
    if (!this.byId.has(a.id) && !this.byId.has(b.id) && a.name && a.name === b.name) {
      const av = vertices(a), bv = vertices(b);
      const near = distanceM(av.at(-1), bv[0]) < 60 ||
        (!a.oneway && !b.oneway && distanceM(av[0], bv.at(-1)) < 60);
      const turn = angleDifference(bearingDegrees(av[0], av.at(-1)),
        bearingDegrees(bv[0], bv.at(-1)));
      return near && (!(a.oneway && b.oneway) || turn <= 60);
    }
    return false;
  }

  rampTransitionForPaths(paths) {
    const unique = values => [...new Set(values)];
    const origins = unique(paths.map(path => this.byId.get(path.fromRoadId)?.ref || path.fromRoadId));
    const destinations = unique(paths.map(path => this.byId.get(path.toRoadId)?.ref || path.toRoadId));
    // A downstream fork does not change whether the observed ramp leaves a mainline.
    // A leaving/transfer conflict does change the session outcome, so keep it unknown.
    const outcomes = unique(paths.map(path => `${path.kind}:${path.kind === 'joining' ? '' :
      this.byId.get(path.fromRoadId)?.ref || path.fromRoadId}`));
    const classification = outcomes.length === 1 ? paths[0].kind : 'unknown';
    const fromIds = unique(paths.map(path => path.fromRoadId));
    const toIds = unique(paths.map(path => path.toRoadId));
    const first = paths[0]?.linkIds || [];
    const firstMismatch = first.findIndex((id, index) =>
      paths.some(path => path.linkIds?.[index] !== id));
    const linkIds = first.slice(0, firstMismatch < 0 ? first.length : firstMismatch);
    const boundaryKeys = unique(paths.map(path => JSON.stringify([
      path.kind === 'joining' ? path.endCoordinate : path.startCoordinate,
      path.kind === 'joining' ? path.toRoadId : path.fromRoadId,
      path.kind === 'joining' ? path.linkIds?.at(-1) : path.linkIds?.[0]])));
    const boundaryCoordinate = paths[0] && (classification === 'joining' ?
      paths[0].endCoordinate : paths[0].startCoordinate);
    const exactBoundary = classification !== 'unknown' && boundaryKeys.length === 1 &&
      Array.isArray(boundaryCoordinate) && boundaryCoordinate.length === 2 &&
      boundaryCoordinate.every(Number.isFinite);
    return { classification, confidence: 'provisional',
      originRef: origins.length === 1 ? this.byId.get(paths[0].fromRoadId)?.ref || null : null,
      destinationRef: destinations.length === 1 ? this.byId.get(paths[0].toRoadId)?.ref || null : null,
      fromRoadId: fromIds.length === 1 ? fromIds[0] : null,
      toRoadId: toIds.length === 1 ? toIds[0] : null,
      linkIds, pathCount: outcomes.length, exactPathCount: paths.length,
      candidatePaths: paths,
      candidatePathIds: paths.map(path => `${path.fromRoadId}:${path.linkIds.join(',')}:${path.toRoadId}`),
      boundary: exactBoundary ? { coordinate: boundaryCoordinate,
        provenance: this.rampGraph.source || 'exact directed OSM shared nodes',
        timing: 'unobserved', estimatedTime: null } : null };
  }

  classifyRamp(road, priorRoad) {
    if (!road || !this.rampLinks.has(road.id)) return null;
    const activeMainline = priorRoad && this.byId.has(priorRoad.id);
    const paths = (this.rampGraph.paths || []).filter(path => path.linkIds?.includes(road.id) &&
      (activeMainline ? ['leaving', 'transfer'].includes(path.kind) &&
        (path.fromRoadId === priorRoad.id || this.forwardPath(priorRoad, this.byId.get(path.fromRoadId))) :
        path.kind === 'joining' && priorRoad &&
        (path.fromRoadId === priorRoad.id || this.rampLinks.has(priorRoad.id))));
    return this.rampTransitionForPaths(paths);
  }

  estimateExitBoundary(transition, road, match, time, accuracy) {
    const anchor = this.gapAnchor || this.committed;
    if (!transition || !['leaving', 'transfer'].includes(transition.classification) ||
        !anchor || !transition.boundary || time - anchor.fix.time > 5000 ||
        accuracy > 30 || (anchor.accuracy ?? Infinity) > 30 ||
        transition.linkIds[0] !== road.id) return transition;
    const coordinate = transition.boundary.coordinate;
    const projection = project([coordinate[1], coordinate[0]], anchor.road);
    if (!projection || projection.distanceM > 20) return transition;
    const mainDistance = projection.alongM - anchor.fix.alongM;
    const rampDistance = match.alongM;
    if (mainDistance < 0 || rampDistance < 0 || mainDistance + rampDistance < 1) return transition;
    const fraction = mainDistance / (mainDistance + rampDistance);
    return { ...transition, boundary: { ...transition.boundary,
      timing: 'estimated', estimatedTime: Math.round(anchor.fix.time + (time - anchor.fix.time) * fraction),
      alongM: projection.alongM, referenceSeconds: referenceTime(anchor.road, anchor.fix.alongM, projection.alongM),
      assumedReference: referenceAssumedOn(anchor.road, anchor.fix.alongM, projection.alongM),
      uncertaintyMs: Math.round((accuracy + (this.lastLiveState?.matchedDistanceM || 0)) /
        Math.max(2, (mainDistance + rampDistance) / ((time - anchor.fix.time) / 1000)) * 1000) } };
  }

  update(fix) {
    const time = timestampMs(fix?.timestamp);
    const latitude = fix?.latitude == null ? NaN : Number(fix.latitude);
    const longitude = fix?.longitude == null ? NaN : Number(fix.longitude);
    const accuracy = fix?.accuracy == null ? NaN : Number(fix.accuracy);
    this.lastFixDiagnostic = { time: Number.isFinite(time) ? time : null,
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
      accuracy: Number.isFinite(accuracy) ? accuracy : null };
    if (!Number.isFinite(time) || !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 || Math.abs(longitude) > 180 ||
        !Number.isFinite(accuracy) || accuracy < 0 || accuracy > this.options.maxAccuracyM) {
      return this.invalidate('GPS accuracy or position unavailable');
    }
    if (this.lastTime != null && time <= this.lastTime)
      return this.decorate({ ...this.state, acceptedFix: false, lastAcceptedFixAt: this.lastAcceptedFixAt }, time);
    if (this.lastTime != null && time - this.lastTime > this.options.maxGapMs) {
      this.visualCandidate = null;
      this.beginGap();
    }
    this.lastTime = time;
    this.gpsStatus = accuracy <= 30 ? 'fresh' : 'weak';
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
    this.candidateDiagnostics = candidates.slice(0, 12).map(c => ({ id: c.road.id,
      score: c.score, distanceM: c.match.distanceM, turnDegrees: c.turn,
      reason: c.turn > 105 ? 'heading mismatch' : null }));
    let selected = candidates[0];
    if (!selected || (headingUseful && selected.turn > 105)) {
      this.lastReliableLocal = null;
      this.visualCandidate = null;
      this.beginGap();
      this.pending = null;
      return this.heldState('identifying', 'No reliable road match', speedKmh, null, time, true);
    }

    const joiningCandidate = this.rampTransition?.classification === 'joining' ?
      candidates.find(c => c.road.id === this.rampTransition.toRoadId && c.turn <= 45) : null;
    const knownMainline = this.currentRoad && this.byId.has(this.currentRoad.id) &&
      this.currentRoad.highway !== 'motorway_link' && !this.currentRoad.connector;
    const continuedMainline = knownMainline && this.rampLinks.has(selected.road.id) ?
      candidates.find(c => this.byId.has(c.road.id) && c.road.highway !== 'motorway_link' &&
        this.sameLogicalRoad(this.currentRoad, c.road) && c.turn <= 45 &&
        c.match.distanceM <= 30 && c.score <= selected.score + Math.max(5, accuracy / 2) &&
        (!this.previous || c.road.id !== this.currentRoad.id ||
          c.match.alongM >= this.previous.alongM - 35)) : null;
    const boundaryCoordinate = this.rampTransition?.boundary?.coordinate;
    const mappedJoinNearby = joiningCandidate && boundaryCoordinate && accuracy <= 30 &&
      distanceM(point, [boundaryCoordinate[1], boundaryCoordinate[0]]) <= 100 &&
      joiningCandidate.match.distanceM <= selected.match.distanceM + accuracy + 10;
    if (mappedJoinNearby) selected = joiningCandidate;
    if (continuedMainline) selected = continuedMainline;
    const selectedMainline = this.byId.has(selected.road.id);
    const ambiguous = !mappedJoinNearby && !continuedMainline && candidates.find(c => this.byId.has(c.road.id) !== selectedMainline &&
      Math.abs(c.match.distanceM - selected.match.distanceM) < Math.max(5, accuracy / 2) &&
      c.turn < 65 && c.score - selected.score < 12);
    if (ambiguous) {
      this.lastReliableLocal = null;
      this.visualCandidate = null;
      this.beginGap();
      this.pending = null;
      return this.heldState('identifying', 'Road level ambiguous', speedKmh, null, time, true);
    }

    this.updateVisual(selected, time, accuracy, speedKmh);
    const localEvidenceComplete = this.updateLocalEvidence(selected, time, accuracy);

    const selectedExpressway = this.byId.has(selected.road.id);
    const credibleApproach = selected.road.highway === 'motorway_link' &&
      accuracy <= 30 && selected.match.distanceM <= 30 && headingUseful && selected.turn <= 45 &&
      (this.rampGraph.paths || []).some(path => path.kind === 'joining' &&
        path.linkIds?.includes(selected.road.id) && this.byId.has(path.toRoadId));
    if (credibleApproach && this.approachTime == null && this.expresswayEntryTime == null && !this.committed) {
      this.approachTime = time;
      this.entryTime = time;
      this.entrySource = 'first-joining-ramp-fix';
      this.entryConfidence = 'provisional';
      this.sessionId ??= `session-${this.nextSessionId++}`;
      this.approachAnchor = { road: selected.road,
        fix: { time, alongM: selected.match.alongM, point }, accuracy,
        elapsed: 0, reference: 0, assumed: false, provisional: true };
    }
    if (this.rampLinks.has(selected.road.id)) {
      const existing = this.rampTransition;
      const reliableRampEvidence = accuracy <= 30 && selected.match.distanceM <= 30 &&
        selected.turn <= 45 && headingUseful;
      const matchingPaths = existing?.candidatePaths?.filter(path =>
        path.linkIds?.includes(selected.road.id)) || [];
      const incompatible = !!existing?.candidatePaths?.length && !matchingPaths.length;
      let transition = !reliableRampEvidence && existing?.candidatePaths?.length ? existing :
        incompatible ? { ...existing, classification: 'unknown',
        confidence: 'provisional', boundary: null, incompatibleRamp: true } :
        matchingPaths.length && matchingPaths.length === existing?.candidatePaths?.length &&
        !existing.incompatibleRamp ? existing :
        matchingPaths.length ? this.rampTransitionForPaths(matchingPaths) :
          this.classifyRamp(selected.road, this.currentRoad);
      if (transition !== existing && matchingPaths.length && existing?.boundary?.timing === 'estimated' &&
          transition.boundary && JSON.stringify(transition.boundary.coordinate) ===
            JSON.stringify(existing.boundary.coordinate))
        transition = { ...transition, boundary: existing.boundary };
      if (transition && (!existing || transition !== existing))
        transition = this.estimateExitBoundary(transition, selected.road, selected.match, time, accuracy);
      if (transition) {
        if (reliableRampEvidence && this.rampFirstFix &&
            existing?.classification === transition.classification &&
            time - this.rampFirstFix.time >= 1000 && transition.classification !== 'unknown')
          transition = { ...transition, confidence: 'confirmed' };
        this.rampTransition = transition;
        if (reliableRampEvidence) {
          this.rampFirstFix ??= { road: selected.road, match: selected.match, time, accuracy };
          this.lastRampFix = { road: selected.road, match: selected.match, time, accuracy };
        }
      }
    }
    if (selectedExpressway && !this.rampLinks.has(selected.road.id) &&
        this.rampTransition?.classification === 'joining' &&
        this.rampTransition.toRoadId === selected.road.id && this.lastRampFix &&
        this.rampTransition.candidatePaths?.some(path =>
          path.toRoadId === selected.road.id && path.linkIds?.at(-1) === this.lastRampFix.road.id) &&
        time - this.lastRampFix.time > 0 && time - this.lastRampFix.time <= 5000 &&
        accuracy <= 30 && this.lastRampFix.accuracy <= 30 && headingUseful && selected.turn <= 45) {
      const coordinate = this.rampTransition.boundary?.coordinate;
      const boundary = coordinate && project([coordinate[1], coordinate[0]], selected.road);
      const rampRemain = roadLengthM(this.lastRampFix.road) - this.lastRampFix.match.alongM;
      const mainDistance = boundary ? selected.match.alongM - boundary.alongM : -1;
      if (boundary && boundary.distanceM <= 20 && rampRemain >= 0 && mainDistance >= 0 &&
          rampRemain + mainDistance > 1) {
        const estimate = Math.round(this.lastRampFix.time + (time - this.lastRampFix.time) *
          rampRemain / (rampRemain + mainDistance));
        this.joinEvidence = { entryTime: estimate, elapsed: (time - estimate) / 1000,
          reference: referenceTime(selected.road, boundary.alongM, selected.match.alongM),
          assumed: referenceAssumedOn(selected.road, boundary.alongM, selected.match.alongM),
          boundary: { ...this.rampTransition.boundary, timing: 'estimated', estimatedTime: estimate,
            alongM: boundary.alongM } };
        this.rampTransition = { ...this.rampTransition, boundary: this.joinEvidence.boundary };
        if (!this.gapAnchor) {
          this.timingFromMainline = true;
          this.entryTime = estimate;
          this.entrySource = 'mapped-ramp-boundary-estimate';
        }
      }
    }
    const credibleEntry = selectedExpressway && selected.road.highway !== 'motorway_link' &&
      !selected.road.connector && !this.rampLinks.has(selected.road.id) &&
      !this.byId.has(this.currentRoad?.id) &&
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
        accuracy, heading, elapsed: this.joinEvidence?.elapsed || 0,
        reference: this.joinEvidence?.reference || 0, assumed: !!this.joinEvidence?.assumed };
      this.sessionId ??= `session-${this.nextSessionId++}`;
      if (this.approachTime == null) {
        this.entryTime = this.joinEvidence?.entryTime || time;
        this.entrySource = this.joinEvidence ? 'mapped-ramp-boundary-estimate' : 'first-mainline-fix';
      }
      if (!this.gapAnchor || this.joinEvidence) this.expresswayEntryTime = this.joinEvidence?.entryTime || time;
      this.entryConfidence = isTunnel(selected.road, selected.match.alongM) ? 'low' : 'approximate';
      this.entryUncertaintyMs = Math.round(accuracy / Math.max(2, speedMps || 0) * 1000);
    }
    if (this.gapAnchor) {
      const anchor = this.gapAnchor;
      if (selectedExpressway) {
        const stationaryOnKnownMainline = !headingUseful &&
          this.visualRoad?.isExpressway && this.visualRoad.id === selected.road.id &&
          !candidates.some(candidate => candidate.road.id !== selected.road.id &&
            this.byId.has(candidate.road.id) &&
            candidate.score - selected.score < 12 &&
            candidate.match.distanceM - selected.match.distanceM < Math.max(5, accuracy / 2));
        const reliable = accuracy <= 30 && selected.match.distanceM <= 30 &&
          (headingUseful ? selected.turn <= 45 : stationaryOnKnownMainline);
        if (reliable) {
          const priorReliable = this.recoveryLastReliableAt;
          const connectedReliable = priorReliable &&
            (this.sameLogicalRoad(priorReliable.road, selected.road) ||
              this.edges.get(priorReliable.road.id)?.has(selected.road.id));
          if (connectedReliable)
            this.recoveryReliableMs += Math.max(0, time - priorReliable.time);
          else this.recoverySegmentAnchor = { road: selected.road,
            alongM: selected.match.alongM, time };
          this.recoveryLastReliableAt = { road: selected.road, time };
        } else {
          this.recoveryLastReliableAt = null;
          this.recoverySegmentAnchor = null;
        }
        const dt = (time - anchor.fix.time) / 1000;
        const observedTransferLink = this.rampTransition?.classification === 'transfer' &&
          this.lastRampFix?.time > anchor.fix.time ? this.lastRampFix.road.id : null;
        const route = reliable ? this.recoveryRoute(anchor.road, selected.road,
          anchor.fix.alongM, selected.match.alongM, dt * 55 + accuracy * 3,
          observedTransferLink) : null;
        const plausible = route && route.reference != null && dt > 0 && route.travel >= 0 &&
          route.travel <= dt * 55 + accuracy * 3;
        this.recoveryReason = !reliable ? 'weak-mainline-fix' : route?.reasonCode ||
          (!plausible ? 'implausible-travel' : 'confirming-route');
        this.recovery = { phase: 'pending', reasonCode: this.recoveryReason,
          reliableMs: this.recoveryReliableMs };
        if (plausible) {
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
            this.referenceSeconds = anchor.reference + route.reference;
            this.cumulativeReferenceAssumed = anchor.assumed || route.assumed;
            this.appliedGaps.add(anchor.id);
          }
          this.currentRoad = selected.road;
          this.previous = { time, alongM: selected.match.alongM, point };
          this.confirmed = true;
          this.deltaValid = true;
          this.fullSessionAvailable = true;
          this.reconstructionStatus = 'reconstructed';
          this.recoveryReason = route.routeCount > 1 ? 'equivalent-directed-routes' :
            'unique-directed-route';
          this.recovery = { phase: 'reconstructed', reasonCode: this.recoveryReason,
            reliableMs: this.recoveryReliableMs };
          this.sessionStartMs = this.entryTime;
          this.provisional = null;
          this.gapAnchor = null;
          this.recoveryCandidate = null;
          this.gapStart = null;
          this.reacquiring = false;
        } else {
          this.recoveryCandidate = null;
          this.reconstructionStatus = 'unresolved';
          if (reliable && this.recoveryReliableMs >= 10000)
            this.retireUnresolvedGap(selected, time, accuracy, point);
          else return this.heldState('identifying', 'Route through GPS gap unresolved', speedKmh,
            { id: selected.road.id, name: selected.road.name, kind: 'expressway' }, time, true);
        }
      } else {
        this.recoveryLastReliableAt = null;
        this.recoverySegmentAnchor = null;
        const prior = this.recoveryCandidate;
        this.recoveryCandidate = prior && this.sameLogicalRoad(prior.road, selected.road) ? prior :
          { road: selected.road, time };
        const transfer = this.rampTransition?.classification === 'transfer';
        const unresolvedRamp = selected.road.highway === 'motorway_link' &&
          this.rampTransition?.classification !== 'leaving';
        const provenExit = this.rampTransition?.classification === 'leaving' &&
          this.rampFirstFix && this.lastRampFix && accuracy <= 30 &&
          time - this.lastRampFix.time <= this.options.maxGapMs &&
          selected.match.distanceM <= 30 && selected.turn <= 45 &&
          selected.road.highway !== 'motorway_link' &&
          this.rampTransition.candidatePaths?.some(path =>
            path.toRoadId === selected.road.id && path.linkIds?.at(-1) === this.lastRampFix.road.id);
        if (!transfer && !unresolvedRamp && provenExit && this.visualRoad?.id === selected.road.id) {
          const boundary = this.rampTransition?.classification === 'leaving' ? this.rampTransition.boundary : null;
          const anchor = this.gapAnchor;
          const estimated = boundary?.timing === 'estimated' && anchor &&
            boundary.referenceSeconds != null && boundary.estimatedTime >= anchor.fix.time;
          const finalDelta = estimated ? anchor.elapsed +
            (boundary.estimatedTime - anchor.fix.time) / 1000 -
            (anchor.reference + boundary.referenceSeconds) : null;
          this.completedSession = { sessionId: this.sessionId, entryTime: this.entryTime,
            exitTime: estimated ? boundary.estimatedTime : null,
            confirmationTime: time, finalDeltaSeconds: finalDelta,
            finalTimingStatus: estimated ? 'estimated-boundary' : 'incomplete',
            lastValidDeltaSeconds: this.lastValidDeltaSeconds,
            lastValidDeltaAt: this.lastValidDeltaAt,
            elapsedSeconds: estimated ? (boundary.estimatedTime - this.entryTime) / 1000 : anchor?.elapsed ?? null,
            referenceSeconds: estimated ? anchor.reference + boundary.referenceSeconds : anchor?.reference ?? null,
            cumulativeReferenceAssumed: this.cumulativeReferenceAssumed || !!boundary?.assumedReference,
            boundary: boundary ? { coordinate: boundary.coordinate, provenance: boundary.provenance,
              timing: boundary.timing, estimatedTime: boundary.estimatedTime,
              uncertaintyMs: boundary.uncertaintyMs ?? null } : null,
            status: 'completed-with-gap' };
          return this.finishLocalSession(this.completedSession, selected, time, speedKmh);
        } else {
          if (localEvidenceComplete && !unresolvedRamp)
            return this.completeLocalFallback(selected, time, speedKmh);
          if (this.visualRoad?.kind === 'local' && !provenExit) {
            this.rampTransition = null;
            this.rampFirstFix = null;
            this.lastRampFix = null;
          }
          return this.heldState(transfer ? 'entering' : 'exiting',
          transfer ? 'Following mapped expressway transfer' : 'Confirming expressway exit', speedKmh,
          { id: selected.road.id, name: selected.road.name, kind: 'local' }, time, true);
        }
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
      const mappedJoin = selectedExpressway && this.rampTransition?.classification === 'joining' &&
        this.rampTransition.toRoadId === selected.road.id && accuracy <= 30 &&
        selected.match.distanceM <= 30 && headingUseful && selected.turn <= 45;
      const hold = this.confirmed && !mappedJoin ? this.options.switchHoldMs : 0;
      const neededFixes = mappedJoin ? 1 : (this.options.confirmationFixes || 2);
      if (this.pending.count < neededFixes || time - this.pending.firstTime < hold) {
        this.deltaValid = false;
        this.previous = null;
        this.sessionStartMs = null;
        return this.decorate({ ...empty(this.confirmed && currentExpressway ? 'exiting' :
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
          lastAcceptedFixAt: this.lastAcceptedFixAt }, time);
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
      this.reconstructionStatus = this.sinceGpsRecovery ? 'unresolved' : 'none';
      if (selectedExpressway && this.joinEvidence && this.pending.firstRoad.id === selected.road.id) {
        this.elapsedSeconds = this.joinEvidence.elapsed;
        this.referenceSeconds = this.joinEvidence.reference;
        this.cumulativeReferenceAssumed = this.joinEvidence.assumed;
      }
      if (selectedExpressway && this.sinceGpsRecovery &&
          this.recoveryStart?.endRoadId === this.pending.firstRoad.id) {
        this.elapsedSeconds = this.recoveryStart.elapsed;
        this.referenceSeconds = this.recoveryStart.reference;
        this.cumulativeReferenceAssumed = this.recoveryStart.assumed;
      }
      if (selectedExpressway) {
        if (!(currentExpressway && !this.fullSessionAvailable && this.entryTime != null)) {
          if (this.approachTime == null && !this.sinceGpsRecovery) {
            this.entryTime = this.joinEvidence?.entryTime || this.pending.firstTime;
            this.entrySource = this.joinEvidence ? 'mapped-ramp-boundary-estimate' : 'first-mainline-fix';
          }
          if (!this.gapAnchor || this.joinEvidence)
            this.expresswayEntryTime = this.joinEvidence?.entryTime || this.pending.firstTime;
          this.entryConfidence = isTunnel(this.pending.firstRoad, this.pending.firstMatch.alongM) ||
            this.pending.firstAccuracy > 40 ? 'low' : 'approximate';
          this.entryUncertaintyMs = Math.round(this.pending.firstAccuracy / Math.max(2, speedMps || 0) * 1000);
        }
        this.sessionStartMs = currentExpressway && !this.fullSessionAvailable ? time : this.entryTime;
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
      if (this.visualRoad?.kind === 'local') {
        this.rampTransition = null;
        this.rampFirstFix = null;
        this.lastRampFix = null;
      }
      if (this.sessionId && !this.committed && !this.gapAnchor) {
        if (!credibleApproach) {
          this.provisional = null;
          this.sessionId = null;
          this.entryTime = null;
          this.approachTime = null;
          this.approachAnchor = null;
          this.expresswayEntryTime = null;
          this.entrySource = null;
          this.entryConfidence = null;
          this.entryUncertaintyMs = null;
        }
      }
      this.currentRoad = road;
      this.previous = { time, alongM: match.alongM, point };
      this.elapsedSeconds = 0;
      this.referenceSeconds = 0;
      this.deltaValid = false;
      return this.decorate({ ...empty('local'), road: { id: road.id, ref: road.ref || null,
        name: road.name || road.ref || 'Unnamed road', direction: road.destination || '',
        kind: road.highway === 'motorway_link' ? 'ramp' : 'local', isExpressway: false },
        speedKmh, limitKmh: limitAt(road, match.alongM), limitAssumed: limitAssumedAt(road, match.alongM),
        limitSource: limitAssumedAt(road, match.alongM) ? 'Assumed 50 km/h reference' : 'OSM maxspeed tag',
        matchedDistanceM: match.distanceM, alongM: match.alongM,
        confidence: accuracy > 30 || match.distanceM > 30 ? 'low' : 'medium',
        completedSession: this.completedSession, rampTransition: this.rampTransition,
        acceptedFix: true,
        lastAcceptedFixAt: this.lastAcceptedFixAt }, time);
    }
    const oldRoad = this.currentRoad;
    const sameRoad = oldRoad?.id === road.id;
    const path = oldRoad && !sameRoad ? this.forwardPath(oldRoad, road) : null;
    const connected = !!path;
    const dt = this.previous ? (time - this.previous.time) / 1000 : 0;
    const progress = this.previous && sameRoad ? match.alongM - this.previous.alongM :
      this.previous && connected ? this.pathTravel(path, this.previous.alongM, match.alongM) : 0;
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
    if (this.rampTransition && accuracy <= 30 && match.distanceM <= 30 &&
        selected.turn <= 45 && road.highway !== 'motorway_link' &&
        (this.rampTransition.toRoadId === road.id ||
          (this.rampTransition.destinationRef && this.rampTransition.destinationRef === road.ref))) {
      this.rampTransition = null;
      this.rampFirstFix = null;
      this.lastRampFix = null;
      this.joinEvidence = null;
    }

    const inTunnel = isTunnel(road, match.alongM);
    const confidence = inTunnel || accuracy > 40 || match.distanceM > 35 ? 'low' :
      accuracy > 20 || match.distanceM > 18 || !headingUseful ? 'medium' : 'high';
    const deltaSeconds = this.deltaValid && limitKmh ? this.elapsedSeconds - this.referenceSeconds : null;
    const exits = this.upcomingExits(road, match.alongM).map(({ exit: e, distanceM: distance, road: exitRoad, atM }) => {
        const path = road.id === exitRoad.id ? [road] : this.gapPath(road, exitRoad);
        const reference = path ? this.gapReference(path, match.alongM, atM) : null;
        const referenceAssumed = path ? this.pathAssumed(path, match.alongM, atM) : null;
        const forecastSeconds = path && Number.isFinite(speedMps) && speedMps > 1 ? distance / speedMps : null;
        const projectedDeltaSeconds = deltaSeconds != null && forecastSeconds != null && reference != null ?
          deltaSeconds + forecastSeconds - reference : null;
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
      rampTransition: this.rampTransition,
      heldExits: []
    };
    if (deltaSeconds != null) {
      if (this.previousDelta?.sessionId === this.sessionId && this.committed &&
          this.sameLogicalRoad(this.committed.road, road)) {
        this.previousDelta = null;
        this.visualRoad = this.roadView(road);
        this.visualLimitKmh = limitAt(road, match.alongM);
        this.visualLimitAssumed = limitAssumedAt(road, match.alongM);
        this.visualCandidate = null;
      }
      this.sessionId ??= `session-${this.nextSessionId++}`;
      this.state.sessionId = this.sessionId;
      this.lastValidDeltaSeconds = deltaSeconds;
      this.lastValidDeltaAt = time;
      this.lastLiveState = this.state;
      this.committed = { road, fix: this.previous, elapsed: this.elapsedSeconds,
        reference: this.referenceSeconds, assumed: this.cumulativeReferenceAssumed, accuracy };
    }
    return this.decorate(this.state, time);
  }
}
