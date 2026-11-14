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

test('unresolved tunnel recovery shows the current road and a factual new timing basis', { timeout: 30000 }, async () => {
  const http = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const path = normalize(join(dist, pathname === '/' ? 'index.html' : pathname.slice(1)));
    if (!path.startsWith(`${dist}/`)) { response.writeHead(403).end(); return; }
    try {
      let content = await readFile(path);
      if (pathname === '/app.js') content = Buffer.from(`${content}\nwindow.__renderRecoveryTest = render;`);
      response.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' :
        path.endsWith('.css') ? 'text/css' : path.endsWith('.json') ? 'application/json' : 'text/html');
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    for (const [width, height] of [[320, 568], [844, 390]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.addInitScript(() => {
        navigator.geolocation.watchPosition = () => 1;
        navigator.geolocation.clearWatch = () => {};
      });
      await page.goto(`http://127.0.0.1:${http.address().port}/`);
      await page.waitForFunction(() => window.__renderRecoveryTest);
      await page.locator('#parkedButton').click();
      const result = await page.evaluate(async () => {
        const { Tracker, sampleAt } = await import('./engine.js');
        const road = (id, coordinates, nextRoadIds) => ({ id, ref: 'PIE', name: 'PIE',
          direction: 'Eastbound', tunnel: true, speedLimit: 90, nextRoadIds, coordinates });
        const a = road('ui-a', [[103.9, 1.35], [103.91, 1.35]], ['ui-b', 'ui-c']);
        const b = road('ui-b', [[103.91, 1.35], [103.92, 1.35]], ['ui-d']);
        const c = road('ui-c', [[103.91, 1.35], [103.915, 1.351], [103.92, 1.35]], ['ui-d']);
        const d = road('ui-d', [[103.92, 1.35], [103.93, 1.35]], []);
        const tracker = new Tracker({ roads: [a, b, c, d] });
        const base = Date.now() - 120000;
        const fix = (segment, distance, ms) => ({ ...sampleAt(segment, distance), accuracy: 5, speed: 20, timestamp: base + ms });
        tracker.update(fix(a, 50, 0));
        tracker.update(fix(a, 100, 2000));
        tracker.invalidate('Tunnel GPS unavailable');
        tracker.update(fix(d, 500, 100000));
        tracker.update(fix(d, 550, 102000));
        tracker.update(fix(d, 600, 106000));
        tracker.update(fix(d, 650, 110000));
        const state = tracker.update(fix(d, 700, 112000));
        window.__renderRecoveryTest(state, fix(d, 700, 112000));
        const r = selector => document.querySelector(selector).getBoundingClientRect();
        return { timingBasis: state.timingBasis, roadId: state.road?.id,
          road: document.querySelector('#roadRef').textContent,
          label: document.querySelector('#deltaLabel').textContent,
          note: document.querySelector('#roadNote').textContent,
          speed: document.querySelector('#speedValue').textContent,
          deltaClass: document.querySelector('#deltaValue').className,
          summary: document.querySelector('#completedSummaryText').textContent,
          gear: r('#settingsButton').width,
          scroll: document.documentElement.scrollHeight, height: innerHeight,
          exitsBottom: r('.exits-card').bottom };
      });
      assert.equal(result.timingBasis, 'since GPS recovery');
      assert.equal(result.roadId, 'ui-d');
      assert.equal(result.road, 'PIE');
      assert.equal(result.label, 'SINCE GPS RECOVERY');
      assert.match(result.note, /Earlier section unresolved/);
      assert.match(result.summary, /incomplete|unresolved|route/i);
      assert.ok(Number(result.speed) > 0);
      assert.ok(result.gear >= 44);
      assert.ok(result.scroll <= result.height + 1, `${width}x${height} document scroll ${JSON.stringify(result)}`);
      assert.ok(result.exitsBottom <= result.height - 16, `${width}x${height} exits gutter ${JSON.stringify(result)}`);
      await page.close();
    }
  } finally { await browser.close(); await new Promise(resolve => http.close(resolve)); }
});
