// Real local Worker/D1/R2 integration. Run only against a disposable local instance:
// DELTA_TEST_URL=http://127.0.0.1:4173 DELTA_TEST_KEY=<local fixture key> node --test scripts/diagnostics-worker.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { parseExport, replay } from './replay-diagnostics.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const origin = process.env.DELTA_TEST_URL;
const key = process.env.DELTA_TEST_KEY;
if (origin && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/?$/.test(origin))
  throw new Error('Diagnostics Worker integration is restricted to loopback URLs.');

test('real Worker stores, verifies, and exports a local recording', { skip: !origin || !key, timeout: 90000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  let recordingId;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    const before = await page.evaluate(async () => {
      const { DiagnosticsRecorder } = await import('./diagnostics.js');
      const recorder = new DiagnosticsRecorder({ appVersion: 'local-worker-test', buildId: 'local-worker-test',
        roadDataVersion: (await import('./version.js')).ROAD_DATA_VERSION,
        configuration: () => ({ test: true }), onChange: () => {} });
      await recorder.init();
      await recorder.start();
      recorder.capture('fix', { fix: { latitude: 1.31, longitude: 103.82, accuracy: 5,
        heading: 20, speed: 12, timestamp: Date.now() }, source: 'real-worker-test' });
      recorder.capture('state', { state: { status: 'tracking', deltaSeconds: 1.25 } });
      await recorder.stop();
      window.testRecorder = recorder;
      const usage = await recorder.usage();
      return { id: usage.records[0].id, chunks: usage.records[0].chunks.length,
        eventCount: usage.records[0].eventCount };
    });
    recordingId = before.id;
    assert.equal(before.chunks, 1);
    assert.equal(before.eventCount, 2);
    await page.evaluate(async key => window.testRecorder.upload((await window.testRecorder.usage()).records[0].id, key, 'Local integration test'), key);
    const after = await page.evaluate(() => window.testRecorder.usage());
    assert.equal(after.records.length, 0, 'verified upload deletes local chunks');
    assert.equal(after.receipts.length, 1);
    assert.equal(after.receipts[0].id, recordingId);
    await context.close();
  } finally { await browser.close(); }

  async function call(name, args) {
    const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: {
      'content-type': 'application/json', 'oai-authenticated-user-email': 'analyst@example.com',
      'oai-authenticated-user-id': 'local-integration-analyst',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    assert.equal(response.status, 200, `${name} HTTP ${response.status}`);
    const result = await response.json();
    assert.equal(result.result?.isError, undefined, `${name} returned tool error`);
    return JSON.parse(result.result.content[0].text);
  }
  const summary = await call('recording_summary', { recordingId });
  assert.equal(summary.manifestBase.recordingId, recordingId);
  const exported = await call('export_recording', { recordingId, index: 0 });
  assert.equal(exported.index, 0);
  const events = gunzipSync(Buffer.from(exported.data, 'base64')).toString('utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => event.seq), [0, 1]);
  const archive = { manifest: { ...summary.manifestBase, chunks: summary.chunkMetadata },
    chunks: [{ index: 0, data: exported.data }] };
  const parsed = parseExport(Buffer.from(JSON.stringify(archive)));
  assert.equal(parsed.events.length, 2);
  async function roadSnapshot(file) {
    const first = await call('export_road_data', { roadDataVersion: summary.manifestBase.roadDataVersion, file, offset: 0 });
    const parts = [Buffer.from(first.data, 'base64')];
    const offsets = [];
    for (let offset = parts[0].length; offset < first.totalBytes; offset += 65536) offsets.push(offset);
    for (const batch of Array.from({ length: Math.ceil(offsets.length / 8) }, (_, n) => offsets.slice(n * 8, n * 8 + 8))) {
      const ranges = await Promise.all(batch.map(offset => call('export_road_data', {
        roadDataVersion: summary.manifestBase.roadDataVersion, file, offset })));
      for (const range of ranges) parts.push(Buffer.from(range.data, 'base64'));
    }
    const bytes = Buffer.concat(parts);
    assert.equal(bytes.length, first.totalBytes);
    return bytes;
  }
  const roads = JSON.parse((await roadSnapshot('roads.json')).toString('utf8'));
  const localRoads = JSON.parse(gunzipSync(await roadSnapshot('local-roads.json.gz')).toString('utf8'));
  const report = replay(parsed, roads, localRoads, { roadDataVersion: summary.manifestBase.roadDataVersion });
  assert.ok(report.timeline.length >= 1);
});
