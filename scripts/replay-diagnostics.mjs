#!/usr/bin/env node
// Offline, bounded replay of a diagnostics export. No network or executable input.
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Tracker } from '../dist/engine.js';
import { validateManifest, validateEvent, MAX_COMPRESSED_BYTES } from '../dist/diagnostics-format.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_EVENTS = 100000;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };

export function parseExport(bytes) {
  if (bytes.length > MAX_FILE_BYTES) fail('Export exceeds 15 MiB input limit');
  let envelope;
  try { envelope = JSON.parse(bytes.toString('utf8')); } catch { fail('Invalid export JSON'); }
  if (Array.isArray(envelope?.events) && !envelope.manifest) {
    if (envelope.events.length > MAX_EVENTS) fail('Too many legacy events');
    return { manifest: null, legacy: true, events: envelope.events.map((event, index) => ({
      ...event, seq: index })) };
  }
  const { manifest, chunks } = envelope || {};
  if (!validateManifest(manifest)) fail('Invalid manifest or manifest limits');
  if (!Array.isArray(chunks) || chunks.length !== manifest.chunks.length) fail('Missing or extra chunks');
  const events = [];
  let previousSeq = -1;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i], meta = manifest.chunks[i];
    const encoded = chunk?.data ?? chunk?.gzipBase64 ?? chunk?.base64;
    if (chunk?.index !== i || typeof encoded !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
      fail(`Invalid chunk ${i} encoding or order`);
    const compressed = Buffer.from(encoded, 'base64');
    if (compressed.length !== meta.compressedBytes || compressed.length > MAX_COMPRESSED_BYTES ||
        digest(compressed) !== meta.sha256) fail(`Chunk ${i} checksum or size mismatch`);
    let expanded;
    try { expanded = gunzipSync(compressed, { maxOutputLength: meta.expandedBytes + 1 }); }
    catch { fail(`Chunk ${i} gzip invalid or expanded size exceeded`); }
    if (expanded.length !== meta.expandedBytes) fail(`Chunk ${i} expanded size mismatch`);
    const lines = expanded.toString('utf8').trimEnd().split('\n');
    if (lines.length !== meta.eventCount) fail(`Chunk ${i} event count mismatch`);
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { fail(`Chunk ${i} contains invalid NDJSON`); }
      if (!validateEvent(event) || event.seq !== previousSeq + 1) fail('Invalid event or sequence order');
      previousSeq = event.seq;
      events.push(event);
    }
  }
  if (events.length !== manifest.eventCount || events.length > MAX_EVENTS) fail('Event total invalid');
  return { manifest, legacy: false, events };
}

function eventTime(event) {
  const recorded = Date.parse(event.recordedAt);
  if (Number.isFinite(recorded)) return recorded;
  const timestamp = event.fix?.timestamp;
  return Number.isFinite(timestamp) ? (timestamp < 1e11 ? timestamp * 1000 : timestamp) : null;
}

function stateSummary(state) {
  return { status: state.status, roadId: state.road?.id ?? null,
    visualRoadId: state.visualRoad?.id ?? null, gpsStatus: state.gpsStatus,
    roadMatchStatus: state.roadMatchStatus, timingStatus: state.timingStatus,
    sessionId: state.sessionId, entryTime: state.entryTime,
    deltaSeconds: state.deltaSeconds ?? null, reconstructionStatus: state.reconstructionStatus };
}

export function replay({ events, manifest, legacy }, roadData, localData, options = {}) {
  const actualVersion = options.roadDataVersion || null;
  const requiredVersion = manifest?.roadDataVersion || null;
  const mismatch = requiredVersion && actualVersion !== requiredVersion;
  if (mismatch && !options.allowDataMismatch) fail(`Road data mismatch: recording ${requiredVersion}, loaded ${actualVersion || 'unknown'}; use --allow-data-mismatch for exploratory replay`);
  const tracker = new Tracker({ ...roadData, localRoads: localData?.roads || [] },
    manifest?.configuration?.engine || manifest?.configuration?.engineOptions || {});
  const originalNow = Date.now;
  const timeline = [];
  const observations = [];
  let clock = 0, previous = null, baselineIncomplete = false, baselineEntryTime = null;
  try {
    Date.now = () => clock;
    for (const event of events) {
      const at = eventTime(event);
      if (at == null) fail(`Event ${event.seq} has no usable timestamp`);
      clock = at;
      let state;
      if (event.type === 'session' && event.action === 'recording-start') {
        baselineIncomplete = !!(event.sessionActive ?? event.state?.sessionActive ?? event.state?.entryTime);
        baselineEntryTime = event.entryTime ?? event.state?.entryTime ?? null;
        continue;
      }
      if (event.type === 'fix') {
        state = tracker.update(event.fix);
        if (Number.isFinite(event.fix.latitude) && Number.isFinite(event.fix.longitude))
          observations.push({ seq: event.seq, time: at, latitude: event.fix.latitude,
            longitude: event.fix.longitude, accuracy: event.fix.accuracy ?? null });
      } else if (event.type === 'signal') {
        state = tracker.invalidate(event.message || 'GPS unavailable');
      } else if (event.type === 'session' && ['reset', 'start', 'stop'].includes(event.action)) {
        state = tracker.reset();
        baselineIncomplete = false;
      } else if (event.type === 'tick') {
        state = tracker.tick(at);
      } else if (event.type === 'state') {
        state = tracker.state;
      } else if (['error', 'visibility', 'session'].includes(event.type)) continue;
      else continue;
      const summary = stateSummary(state);
      const recorded = event.state || null;
      if (baselineIncomplete && recorded?.entryTime != null && baselineEntryTime != null &&
          recorded.entryTime !== baselineEntryTime) baselineIncomplete = false;
      const deltaDifference = !baselineIncomplete && Number.isFinite(recorded?.deltaSeconds) && Number.isFinite(summary.deltaSeconds) ?
        summary.deltaSeconds - recorded.deltaSeconds : null;
      const compared = recorded ? {
        status: recorded.status ?? null,
        roadId: recorded.road?.id ?? null,
        visualRoadId: recorded.visualRoad?.id ?? null,
        gpsStatus: recorded.gpsStatus ?? null,
        roadMatchStatus: recorded.roadMatchStatus ?? null,
        timingStatus: recorded.timingStatus ?? null,
        entryTime: recorded.entryTime ?? null,
        deltaSeconds: recorded.deltaSeconds ?? null
      } : null;
      const mismatches = compared ? Object.keys(compared).filter(key =>
        !(baselineIncomplete && ['entryTime', 'deltaSeconds', 'timingStatus'].includes(key)) &&
        (key === 'deltaSeconds' ? (compared[key] == null) !== (summary[key] == null) ||
          (compared[key] != null && Math.abs(compared[key] - summary[key]) > 0.001) :
          compared[key] !== (summary[key] ?? null))) : [];
      const changed = !previous || summary.roadId !== previous.roadId ||
        summary.visualRoadId !== previous.visualRoadId || summary.gpsStatus !== previous.gpsStatus ||
        summary.sessionId !== previous.sessionId || summary.reconstructionStatus !== previous.reconstructionStatus;
      timeline.push({ seq: event.seq, time: at, type: event.type, ...summary,
        recorded: compared, mismatches, timingComparisonUnavailable: baselineIncomplete,
        roadChange: changed && summary.roadId !== previous?.roadId,
        gpsGap: summary.gpsStatus === 'unavailable' && previous?.gpsStatus !== 'unavailable',
        sessionReset: previous?.sessionId != null && summary.sessionId == null,
        deltaDifference });
      previous = summary;
    }
  } finally { Date.now = originalNow; }
  return { formatVersion: manifest?.formatVersion || 0, legacy, exploratoryDataMismatch: !!mismatch,
    roadDataVersion: actualVersion, recordedRoadDataVersion: requiredVersion,
    eventCount: events.length, replayedCount: timeline.length,
    roadChanges: timeline.filter(x => x.roadChange).length,
    gpsGaps: timeline.filter(x => x.gpsGap).length,
    sessionResets: timeline.filter(x => x.sessionReset).length,
    deltaDifferenceCount: timeline.filter(x => x.deltaDifference != null && Math.abs(x.deltaDifference) > 0.001).length,
    stateComparisonCount: timeline.filter(x => x.recorded).length,
    stateMismatchCount: timeline.filter(x => x.mismatches.length).length,
    timeline, observations };
}

export function htmlReport(report, roads) {
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const points = report.observations;
  let minLat = 1.2, maxLat = 1.5, minLon = 103.6, maxLon = 104;
  if (points.length) {
    minLat = maxLat = points[0].latitude;
    minLon = maxLon = points[0].longitude;
    for (const p of points) {
      minLat = Math.min(minLat, p.latitude); maxLat = Math.max(maxLat, p.latitude);
      minLon = Math.min(minLon, p.longitude); maxLon = Math.max(maxLon, p.longitude);
    }
  }
  const x = lon => 20 + 960 * (lon - minLon) / Math.max(0.0001, maxLon - minLon);
  const y = lat => 520 - 500 * (lat - minLat) / Math.max(0.0001, maxLat - minLat);
  const observed = points.map(p => `<circle cx="${x(p.longitude).toFixed(1)}" cy="${y(p.latitude).toFixed(1)}" r="3" fill="#c0392b"><title>Observed seq ${p.seq}, accuracy ${escape(p.accuracy)} m</title></circle>`).join('');
  const nearby = (roads?.roads || []).filter(road => (road.coordinates || road.geometry || []).some(p => {
    const lon = Array.isArray(p) ? p[0] : p.longitude;
    const lat = Array.isArray(p) ? p[1] : p.latitude;
    return lon >= minLon - .005 && lon <= maxLon + .005 && lat >= minLat - .005 && lat <= maxLat + .005;
  })).slice(0, 150);
  const geometry = nearby.map(road => {
    const line = (road.coordinates || road.geometry || []).map(p => {
      const lon = Array.isArray(p) ? p[0] : p.longitude;
      const lat = Array.isArray(p) ? p[1] : p.latitude;
      return `${x(lon).toFixed(1)},${y(lat).toFixed(1)}`;
    }).join(' ');
    return `<polyline points="${line}" fill="none" stroke="#9aa6b2" stroke-width="1"/>`;
  }).join('');
  const inferred = report.timeline.filter(t => t.roadId || t.recorded).map(t => `<tr><td>${t.seq}</td><td>${escape(new Date(t.time).toISOString())}</td><td>${escape(t.recorded?.roadId ?? '')}</td><td>${escape(t.roadId)}</td><td>${escape(t.recorded?.deltaSeconds ?? '')}</td><td>${escape(t.deltaSeconds ?? '')}</td><td>${escape(t.mismatches.join(', '))}${t.timingComparisonUnavailable ? ' (timing unavailable)' : ''}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Delta offline replay</title><style>body{font:14px system-ui;max-width:1020px;margin:auto;padding:24px}svg{border:1px solid #aaa;background:#f7f7f7}table{border-collapse:collapse}td,th{padding:4px 8px;border:1px solid #ddd}</style><h1>Offline replay</h1><p>Red dots are raw observed GPS fixes. Gray lines are reference road geometry. The table compares recorded and replayed engine inference.</p><svg viewBox="0 0 1000 540" role="img" aria-label="Raw GPS observations and road geometry">${geometry}${observed}</svg><h2>Inference comparison</h2><table><tr><th>Seq</th><th>Time</th><th>Recorded road</th><th>Replay road</th><th>Recorded delta s</th><th>Replay delta s</th><th>Differences</th></tr>${inferred}</table>`;
}

async function main() {
  const args = process.argv.slice(2);
  const value = flag => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
  const input = value('--input') || args.find(arg => !arg.startsWith('--'));
  if (!input || args.includes('--help')) {
    process.stdout.write('Usage: node scripts/replay-diagnostics.mjs --input export.json [--roads roads.json] [--local-roads local-roads.json] [--allow-data-mismatch] [--html report.html]\n');
    return;
  }
  const readBounded = async (filename, limit = MAX_FILE_BYTES) => {
    const info = await stat(filename);
    if (!info.isFile() || info.size > limit) fail(`File too large or not a regular file: ${filename}`);
    const bytes = await readFile(filename);
    if (bytes.length > limit) fail(`File too large: ${filename}`);
    return bytes;
  };
  const parsed = parseExport(await readBounded(input));
  const roadsBytes = await readBounded(value('--roads') || path.join(root, 'dist/data/roads.json'), 64 * 1024 * 1024);
  const localBytes = await readBounded(value('--local-roads') || path.join(root, 'dist/data/local-roads.json'), 64 * 1024 * 1024);
  const roads = JSON.parse(roadsBytes.toString());
  const local = JSON.parse(localBytes.toString());
  const roadDataVersion = digest(Buffer.concat([roadsBytes, localBytes]));
  const report = replay(parsed, roads, local, { allowDataMismatch: args.includes('--allow-data-mismatch'), roadDataVersion });
  const html = value('--html');
  if (html) await writeFile(html, htmlReport(report, roads));
  const { observations, ...compact } = report;
  process.stdout.write(`${JSON.stringify(compact, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
