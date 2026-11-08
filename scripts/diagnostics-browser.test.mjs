// Run with: node --test scripts/diagnostics-browser.test.mjs
// Requires Playwright and a local Chromium binary. No upload service is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

async function localServer() {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const path = normalize(join(dist, pathname));
    if (!path.startsWith(`${dist}/`)) { response.writeHead(403).end(); return; }
    try {
      const content = await readFile(path);
      response.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.json') ? 'application/json' : path.endsWith('.css') ? 'text/css' : path.endsWith('.gz') ? 'application/gzip' : 'text/html');
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/index.html` };
}

const recorder = async page => page.evaluate(async () => {
  const { DiagnosticsRecorder } = await import('/diagnostics.js');
  const r = new DiagnosticsRecorder({ appVersion: 'test', buildId: 'test', roadDataVersion: 'test',
    configuration: () => ({ test: true }), onChange: () => {} });
  await r.init();
  window.testRecorder = r;
  window.testUsage = async () => {
    const usage = await r.usage();
    const tx = r.db.transaction('chunks');
    const chunks = await new Promise(resolve => { const request = tx.objectStore('chunks').getAll(); request.onsuccess = () => resolve(request.result); });
    return { ...usage, chunks };
  };
  return window.testUsage();
});

test('diagnostics remain opt-in, durable, bounded, and verified before deletion', { timeout: 90000 }, async () => {
  const { server, url } = await localServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url);
    let usage = await recorder(page);
    assert.equal(usage.records.length, 0);
    assert.equal(await page.evaluate(() => window.testRecorder.active), null);
    await page.evaluate(async () => {
      await window.testRecorder.start();
      window.testRecorder.capture('fix', { fix: { latitude: 1.3, longitude: 103.8 } });
      await window.testRecorder.stop();
    });
    usage = await page.evaluate(() => window.testUsage());
    assert.equal(usage.records.length, 1);
    assert.equal(usage.chunks.length, 1);
    const id = usage.records[0].id;
    await page.reload();
    usage = await recorder(page);
    assert.equal(usage.records.length, 1, 'recording survives reload');
    assert.equal(usage.records[0].id, id);
    assert.equal(await page.evaluate(() => window.testRecorder.active), null, 'recording is off after reload');

    const lowSpace = await page.evaluate(async () => {
      Object.defineProperty(navigator.storage, 'estimate', { configurable: true,
        value: async () => ({ quota: 100_000_000, usage: 95_000_000 }) });
      try { await window.testRecorder.start(); return false; } catch (error) { return /storage|space/i.test(error.message); }
    });
    assert.equal(lowSpace, true, 'low space must prevent recording');

    const retained = await page.evaluate(async id => {
      const original = window.fetch;
      window.fetch = async (input, init) => {
        const path = String(input);
        if (path.endsWith('/auth')) return new Response(null, { status: 204 });
        if (path.endsWith('/recordings')) return Response.json({ recordingId: id, status: 'uploading', uploadToken: 'test-token' }, { status: 201 });
        if (path.includes('/chunks/')) return Response.json({ index: 0, sha256: '0'.repeat(64), status: 'uploaded' }, { status: 201 });
        return Response.json({ status: 'completed', uploadedChunks: [0] });
      };
      try { await window.testRecorder.upload(id, 'test-secret', 'test'); return false; }
      catch { return (await window.testUsage()).records.some(record => record.id === id); }
      finally { window.fetch = original; }
    }, id);
    assert.equal(retained, true, 'checksum mismatch must preserve local recording');

    const unsupportedRetains = await page.evaluate(async id => {
      const original = window.fetch;
      window.fetch = async input => String(input).endsWith('/auth') ?
        new Response(null, { status: 204 }) : new Response(null, { status: 404 });
      try { await window.testRecorder.upload(id, 'test-secret', 'test'); return false; }
      catch { return (await window.testUsage()).records.some(record => record.id === id); }
      finally { window.fetch = original; }
    }, id);
    assert.equal(unsupportedRetains, true, 'unavailable upload service must leave local data intact');

    const secretAbsent = await page.evaluate(async () => {
      const usage = await window.testUsage();
      const stored = JSON.stringify(usage.records) + JSON.stringify(usage.receipts) +
        usage.chunks.map(chunk => JSON.stringify({ ...chunk, data: null })).join('');
      return !stored.includes('test-secret') &&
        !(await caches.keys()).some(key => key.includes('test-secret'));
    });
    assert.equal(secretAbsent, true, 'upload key must not enter IDB metadata or cache names');

    const capped = await page.evaluate(async id => {
      Object.defineProperty(navigator.storage, 'estimate', { configurable: true,
        value: async () => ({ quota: 200_000_000, usage: 1_000_000 }) });
      const tx = window.testRecorder.db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').put({ recordingId: id, index: 1000,
        data: new Uint8Array(50 * 1024 * 1024), compressedBytes: 50 * 1024 * 1024 });
      await new Promise(resolve => { tx.oncomplete = resolve; });
      const recordTx = window.testRecorder.db.transaction('recordings', 'readwrite');
      const store = recordTx.objectStore('recordings');
      const row = await new Promise(resolve => { const request = store.get(id); request.onsuccess = () => resolve(request.result); });
      row.chunks.push({ index: 1000, compressedBytes: 50 * 1024 * 1024 });
      store.put(row);
      await new Promise(resolve => { recordTx.oncomplete = resolve; });
      try { await window.testRecorder.start(); return false; }
      catch (error) { return /full|limit|space/i.test(error.message); }
    }, id);
    assert.equal(capped, true, 'actual 50 MiB stored chunk total must stop new recording');

    await page.evaluate(async () => {
      const tx = window.testRecorder.db.transaction('recordings', 'readwrite');
      const store = tx.objectStore('recordings');
      const records = await new Promise(resolve => { const request = store.getAll(); request.onsuccess = () => resolve(request.result); });
      for (const record of records) { record.startedAt = new Date(Date.now() - 8 * 86400000).toISOString(); store.put(record); }
      await new Promise(resolve => { tx.oncomplete = resolve; });
      await window.testRecorder.prune();
    });
    usage = await page.evaluate(() => window.testUsage());
    assert.equal(usage.records.length, 0, 'unuploaded recordings expire after seven days');
    assert.equal(usage.chunks.length, 0);

    const uploaded = await page.evaluate(async () => {
      await window.testRecorder.start();
      window.testRecorder.capture('fix', { fix: { latitude: 1.31, longitude: 103.81 } });
      await window.testRecorder.stop();
      const id = (await window.testUsage()).records[0].id;
      const original = window.fetch;
      let manifest, token;
      window.fetch = async (input, init = {}) => {
        const path = String(input);
        if (path.endsWith('/auth')) return new Response(null, { status: 204 });
        if (path.endsWith('/recordings')) {
          manifest = JSON.parse(init.body).manifest;
          token = init.headers['X-Upload-Token'];
          return Response.json({ recordingId: id, status: 'uploading' }, { status: 201 });
        }
        if (path.includes('/chunks/')) {
          if (init.headers['Content-Encoding'] !== 'gzip' || init.headers['X-Upload-Token'] !== token) throw Error('Upload headers missing');
          return Response.json({ index: 0, sha256: manifest.chunks[0].sha256, status: 'uploaded' }, { status: 201 });
        }
        if (path.endsWith('/finalize')) return Response.json({ status: 'completed' });
        return Response.json({ status: 'completed', uploadedChunks: [0],
          uploadedChunkChecksums: { 0: manifest.chunks[0].sha256 } });
      };
      try { await window.testRecorder.upload(id, 'test-secret', 'test issue'); }
      finally { window.fetch = original; }
      const usage = await window.testUsage();
      return { records: usage.records.length, chunks: usage.chunks.length,
        receipts: usage.receipts.length, tokenLength: token?.length };
    });
    assert.deepEqual(uploaded, { records: 0, chunks: 0, receipts: 1, tokenLength: 64 },
      'only a checksum-verified completed upload may delete local chunks');
    await context.close();
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test('settings gate, persisted list, secret handling, and compact layout', { timeout: 90000 }, async () => {
  const { server, url } = await localServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }, { width: 1280, height: 800 }]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.addInitScript(() => {
        navigator.geolocation.watchPosition = ok => { window.testGeoOk = ok; return 1; };
        navigator.geolocation.clearWatch = () => {};
      });
      await page.goto(url);
      await page.waitForFunction(() => document.querySelector('#signalText')?.textContent.includes('Ready'));
      assert.equal(await page.locator('#safetyGate').isVisible(), true);
      await page.locator('#parkedButton').click();
      await page.waitForFunction(() => !!window.testGeoOk);
      await page.locator('#settingsButton').click();
      assert.match(await page.locator('#recordDiagnosticsButton').textContent(), /record/i);
      assert.equal(await page.locator('#exportDiagnosticsButton').isDisabled(), true);
      await page.locator('#recordDiagnosticsButton').click();
      await page.waitForFunction(() => document.querySelector('#recordDiagnosticsButton').getAttribute('aria-pressed') === 'true');
      await page.locator('#uploadKeyInput').fill('ephemeral-test-upload-secret');
      await page.locator('#closeInfoButton').click();
      await page.evaluate(async () => {
        const { sampleAt } = await import('/engine.js');
        const data = await (await fetch('/data/roads.json')).json();
        const road = data.roads.find(road => road.id === 'osm-way-174552486');
        const fix = sampleAt(road, 3);
        window.testGeoOk({ coords: { latitude: fix.latitude, longitude: fix.longitude,
          accuracy: 5, heading: fix.heading, speed: 15 }, timestamp: Date.now() });
      });
      await page.locator('#settingsButton').click();
      await page.waitForFunction(() => !document.querySelector('#exportDiagnosticsButton').disabled);
      const before = await page.evaluate(() => ({
        scroll: document.documentElement.scrollHeight,
        gear: document.querySelector('#settingsButton').getBoundingClientRect().width,
        drawerTop: document.querySelector('#infoDrawer').scrollTop,
        indicator: document.querySelector('#diagnosticsIndicator').textContent,
      }));
      assert.ok(before.scroll <= viewport.height + 1, `page overflow at ${viewport.width}x${viewport.height}: ${JSON.stringify(before)}`);
      assert.ok(before.gear >= 44);
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#signalText')?.textContent.includes('Ready'));
      await page.locator('#parkedButton').click();
      await page.locator('#settingsButton').click();
      assert.match(await page.locator('#recordDiagnosticsButton').textContent(), /record/i);
      assert.match(await page.locator('#diagnosticsList').textContent(), /recording|saved|interrupted/i);
      assert.equal(await page.locator('#uploadKeyInput').inputValue(), '');
      const stores = await page.evaluate(async () => {
        const { DiagnosticsRecorder } = await import('/diagnostics.js');
        const r = new DiagnosticsRecorder({ appVersion: 'test', buildId: 'test', roadDataVersion: 'test',
          configuration: () => ({}), onChange: () => {} });
        await r.init();
        const usage = await r.usage();
        return JSON.stringify(usage.records) + JSON.stringify(usage.receipts);
      });
      assert.equal(stores.includes('ephemeral-test-upload-secret'), false);
      if (viewport.width === 320) {
        let manifest;
        await page.route('**/api/diagnostics/**', async route => {
          const request = route.request(), path = new URL(request.url()).pathname;
          if (path.endsWith('/auth')) return route.fulfill({ status: 204 });
          if (path.endsWith('/recordings')) {
            manifest = request.postDataJSON().manifest;
            return route.fulfill({ status: 201, contentType: 'application/json',
              body: JSON.stringify({ recordingId: manifest.recordingId, status: 'uploading' }) });
          }
          if (path.includes('/chunks/')) return route.fulfill({ status: 201, contentType: 'application/json',
            body: JSON.stringify({ index: 0, sha256: manifest.chunks[0].sha256, status: 'uploaded' }) });
          if (path.endsWith('/finalize')) return route.fulfill({ status: 200, contentType: 'application/json',
            body: JSON.stringify({ status: 'completed' }) });
          return route.fulfill({ status: 200, contentType: 'application/json',
            body: JSON.stringify({ status: 'completed', uploadedChunks: [0],
              uploadedChunkChecksums: { 0: manifest.chunks[0].sha256 } }) });
        });
        page.on('dialog', dialog => dialog.accept());
        await page.locator('#uploadKeyInput').fill('ephemeral-test-upload-secret');
        await page.locator('#issueInput').fill('Test issue');
        await page.locator('#uploadDiagnosticsButton').click();
        await page.waitForFunction(() => document.querySelector('#diagnosticsStatus').textContent.includes('verified'));
        assert.match(await page.locator('#diagnosticsStatus').textContent(), new RegExp(manifest.recordingId));
        assert.equal(await page.locator('#diagnosticsList option').count(), 0);
        assert.equal(await page.locator('#uploadKeyInput').inputValue(), '');
      }
      await context.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
