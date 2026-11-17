// Packed-upload QA. Set DELTA_PRIVATE_RECORDING to replay a local private archive;
// no contents, coordinates, or secrets are committed or printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  if (process.env.DELTA_PRIVATE_RECORDING) {
    const archive = JSON.parse(await readFile(process.env.DELTA_PRIVATE_RECORDING, 'utf8'));
    return { manifest: archive.manifest, chunks: archive.chunks };
  }
  const chunks = [], metadata = [];
  for (let index = 0; index < 211; index++) {
    const line = Buffer.from(JSON.stringify({ type: 'motion', seq: index,
      recordedAt: new Date().toISOString(), motion: { severity: index % 4 / 10 } }) + '\n');
    const compressed = gzipSync(line);
    chunks.push({ index, data: compressed.toString('base64') });
    metadata.push({ index, sha256: sha(compressed), compressedBytes: compressed.length,
      expandedBytes: line.length, eventCount: 1 });
  }
  const now = new Date().toISOString();
  return { manifest: { recordingId: 'qa-local-211', formatVersion: 1,
    appVersion: 'qa', buildId: 'qa', roadDataVersion: 'qa', configuration: {},
    startedAt: now, endedAt: now, issue: '', eventCount: 211, chunks: metadata }, chunks };
}

async function preview() {
  const http = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const path = normalize(join(dist, pathname === '/' ? 'index.html' : pathname.slice(1)));
    if (!path.startsWith(`${dist}/`)) { response.writeHead(403).end(); return; }
    try {
      const content = await readFile(path);
      response.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' :
        path.endsWith('.css') ? 'text/css' : path.endsWith('.json') ? 'application/json' : 'text/html');
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  return { http, url: `http://127.0.0.1:${http.address().port}/` };
}

test('211 local gzip chunks pack into one verified upload and only then delete source', { timeout: 90000 }, async () => {
  const archive = await fixture();
  assert.equal(archive.chunks.length, 211);
  const { http, url } = await preview();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    await page.goto(url);
    const result = await page.evaluate(async archive => {
      const { DiagnosticsRecorder } = await import('./diagnostics.js');
      const recorder = new DiagnosticsRecorder({ appVersion: 'qa', buildId: 'qa',
        roadDataVersion: 'qa', configuration: () => ({}), onChange: () => {} });
      await recorder.init();
      const id = archive.manifest.recordingId;
      const row = { ...archive.manifest, id, status: 'stopped', chunks: archive.manifest.chunks };
      const transaction = recorder.db.transaction(['recordings','chunks'], 'readwrite');
      transaction.objectStore('recordings').put(row);
      for (const chunk of archive.chunks) {
        const bytes = Uint8Array.from(atob(chunk.data), char => char.charCodeAt(0));
        transaction.objectStore('chunks').put({ recordingId:id,index:chunk.index,
          data:bytes, ...archive.manifest.chunks[chunk.index] });
      }
      await new Promise((resolve,reject) => {transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error);});
      const originalFetch = window.fetch, calls = { create:0, put:0, finalize:0, status:0 };
      let manifest = null, uploaded = null, completed = false, failFinalize = true;
      let prepareStartedAt = 0, prepareMs = null;
      window.fetch = async (input, options = {}) => {
        const path = String(input);
        if (!path.startsWith('/api/diagnostics/')) return originalFetch(input, options);
        if (path.endsWith('/auth')) return new Response(null, { status:204 });
        if (path.endsWith('/recordings') && options.method === 'POST') {
          if (prepareMs === null) prepareMs = performance.now() - prepareStartedAt;
          calls.create++;manifest = JSON.parse(options.body).manifest;
          return Response.json({recordingId:manifest.recordingId,status:'uploading'}, {status:201});
        }
        if (path.endsWith('/status')) {
          calls.status++;
          return Response.json({status:completed?'completed':'uploading',
            uploadedChunks:uploaded?[0]:[],uploadedChunkChecksums:uploaded?{'0':uploaded.sha256}:{}});
        }
        if (path.includes('/chunks/')) {
          calls.put++;
          uploaded = { index:0, data:new Uint8Array(options.body),
            encoding:options.headers['Content-Encoding'], sha256:manifest.chunks[0].sha256 };
          return Response.json({index:0,sha256:manifest.chunks[0].sha256,status:'uploaded'}, {status:201});
        }
        if (path.endsWith('/finalize')) {
          calls.finalize++;
          if (failFinalize) { failFinalize=false;return new Response(null,{status:422}); }
          completed=true;return Response.json({status:'completed'});
        }
        throw Error(`Unexpected upload path ${path}`);
      };
      let firstError = null;
      prepareStartedAt = performance.now();
      try { await recorder.upload(id, 'qa-key', 'qa issue'); }
      catch(error) { firstError = error.message; }
      const retainedAfterFailure = (await new Promise((resolve,reject) => {
        const request=recorder.db.transaction('recordings').objectStore('recordings').get(id);
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      }));
      try { await recorder.upload(id, 'qa-key', 'changed issue on retry'); }
      finally { window.fetch=originalFetch; }
      const tx = recorder.db.transaction(['recordings','receipts']);
      const read = store => new Promise((resolve,reject) => {
        const request=tx.objectStore(store).getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      });
      const records=await read('recordings'),receipts=await read('receipts');
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256',uploaded.data))]
        .map(byte => byte.toString(16).padStart(2,'0')).join('');
      return { calls, prepareMs, firstError, retainedAfterFailure:!!retainedAfterFailure,
        sameSession:retainedAfterFailure?.uploadSession?.id===manifest.recordingId,
        chunks:manifest.chunks.length, compressedBytes:manifest.chunks[0].compressedBytes,
        expandedBytes:manifest.chunks[0].expandedBytes, originalId:id,
        serverId:manifest.recordingId, packedDigest:digest,
        encoding:uploaded.encoding, packedSha:uploaded.sha256,
        remaining:records.length, receipts:receipts.map(receipt => ({id:receipt.id,serverId:receipt.serverId})) };
    }, archive);
    assert.equal(result.chunks, 1, '211 local chunks become one upload group');
    assert.ok(Number.isFinite(result.prepareMs) && result.prepareMs >= 0);
    if (process.env.DELTA_PRIVATE_RECORDING) console.log(`Private archive packing: ${Math.round(result.prepareMs)} ms`);
    assert.ok(result.compressedBytes <= 1024*1024 && result.expandedBytes <= 8*1024*1024);
    assert.match(result.firstError, /Upload rejected \(422\)/);
    assert.equal(result.retainedAfterFailure, true, 'failed finalize preserves local source');
    assert.equal(result.sameSession, true, 'retry reuses the upload identity');
    assert.equal(result.calls.create, 2);
    assert.equal(result.calls.put, 1, 'verified chunk is not uploaded twice');
    assert.equal(result.calls.finalize, 2);
    assert.equal(result.encoding, 'gzip');
    assert.equal(result.packedDigest, result.packedSha);
    assert.equal(result.remaining, 0);
    assert.deepEqual(result.receipts, [{id:result.originalId,serverId:result.serverId}]);
    assert.notEqual(result.serverId, result.originalId, 'new upload session ID is distinct from local recording');
    await page.close();
  } finally { await browser.close(); await new Promise(resolve => http.close(resolve)); }
});
