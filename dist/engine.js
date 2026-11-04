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
  const value = zone?.limitKmh ?? zone?.speedKmh ?? road.limitKmh ?? road.speedLimitKmh ?? road.speedLimit;
  return Number.isFinite(value) && value > 0 ? value : null;
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
    limitKmh: null, deltaSeconds: null, elapsedSeconds: null, exits: [],
    alongM: null, matchedDistanceM: null, inTunnel: false };
}

export class Tracker {
  constructor(data, options = {}) {
    this.roads = (Array.isArray(data) ? data : data?.roads || []).filter(r => vertices(r).length >= 2);
    this.byId = new Map(this.roads.map(r => [r.id, r]));
    const local = options.localRoads || data?.localRoads || [];
    this.localRoads = (Array.isArray(local) ? local : local.roads || []).filter(r => vertices(r).length >= 2);
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
    this.options = { maxAccuracyM: 75, maxGapMs: 12000, maxMatchM: 85, ...options };
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
    this.state = empty('searching');
    return this.state;
  }

  invalidate(reason = 'GPS fix stale') {
    this.reset();
    return this.state = empty('stale', reason);
  }

  connected(from, to) {
    return !!this.forwardPath(from, to);
  }

  forwardPath(from, to) {
    if (!from || !to || from.ref !== to.ref) return null;
    const path = [from], seen = new Set([from.id]);
    let length = 0;
    while (path.length <= 100 && length <= 500) {
      const next = (path.at(-1).nextRoadIds || []).map(id => this.byId.get(id))
        .find(r => r && !seen.has(r.id) && r.ref === from.ref);
      if (!next) return null;
      path.push(next);
      if (next.id === to.id) return path;
      seen.add(next.id);
      length += next.lengthM || roadLengthM(next);
    }
    return null;
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
      const choices = (current.nextRoadIds || []).map(id => this.byId.get(id))
        .filter(next => this.connected(current, next));
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
    if (this.previous && time <= this.previous.time) return this.invalidate('Out-of-order GPS fix');
    if (this.previous && time - this.previous.time > this.options.maxGapMs) {
      this.previous = null;
      this.deltaValid = false;
      this.elapsedSeconds = 0;
      this.referenceSeconds = 0;
    }

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
      this.previous = null;
      this.currentRoad = null;
      this.deltaValid = false;
      return this.state = { ...empty('identifying', 'No reliable road match'), speedKmh };
    }

    const selectedMainline = this.byId.has(selected.road.id);
    const ambiguous = candidates.find(c => this.byId.has(c.road.id) !== selectedMainline &&
      Math.abs(c.match.distanceM - selected.match.distanceM) < Math.max(5, accuracy / 2) &&
      c.turn < 65);
    if (ambiguous) {
      this.previous = null;
      this.deltaValid = false;
      this.elapsedSeconds = 0;
      this.referenceSeconds = 0;
      this.confirmed = false;
      this.pending = null;
      return this.state = { ...empty('identifying', 'Road level ambiguous'), speedKmh };
    }

    const selectedExpressway = this.byId.has(selected.road.id);
    const currentExpressway = this.currentRoad && this.byId.has(this.currentRoad.id);
    const continuous = this.sameLogicalRoad(this.currentRoad, selected.road);
    const pendingSame = this.pending && this.sameLogicalRoad(this.pending.road, selected.road);
    if (!this.confirmed || !continuous) {
      this.pending = pendingSame ? { road: selected.road, count: this.pending.count + 1 } :
        { road: selected.road, count: 1 };
      if (this.pending.count < (this.options.confirmationFixes || 2)) {
        this.deltaValid = false;
        this.previous = null;
        this.elapsedSeconds = 0;
        this.referenceSeconds = 0;
        return this.state = { ...empty(this.confirmed && currentExpressway ? 'exiting' :
          this.confirmed && selectedExpressway ? 'entering' : 'identifying', 'Confirming road'),
          speedKmh, road: { id: selected.road.id, ref: selected.road.ref || null,
            name: selected.road.name || selected.road.ref || 'Unnamed road',
            direction: selected.road.travelDirection || selected.road.destination || selected.road.direction || '',
            kind: selectedExpressway ? 'expressway' : selected.road.highway === 'motorway_link' ? 'ramp' : 'local',
            isExpressway: selectedExpressway } };
      }
      this.confirmed = true;
      this.previous = null;
      this.elapsedSeconds = 0;
      this.referenceSeconds = 0;
      this.deltaValid = false;
    } else if (!this.previous) {
      this.elapsedSeconds = 0;
      this.referenceSeconds = 0;
      this.deltaValid = false;
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
        speedKmh, matchedDistanceM: match.distanceM, alongM: match.alongM,
        confidence: accuracy > 30 || match.distanceM > 30 ? 'low' : 'medium' };
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
    }
    const limitKmh = limitAt(road, match.alongM);
    const priorLimit = this.previous && (sameRoad || connected) ? limitAt(oldRoad, this.previous.alongM) : null;
    if (!limitKmh) this.deltaValid = false;
    else if (this.previous && (sameRoad || connected) && !priorLimit) {
      this.elapsedSeconds = 0;
      this.referenceSeconds = 0;
      this.deltaValid = true;
    }
    else if (!this.previous || (!sameRoad && !connected) || implausible) this.deltaValid = true;
    else if (this.deltaValid) {
      const reference = this.referenceAcross(oldRoad, this.previous.alongM, road, match.alongM);
      if (reference == null) this.deltaValid = false;
      else {
      this.elapsedSeconds += dt;
      this.referenceSeconds += reference;
      }
    }
    this.currentRoad = road;
    this.previous = { time, alongM: match.alongM, point };

    const inTunnel = isTunnel(road, match.alongM);
    const confidence = inTunnel || accuracy > 40 || match.distanceM > 35 ? 'low' :
      accuracy > 20 || match.distanceM > 18 || !headingUseful ? 'medium' : 'high';
    const deltaSeconds = this.deltaValid && limitKmh ? this.elapsedSeconds - this.referenceSeconds : null;
    const exits = this.upcomingExits(road, match.alongM).map(({ exit: e, distanceM: distance, road: exitRoad, atM }) => {
        let reference = referenceTime(road, match.alongM, road.lengthM || roadLengthM(road));
        if (exitRoad.id === road.id) reference = referenceTime(road, match.alongM, atM);
        else {
          let cursor = road;
          const visited = new Set();
          while (reference != null && cursor.id !== exitRoad.id && !visited.has(cursor.id)) {
            visited.add(cursor.id);
            const next = (cursor.nextRoadIds || []).map(id => this.byId.get(id)).find(r => this.connected(cursor, r));
            if (!next) { reference = null; break; }
            cursor = next;
            const part = referenceTime(cursor, 0, cursor.id === exitRoad.id ? atM : cursor.lengthM || roadLengthM(cursor));
            reference = part == null ? null : reference + part;
          }
        }
        const projectedDeltaSeconds = deltaSeconds != null && speedMps > 1 && reference != null ?
          deltaSeconds + distance / speedMps - reference : null;
        return { name: e.name || e.label || 'Unnamed exit', number: e.number ?? null,
          distanceM: distance, projectedDeltaSeconds, forecast: true };
      });
    return this.state = {
      status: 'tracking', reason: inTunnel ? 'Tunnel: GPS confidence reduced' : null,
      confidence, road: { id: road.id, ref: road.ref || null, name: road.name || road.ref || '',
        direction: road.travelDirection || road.direction || '', kind: 'expressway', isExpressway: true }, speedKmh, limitKmh, deltaSeconds,
      elapsedSeconds: this.elapsedSeconds, exits, alongM: match.alongM,
      matchedDistanceM: match.distanceM, inTunnel
    };
  }
}
