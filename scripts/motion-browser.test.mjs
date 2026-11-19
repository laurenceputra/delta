// Synthetic motion browser QA. This verifies UI and storage behavior, not real driving accuracy.
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
        path.endsWith('.css') ? 'text/css' : path.endsWith('.json') ? 'application/json' :
        path.endsWith('.gz') ? 'application/gzip' : 'text/html');
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  return { http, url: `http://127.0.0.1:${http.address().port}/` };
}

async function motionPage(browser, url, permission = 'granted') {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await page.addInitScript(value => {
    navigator.geolocation.watchPosition = ok => { window.geoOk = ok; return 1; };
    navigator.geolocation.clearWatch = () => {};
    window.DeviceMotionEvent = class {
      static requestPermission() {
        window.motionPermissionInGesture = navigator.userActivation.isActive;
        return Promise.resolve(value);
      }
    };
    window.motionEventKinds = [];
    window.addEventListener('devicemotion', event => {
      window.motionEventKinds.push({ acceleration: !!event.acceleration,
        gravity: !!event.accelerationIncludingGravity });
    });
  }, permission);
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#signalText')?.textContent.includes('Ready'));
  await page.locator('#parkedButton').click();
  await page.waitForFunction(() => window.geoOk);
  await page.evaluate(async () => {
    const { sampleAt } = await import('./engine.js');
    const data = await (await fetch('./data/roads.json')).json();
    const road = data.roads.find(row => row.id === 'osm-way-32877553');
    const point = sampleAt(road, 20);
    for (const timestamp of [Date.now() - 1000, Date.now()])
      window.geoOk({ coords: { latitude: point.latitude, longitude: point.longitude,
        accuracy: 5, heading: point.heading, speed: 0 }, timestamp });
  });
  await page.locator('#settingsButton').click();
  return page;
}

async function samples(page, count, acceleration = { x: 0, y: 0, z: 0 }, interval = 230,
  rotation = { alpha: 0, beta: 0, gamma: 0 }, gravity = { x: 0, y: 0, z: 9.81 }) {
  await page.evaluate(async ({ count, acceleration, interval, rotation, gravity }) => {
    for (let index = 0; index < count; index++) {
      const event = new Event('devicemotion');
      Object.defineProperties(event, {
        acceleration: { value: acceleration },
        accelerationIncludingGravity: { value: gravity },
        rotationRate: { value: rotation },
      });
      window.dispatchEvent(event);
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }, { count, acceleration, interval, rotation, gravity });
}

test('Smooth Driving defaults on, uses parked permission and works without recording', { timeout: 45000 }, async () => {
  const { http, url } = await preview();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await motionPage(browser, url);
    const toggle = page.locator('#motionBorderToggle');
    const border = page.locator('#motionBorder');
    assert.equal(await toggle.isChecked(), true);
    assert.equal(await page.evaluate(() => window.motionPermissionInGesture), true);
    await samples(page, 23, undefined, 150);
    assert.equal(await border.evaluate(node => node.classList.contains('neutral')), false);
    assert.equal(await page.locator('#diagnosticsIndicator').isVisible(), false);
    await samples(page, 12, {x:4,y:0,z:0}, 140, undefined, {x:4,y:0,z:9.81});
    assert.equal(await border.evaluate(node => node.style.getPropertyValue('--motion-hue')), '0');
    await page.locator('#recordDiagnosticsButton').click();
    await page.getByRole('button', {name:'Stop recording'}).waitFor();
    await page.locator('#recordDiagnosticsButton').click();
    assert.equal(await border.evaluate(node => node.classList.contains('neutral')), false);
    await toggle.uncheck();
    assert.equal(await border.isVisible(), false);
    await page.reload();
    await page.locator('#parkedButton').click();
    await page.locator('#settingsButton').click();
    assert.equal(await toggle.isChecked(), false);
    assert.equal(await border.isVisible(), false);
    assert.equal(await page.evaluate(() => window.motionPermissionInGesture), undefined);
    await toggle.check();
    await samples(page, 23, undefined, 150);
    assert.equal(await border.isVisible(), true);
    await page.close();
    const denied = await motionPage(browser, url, 'denied');
    assert.match(await denied.locator('#motionStatus').textContent(), /permission was not granted/i);
    assert.equal(await denied.locator('#motionBorder').isVisible(), false);
    assert.equal(await denied.locator('#motionEnableButton').isVisible(), true);
    await denied.close();
  } finally { await browser.close(); await new Promise(resolve => http.close(resolve)); }
});
