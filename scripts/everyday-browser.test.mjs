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

async function snapshot(page) {
  return page.evaluate(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    const speed = rect('.speed-card'), exits = rect('.exits-card'), gear = rect('#settingsButton');
    const everydayButton = rect('#everydayViewButton'), paceButton = rect('#paceViewButton');
    const unitRange = document.createRange();
    unitRange.selectNodeContents(document.querySelector('.speed-unit'));
    const rows = [...document.querySelectorAll('#exitList li:not(.empty-exits)')];
    return { view: document.documentElement.dataset.dashboardView,
      speed: document.querySelector('#speedValue').textContent,
      delta: document.querySelector('#deltaValue').textContent,
      elapsed: document.querySelector('#elapsedValue').textContent,
      road: document.querySelector('#roadRef').textContent,
      roadHeading: document.querySelector('#roadHeadingLabel').textContent,
      headline: document.querySelector('#signalText').textContent,
      support: document.querySelector('#signalSupport').textContent,
      headlineFont: parseFloat(getComputedStyle(document.querySelector('#signalText')).fontSize),
      supportFont: parseFloat(getComputedStyle(document.querySelector('#signalSupport')).fontSize),
      limit: document.querySelector('#limitValue').textContent,
      speedTone: document.querySelector('#speedValue').className,
      deltaVisible: getComputedStyle(document.querySelector('.delta-card')).display !== 'none',
      projectionVisible: getComputedStyle(document.querySelector('.exit-delta')).display !== 'none',
      rows: rows.length, lastRowBottom: rows.at(-1)?.getBoundingClientRect().bottom,
      speedWidth: speed.width, speedRight: speed.right, exitsBottom: exits.bottom,
      unitBottom: unitRange.getBoundingClientRect().bottom, trackTop: rect('.speed-track').top,
      gearWidth: gear.width, gearHeight: gear.height,
      switchHeights: [everydayButton.height, paceButton.height],
      scrollHeight: document.documentElement.scrollHeight, height: innerHeight };
  });
}

test('Everyday defaults for a new driver; Pace selection persists without resetting live timing', { timeout: 90000 }, async () => {
  const { http, url } = await preview();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    for (const [width, height] of [[320, 568], [390, 844], [844, 390]]) {
      const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
      await context.addInitScript(() => {
        navigator.geolocation.watchPosition = (ok, error) => {
          window.geoOk = ok; window.geoError = error; return 1;
        };
        navigator.geolocation.clearWatch = () => {};
      });
      const page = await context.newPage();
      await page.goto(url);
      await page.waitForFunction(() => document.querySelector('#signalText')?.textContent.includes('Ready'));
      assert.equal(await page.locator('#everydayViewButton').getAttribute('aria-pressed'), 'true');
      await page.locator('#parkedButton').click();
      await page.waitForFunction(() => window.geoOk);
      await page.evaluate(async () => {
        const { sampleAt } = await import('./engine.js');
        const roads = await (await fetch('./data/roads.json')).json();
        const road = roads.roads.find(row => row.id === 'osm-way-32877553');
        const base = Date.now() - 3000;
        for (const [distance, ms] of [[20,0],[70,1000],[120,2000]]) {
          const fix = sampleAt(road, distance);
          window.geoOk({ coords: { latitude: fix.latitude, longitude: fix.longitude,
            accuracy: 5, heading: fix.heading, speed: 22 }, timestamp: base + ms });
        }
      });
      const everyday = await snapshot(page);
      assert.equal(everyday.view, 'everyday');
      assert.equal(everyday.road, 'PIE');
      assert.ok(Number(everyday.speed) > 0);
      assert.equal(everyday.deltaVisible, false);
      assert.equal(everyday.projectionVisible, false);
      assert.equal(everyday.rows, 3);
      if (height >= width)
        assert.ok(everyday.speedWidth > width * 0.7, 'Everyday speed gets the full portrait width');
      assert.ok(everyday.scrollHeight <= height + 1);
      assert.ok(everyday.lastRowBottom <= height - 16);
      assert.ok(everyday.exitsBottom <= height - 15);
      assert.ok(everyday.gearWidth >= 44 && everyday.gearHeight >= 44);
      assert.ok(everyday.unitBottom <= everyday.trackTop + 1,
        `live speed unit overlaps track: ${everyday.unitBottom} > ${everyday.trackTop}`);
      assert.ok(everyday.switchHeights.every(value => value >= 44));
      assert.ok(everyday.headlineFont >= 20 && everyday.supportFont >= 14);
      if (process.env.DELTA_LAYOUT_SCREENSHOTS)
        await page.screenshot({ path: `/tmp/delta-everyday-${width}x${height}.png` });
      await page.locator('#paceViewButton').click();
      const pace = await snapshot(page);
      assert.equal(pace.view, 'pace');
      assert.equal(pace.deltaVisible, true);
      assert.equal(pace.projectionVisible, true);
      assert.equal(pace.road, everyday.road);
      assert.equal(pace.speed, everyday.speed);
      assert.equal(pace.elapsed, everyday.elapsed, 'view switch must preserve session clock');
      assert.equal(pace.delta, everyday.delta, 'view switch must preserve current pace');
      assert.ok(everyday.speedWidth > pace.speedWidth * 1.65,
        'Everyday speed gets the available instrument width');
      assert.equal(pace.rows, 3);
      assert.ok(pace.scrollHeight <= height + 1 && pace.lastRowBottom <= height - 16);
      if (process.env.DELTA_LAYOUT_SCREENSHOTS)
        await page.screenshot({ path: `/tmp/delta-pace-${width}x${height}.png` });
      if (width < 500) {
        await page.locator('#everydayViewButton').click();
        const fastFix = async (distance, speedKmh, ms) => page.evaluate(async ({ distance, speedKmh, ms }) => {
          const { sampleAt } = await import('./engine.js');
          const roads = await (await fetch('./data/roads.json')).json();
          const road = roads.roads.find(row => row.id === 'osm-way-32877553');
          const point = sampleAt(road, distance);
          window.geoOk({ coords: { latitude: point.latitude, longitude: point.longitude,
            accuracy: 5, heading: point.heading, speed: speedKmh / 3.6 }, timestamp: Date.now() + ms });
        }, { distance, speedKmh, ms });
        await fastFix(150, 84, 0);
        const caution = await snapshot(page);
        assert.equal(caution.headline, 'Above limit');
        assert.match(caution.speedTone, /reading-caution/);
        if (process.env.DELTA_LAYOUT_SCREENSHOTS)
          await page.screenshot({ path: `/tmp/delta-everyday-caution-${width}x${height}.png` });
        await fastFix(180, 100, 1000);
        const danger = await snapshot(page);
        assert.equal(danger.headline, 'Above limit');
        assert.match(danger.speedTone, /reading-danger/);
        if (process.env.DELTA_LAYOUT_SCREENSHOTS)
          await page.screenshot({ path: `/tmp/delta-everyday-danger-${width}x${height}.png` });
      }
      await page.evaluate(() => window.geoError({ code: 2, message: 'Signal unavailable' }));
      const unavailable = await snapshot(page);
      assert.equal(unavailable.headline, 'GPS unavailable');
      assert.match(unavailable.support, /PIE · last known/);
      if (width < 500) {
        assert.doesNotMatch(unavailable.support, /pace held/i,
          'Everyday GPS warning should use road context rather than Pace jargon');
        await page.locator('#paceViewButton').click();
        assert.match((await snapshot(page)).support, /pace held/i,
          'Pace support text updates immediately on switch');
        await page.locator('#everydayViewButton').click();
        assert.doesNotMatch((await snapshot(page)).support, /pace held/i);
      }
      if (width === 390) assert.equal(unavailable.roadHeading, 'LAST KNOWN ROAD');
      assert.equal(unavailable.road, 'PIE', 'GPS loss retains the last identified road');
      assert.equal(unavailable.speed, '—', 'GPS loss cannot present stale speed as live');
      assert.equal(unavailable.limit, '80 KM/H', 'GPS loss retains the known limit');
      assert.match(unavailable.speedTone, /reading-neutral/);
      assert.ok(unavailable.headlineFont >= 20 && unavailable.supportFont >= 14);
      assert.ok(unavailable.unitBottom <= unavailable.trackTop + 1,
        `unavailable speed unit overlaps track: ${unavailable.unitBottom} > ${unavailable.trackTop}`);
      if (process.env.DELTA_LAYOUT_SCREENSHOTS)
        await page.screenshot({ path: `/tmp/delta-${width < 500 ? 'everyday' : 'pace'}-gps-unavailable-${width}x${height}.png` });
      await page.reload();
      if (width < 500) {
        assert.equal(await page.locator('#everydayViewButton').getAttribute('aria-pressed'), 'true',
          'explicit Everyday selection survives reload');
        await page.locator('#parkedButton').click();
        await page.locator('#paceViewButton').click();
        await page.reload();
      }
      assert.equal(await page.locator('#paceViewButton').getAttribute('aria-pressed'), 'true',
        'Pace preference survives reload');
      await context.close();
    }
    for (const [savedView, expected] of [[null, 'pace'], ['everyday', 'everyday']]) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.addInitScript(view => {
        localStorage.setItem('delta-theme', 'dark');
        if (view) localStorage.setItem('delta-dashboard-view', view);
      }, savedView);
      const page = await context.newPage();
      await page.goto(url);
      assert.equal(await page.locator(`#${expected}ViewButton`).getAttribute('aria-pressed'), 'true',
        savedView ? 'explicit Everyday wins over legacy marker' : 'legacy user starts in Pace');
      await context.close();
    }
  } finally { await browser.close(); await new Promise(resolve => http.close(resolve)); }
});

test('connected ECP to KPE transfer keeps numeric current-session Pace through mapped ramps', { timeout: 30000 }, async () => {
  const { http, url } = await preview();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 844, height: 390 }, serviceWorkers: 'block' });
    await page.addInitScript(() => {
      navigator.geolocation.watchPosition = ok => { window.geoOk = ok; return 1; };
      navigator.geolocation.clearWatch = () => {};
    });
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#signalText')?.textContent.includes('Ready'));
    await page.locator('#parkedButton').click();
    await page.locator('#paceViewButton').click();
    const readings = await page.evaluate(async () => {
      const { sampleAt, roadLengthM } = await import('./engine.js');
      const roads = await (await fetch('./data/roads.json')).json();
      const local = await (await fetch('./data/local-roads.json')).json();
      const byId = new Map([...roads.roads, ...local.roads].map(road => [road.id, road]));
      const route = [
        ['osm-way-670121242', .2], ['osm-way-670121242', .7],
        ['osm-way-32605139', .2], ['osm-way-140562826', .2],
        ['osm-way-528189241', .2], ['osm-way-633601611', .1],
      ];
      const out = [], base = Date.now() - route.length * 2000;
      for (const [id, fraction] of route) {
        const road = byId.get(id), point = sampleAt(road, roadLengthM(road) * fraction);
        window.geoOk({ coords: { latitude: point.latitude, longitude: point.longitude,
          accuracy: 5, heading: point.heading, speed: 15 }, timestamp: base + out.length * 2000 });
        out.push({ id, road: document.querySelector('#roadRef').textContent,
          delta: document.querySelector('#deltaValue').textContent,
          label: document.querySelector('#deltaLabel').textContent,
          elapsed: document.querySelector('#elapsedValue').textContent });
      }
      return out;
    });
    assert.match(readings[1].delta, /^[+−-]?\d/, 'confirmed ECP has a numeric pace');
    for (const ramp of readings.slice(2, 5)) {
      assert.match(ramp.delta, /^[+−-]?\d/, `${ramp.id} must show current Pace, not blank`);
      assert.doesNotMatch(ramp.label, /PREVIOUS|LAST KNOWN|INACTIVE/);
    }
    assert.match(readings[5].delta, /^[+−-]?\d/, 'KPE continues numeric pace');
    assert.equal(readings[5].road, 'KPE');
    const layout = await snapshot(page);
    assert.equal(layout.rows, 3);
    assert.ok(layout.lastRowBottom <= 374 && layout.scrollHeight <= 391);
    await page.close();
  } finally { await browser.close(); await new Promise(resolve => http.close(resolve)); }
});
