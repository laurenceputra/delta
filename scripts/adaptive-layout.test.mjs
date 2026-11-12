// Run with `node --test scripts/adaptive-layout.test.mjs` (requires Chromium and Playwright).
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

async function server() {
  const http = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const path = normalize(join(dist, pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(`${dist}/`)) { response.writeHead(403).end(); return; }
    try {
      const content = await readFile(path);
      response.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' :
        path.endsWith('.css') ? 'text/css' : path.endsWith('.json') ? 'application/json' :
        path.endsWith('.gz') ? 'application/gzip' : 'text/html');
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  return { http, url: `http://127.0.0.1:${http.address().port}/` };
}

async function geometry(page) {
  return page.evaluate(() => {
    const rect = selector => {
      const e = document.querySelector(selector), r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const ink = selector => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector(selector));
      const r = range.getBoundingClientRect();
      return { x: r.x, right: r.right, bottom: r.bottom };
    };
    return { width: innerWidth, height: innerHeight, scroll: document.documentElement.scrollHeight,
      rows: document.querySelectorAll('#exitList li:not(.empty-exits)').length,
      speed: rect('.speed-card'), delta: rect('.delta-card'), exits: rect('.exits-card'),
      lastExit: [...document.querySelectorAll('#exitList li')].at(-1)?.getBoundingClientRect().bottom,
      speedInk: ink('#speedValue'), deltaInk: ink('#deltaValue'),
      track: rect('.speed-track'), limit: rect('#limitValue'), warning: rect('#speedWarning'),
      gear: rect('#settingsButton') };
  });
}

function check(g, label) {
  assert.equal(g.rows, 3, `${label}: three real exits`);
  assert.ok(g.scroll <= g.height + 1, `${label}: body scroll ${g.scroll} > ${g.height}`);
  assert.ok(g.speed.right < g.delta.x, `${label}: instruments must stay in two columns`);
  assert.ok(g.speed.y === g.delta.y && Math.abs(g.speed.height - g.delta.height) < 1,
    `${label}: instrument cards should align`);
  assert.ok(g.gear.width >= 44 && g.gear.height >= 44, `${label}: gear touch target`);
  assert.ok(g.exits.bottom <= g.height - 15, `${label}: bottom gutter`);
  assert.ok(g.lastExit <= g.height - 16, `${label}: third exit visible`);
  assert.ok(g.speedInk.bottom <= g.limit.y + 2, `${label}: speed overlaps current limit`);
  assert.ok(g.speedInk.right <= g.speed.right - 1, `${label}: speed glyph clipped`);
  // Range bounds include line-height below the visible numerals; allow that small ink-free tail.
  assert.ok(g.speedInk.bottom <= g.track.y + 5, `${label}: speed overlaps track`);
  assert.ok(g.deltaInk.right <= g.delta.right - 1, `${label}: delta glyph clipped`);
  assert.ok(g.warning.bottom <= g.speed.bottom - 2, `${label}: warning clipped`);
}

test('dashboard cards, exit rows, and Settings fit mobile and landscape viewports', { timeout: 90000 }, async () => {
  const { http, url } = await server();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    for (const [width, height] of [[320,568],[360,640],[390,844],[412,915],[844,390]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.addInitScript(() => {
        navigator.geolocation.watchPosition = ok => { window.geoOk = ok; return 1; };
        navigator.geolocation.clearWatch = () => {};
      });
      await page.goto(url);
      await page.waitForFunction(() => document.querySelector('#signalText')?.textContent.includes('Ready'));
      await page.locator('#parkedButton').click();
      await page.waitForFunction(() => window.geoOk);
      await page.evaluate(async () => {
        const { sampleAt } = await import('./engine.js');
        const roads = await (await fetch('./data/roads.json')).json();
        const road = roads.roads.find(row => row.id === 'osm-way-32877553');
        const now = Date.now() - 2000;
        for (const [distance, ms] of [[20,0],[70,1000]]) {
          const fix = sampleAt(road, distance);
          window.geoOk({ coords: { latitude: fix.latitude, longitude: fix.longitude,
            accuracy: 5, heading: fix.heading, speed: 22 }, timestamp: now + ms });
        }
      });
      check(await geometry(page), `${width}x${height} live`);
      if (process.env.DELTA_LAYOUT_SCREENSHOTS)
        await page.screenshot({ path: `/tmp/delta-layout-${width}x${height}-live.png` });
      await page.evaluate(() => {
        document.querySelector('#roadRef').textContent = 'Central Expressway towards the North and a very long destination name';
        document.querySelector('#roadDirection').textContent = 'Provisional transfer via a lengthy connector to multiple destinations';
        document.querySelector('#speedValue').textContent = '188';
        const delta = document.querySelector('#deltaValue');
        delta.textContent = '+123.4';
        delta.style.setProperty('--delta-scale', String(Math.min(1, 4 / delta.textContent.length)));
        document.querySelector('#limitContext').textContent = 'ASSUMED LIMIT · MAP DATA UNCERTAIN';
        document.querySelector('#speedWarning').hidden = false;
        document.querySelector('#speedWarning').classList.add('is-visible');
        for (const li of document.querySelectorAll('#exitList li'))
          li.querySelector('.exit-name').textContent += ' · Long named exit to Thomson Road and the Central Business District';
      });
      check(await geometry(page), `${width}x${height} stress`);
      if (process.env.DELTA_LAYOUT_SCREENSHOTS)
        await page.screenshot({ path: `/tmp/delta-layout-${width}x${height}-stress.png` });
      await page.evaluate(() => {
        const delta = document.querySelector('#deltaValue');
        delta.textContent = '<−60';
        delta.style.setProperty('--delta-scale', String(Math.min(1, 4 / delta.textContent.length)));
      });
      check(await geometry(page), `${width}x${height} ahead cap`);
      await page.locator('#settingsButton').click();
      const settings = await page.evaluate(() => {
        const drawer = document.querySelector('#infoDrawer');
        return { body: document.documentElement.scrollHeight,
          scroll: drawer.scrollHeight, client: drawer.clientHeight, top: drawer.scrollTop,
          version: document.querySelector('#appVersion').getBoundingClientRect().top };
      });
      assert.ok(settings.body <= height + 1, `${width}x${height}: Settings causes body scroll`);
      assert.ok(settings.scroll > settings.client, `${width}x${height}: Settings needs its own scroll`);
      assert.equal(settings.top, 0);
      assert.ok(settings.version >= 0 && settings.version < height);
      await page.close();
    }
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(url);
    await page.evaluate(() => {
      document.querySelector('#safetyGate').hidden = true;
      document.querySelector('#setupPanel').hidden = true;
      document.querySelector('#drivePanel').hidden = false;
    });
    for (const [width, height] of [[390,844],[390,744],[320,568],[390,844],[844,390]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(130);
      const g = await geometry(page);
      assert.ok(g.scroll <= height + 1 && g.exits.bottom <= height - 15 && g.gear.width >= 44,
        `${width}x${height}: resize geometry`);
    }
    await page.close();
  } finally { await browser.close(); await new Promise(resolve => http.close(resolve)); }
});

test('live speed colors override positive pace and stale readings become neutral', { timeout: 45000 }, async () => {
  const { http, url } = await server();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    for (const theme of ['dark', 'light']) {
    const colors = theme === 'dark' ? { good: 'rgb(213, 250, 90)', caution: 'rgb(255, 209, 102)',
      danger: 'rgb(255, 105, 101)', neutral: 'rgb(155, 173, 159)' } :
      { good: 'rgb(71, 117, 27)', caution: 'rgb(140, 90, 0)',
        danger: 'rgb(179, 34, 34)', neutral: 'rgb(104, 124, 108)' };
    const page = await browser.newPage({ viewport: { width: 320, height: 568 } });
    await page.addInitScript(() => {
      navigator.geolocation.watchPosition = (ok, error) => {
        window.geoOk = ok; window.geoError = error; return 1;
      };
      navigator.geolocation.clearWatch = () => {};
    });
    await page.goto(url);
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.waitForFunction(() => document.querySelector('#signalText').textContent.includes('Ready'));
    await page.locator('#parkedButton').click();
    await page.waitForFunction(() => window.geoOk);
    const fix = async (distance, ms, speedKmh) => page.evaluate(async ({ distance, ms, speedKmh }) => {
      const { sampleAt } = await import('./engine.js');
      const data = await (await fetch('./data/roads.json')).json();
      const road = data.roads.find(row => row.id === 'osm-way-32877553');
      window.colorBase ??= Date.now() - 6000;
      const point = sampleAt(road, distance);
      window.geoOk({ coords: { latitude: point.latitude, longitude: point.longitude,
        accuracy: 5, heading: point.heading, speed: speedKmh / 3.6 },
      timestamp: window.colorBase + ms });
    }, { distance, ms, speedKmh });
    const tones = () => page.evaluate(() => ({
      speed: [...document.querySelector('#speedValue').classList].filter(x => x.startsWith('reading-')),
      delta: [...document.querySelector('#deltaValue').classList].filter(x => x.startsWith('reading-')),
      deltaText: document.querySelector('#deltaValue').textContent,
      deltaLabel: document.querySelector('#deltaLabel').textContent,
      warning: getComputedStyle(document.querySelector('#speedWarning')).visibility,
      speedColor: getComputedStyle(document.querySelector('#speedValue')).color,
      deltaColor: getComputedStyle(document.querySelector('#deltaValue')).color,
      warningColor: getComputedStyle(document.querySelector('#speedWarning')).color,
    }));
    await fix(20, 0, 79);
    await fix(30, 4000, 79);
    let state = await tones();
    assert.deepEqual(state.speed, ['reading-good']);
    assert.deepEqual(state.delta, ['reading-good']);
    assert.equal(state.speedColor, colors.good);
    assert.equal(state.deltaColor, colors.good);
    assert.match(state.deltaLabel, /BEHIND REFERENCE/);
    await fix(40, 5000, 85);
    state = await tones();
    assert.deepEqual(state.speed, ['reading-caution']);
    assert.deepEqual(state.delta, ['reading-caution']);
    assert.equal(state.speedColor, colors.caution);
    assert.equal(state.deltaColor, colors.caution);
    await fix(50, 6000, 100);
    state = await tones();
    assert.deepEqual(state.speed, ['reading-danger']);
    assert.deepEqual(state.delta, ['reading-danger']);
    assert.equal(state.warning, 'visible');
    assert.equal(state.speedColor, colors.danger);
    assert.equal(state.deltaColor, colors.danger);
    assert.equal(state.warningColor, colors.danger);
    await page.evaluate(() => window.geoError({ code: 2, message: 'GPS unavailable' }));
    state = await tones();
    assert.deepEqual(state.speed, ['reading-neutral']);
    assert.deepEqual(state.delta, ['reading-neutral']);
    assert.equal(state.speedColor, colors.neutral);
    assert.equal(state.deltaColor, colors.neutral);
    await page.evaluate(async () => {
      const { sampleAt } = await import('./engine.js');
      const data = await (await fetch('./data/roads.json')).json();
      const road = data.roads.find(row => row.id === 'osm-way-32877553');
      for (let second = 7; second <= 82; second++) {
        const point = sampleAt(road, second === 7 ? 60 : 70);
        window.geoOk({ coords: { latitude: point.latitude, longitude: point.longitude,
          accuracy: 5, heading: point.heading, speed: 79 / 3.6 },
        timestamp: window.colorBase + second * 1000 });
      }
    });
    state = await tones();
    assert.equal(state.deltaText, '>60');
    assert.deepEqual(state.delta, ['reading-good']);
    assert.equal(state.deltaColor, colors.good);
    await page.close();
    }
  } finally { await browser.close(); await new Promise(resolve => http.close(resolve)); }
});
