import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseExport, replay } from './replay-diagnostics.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const dataVersion = 'a'.repeat(64);
const road = { id: 'main', ref: 'ECP', speedLimit: 80,
  coordinates: [[103.9, 1.35], [103.91, 1.35]] };
const events = [
  { type: 'fix', seq: 0, recordedAt: '2026-11-08T00:00:00.000Z',
    fix: { latitude: 1.35, longitude: 103.901, accuracy: 5, heading: 90, speed: 15,
      timestamp: '2026-11-08T00:00:00.000Z' } },
  { type: 'fix', seq: 1, recordedAt: '2026-11-08T00:00:02.000Z',
    fix: { latitude: 1.35, longitude: 103.9011, accuracy: 5, heading: 90, speed: 15,
      timestamp: '2026-11-08T00:00:02.000Z' } },
  { type: 'state', seq: 2, recordedAt: '2026-11-08T00:00:02.000Z',
    state: { status: 'wrong-recorded-status', road: { id: 'wrong' }, visualRoad: { id: 'wrong' },
      gpsStatus: 'fresh', roadMatchStatus: 'identified', timingStatus: 'live',
      entryTime: null, deltaSeconds: 99 } },
  { type: 'signal', seq: 3, recordedAt: '2026-11-08T00:00:03.000Z', message: 'GPS unavailable' }
];
function bundle(items = events, version = dataVersion) {
  const expanded = Buffer.from(items.map(item => JSON.stringify(item)).join('\n') + '\n');
  const compressed = gzipSync(expanded, { mtime: 0 });
  return { manifest: { recordingId: '123e4567-e89b-42d3-a456-426614174000', formatVersion: 1,
    appVersion: '0.4.0', buildId: 'test', roadDataVersion: version, configuration: {},
    startedAt: items[0].recordedAt, endedAt: items.at(-1).recordedAt, issue: 'Replay test',
    eventCount: items.length, chunks: [{ index: 0, sha256: hash(compressed),
      compressedBytes: compressed.length, expandedBytes: expanded.length, eventCount: items.length }] },
    chunks: [{ index: 0, data: compressed.toString('base64') }] };
}

test('portable gzip replay is deterministic and distinguishes raw fixes from inferred state', () => {
  const parsed = parseExport(Buffer.from(JSON.stringify(bundle())));
  const run = () => replay(parsed, { roads: [road] }, { roads: [] }, { roadDataVersion: dataVersion });
  const a = run(), b = run();
  assert.deepEqual(a, b);
  assert.equal(a.eventCount, 4);
  assert.equal(a.observations.length, 2);
  assert.equal(a.gpsGaps, 1);
  assert.equal(a.timeline.at(-1).gpsStatus, 'unavailable');
  assert.equal(a.stateComparisonCount, 1);
  assert.equal(a.stateMismatchCount, 1);
  assert.ok(a.timeline.find(x => x.type === 'state').mismatches.includes('roadId'));
});

test('checksum, gzip, and sequence corruption are rejected', () => {
  const checksum = bundle();
  checksum.chunks[0].data = checksum.chunks[0].data.replace(/^./, checksum.chunks[0].data[0] === 'A' ? 'B' : 'A');
  assert.throws(() => parseExport(Buffer.from(JSON.stringify(checksum))), /checksum|gzip/);
  const order = bundle([events[1], events[0]]);
  order.manifest.startedAt = events[0].recordedAt;
  order.manifest.endedAt = events[1].recordedAt;
  assert.throws(() => parseExport(Buffer.from(JSON.stringify(order))), /sequence order/);
});

test('road-data mismatch requires explicit exploratory override', () => {
  const parsed = parseExport(Buffer.from(JSON.stringify(bundle())));
  assert.throws(() => replay(parsed, { roads: [road] }, { roads: [] }, { roadDataVersion: 'b'.repeat(64) }), /Road data mismatch/);
  const exploratory = replay(parsed, { roads: [road] }, { roads: [] },
    { roadDataVersion: 'b'.repeat(64), allowDataMismatch: true });
  assert.equal(exploratory.exploratoryDataMismatch, true);
});

test('legacy local JSON export can be replayed', () => {
  const parsed = parseExport(Buffer.from(JSON.stringify({ appVersion: '0.3.7', buildId: 'old', events })));
  assert.equal(parsed.legacy, true);
  assert.equal(replay(parsed, { roads: [road] }, { roads: [] }).eventCount, 4);
});

test('mid-session recording marks timing comparison unavailable but still checks road', () => {
  const start = { type: 'session', seq: 0, recordedAt: events[0].recordedAt,
    action: 'recording-start', sessionActive: true, entryTime: 1000 };
  const state = { ...events[2], seq: 2, state: { ...events[2].state,
    entryTime: 1000, deltaSeconds: 500 } };
  const report = replay({ events: [start, { ...events[0], seq: 1 }, state],
    manifest: null, legacy: true }, { roads: [road] }, { roads: [] });
  const comparison = report.timeline.find(row => row.type === 'state');
  assert.equal(comparison.timingComparisonUnavailable, true);
  assert.equal(comparison.deltaDifference, null);
  assert.ok(comparison.mismatches.includes('roadId'));
  assert.ok(!comparison.mismatches.includes('deltaSeconds'));
});
