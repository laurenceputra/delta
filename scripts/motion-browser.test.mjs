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

test('motion beta starts hidden and Settings remain usable on compact screens', { timeout: 45000 }, async () => {
  const { http, url } = await preview();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    for (const [width, height] of [[320,568],[390,844],[844,390]]) {
      const page = await browser.newPage({ viewport: { width, height }, serviceWorkers: 'block' });
      await page.addInitScript(() => {
        navigator.geolocation.watchPosition = ok => { window.geoOk = ok; return 1; };
        navigator.geolocation.clearWatch = () => {};
      });
      await page.goto(url);
      await page.waitForFunction(() => document.querySelector('#signalText')?.textContent.includes('Ready'));
      assert.equal(await page.locator('#motionBorder').isVisible(), false);
      assert.equal(await page.locator('#motionBetaIndicator').isVisible(), false);
      assert.equal(await page.locator('#motionBorder').evaluate(node => getComputedStyle(node).pointerEvents), 'none');
      await page.locator('#parkedButton').click();
      await page.locator('#paceViewButton').click();
      await page.evaluate(async () => {
        const { sampleAt } = await import('./engine.js');
        const roads = await (await fetch('./data/roads.json')).json();
        const road = roads.roads.find(row => row.id === 'osm-way-32877553');
        const base = Date.now() - 2000;
        for (const [distance, ms] of [[20,0],[70,1000]]) {
          const fix = sampleAt(road, distance);
          window.geoOk({ coords: { latitude: fix.latitude, longitude: fix.longitude,
            accuracy: 5, heading: fix.heading, speed: 22 }, timestamp: base + ms });
        }
      });
      const before = await page.evaluate(() => ({ road: document.querySelector('#roadRef').textContent,
        delta: document.querySelector('#deltaValue').textContent,
        exits: document.querySelectorAll('#exitList li:not(.empty-exits)').length }));
      assert.equal(before.exits, 3);
      const header = await page.evaluate(() => {
        const indicator = document.querySelector('#motionBetaIndicator');
        indicator.hidden = false;
        const badge = indicator.getBoundingClientRect();
        const clock = document.querySelector('#clock').getBoundingClientRect();
        const gear = document.querySelector('#settingsButton').getBoundingClientRect();
        const brand = document.querySelector('.brand').getBoundingClientRect();
        return { badgeLeft: badge.left, badgeRight: badge.right, clockLeft: clock.left,
          clockRight: clock.right, gearLeft: gear.left, gearRight: gear.right,
          clockWidth: clock.width, gearWidth: gear.width, gearHeight: gear.height, brandRight: brand.right,
          scroll: document.documentElement.scrollHeight };
      });
      assert.ok(header.brandRight < header.badgeLeft &&
        (header.clockWidth ? header.badgeRight <= header.clockLeft + 1 &&
          header.clockRight <= header.gearLeft + 1 : header.badgeRight <= header.gearLeft + 1) &&
        header.gearRight <= width + 1,
      `${width}x${height} Beta header collision ${JSON.stringify(header)}`);
      assert.ok(header.gearWidth >= 44 && header.gearHeight >= 44 && header.scroll <= height + 1);
      await page.evaluate(() => { document.querySelector('#motionBetaIndicator').hidden = true; });
      await page.locator('#settingsButton').click();
      const settings = await page.evaluate(() => {
        const drawer = document.querySelector('#infoDrawer');
        const enable = document.querySelector('#motionEnableButton').getBoundingClientRect();
        const calibrate = document.querySelector('#motionCalibrateButton').getBoundingClientRect();
        const control = document.querySelector('.motion-border-control').getBoundingClientRect();
        drawer.scrollTop = drawer.scrollHeight;
        return { body: document.documentElement.scrollHeight, height: innerHeight,
          drawerScroll: drawer.scrollHeight, drawerClient: drawer.clientHeight,
          enableHeight: enable.height, calibrateHeight: calibrate.height,
          controlHeight: control.height, sectionRight: document.querySelector('#motionBetaSection').getBoundingClientRect().right,
          viewportWidth: innerWidth, bottomReachable: drawer.scrollTop > 0 };
      });
      assert.ok(settings.body <= height + 1, `${width}x${height} body scroll`);
      assert.ok(settings.drawerScroll > settings.drawerClient && settings.bottomReachable);
      assert.ok(settings.enableHeight >= 44 && settings.calibrateHeight >= 44 && settings.controlHeight >= 44,
        `${width}x${height} motion control target`);
      assert.ok(settings.sectionRight <= settings.viewportWidth + 1);
      await page.locator('#closeInfoButton').click();
      const after = await page.evaluate(() => ({ road: document.querySelector('#roadRef').textContent,
        delta: document.querySelector('#deltaValue').textContent,
        exits: document.querySelectorAll('#exitList li:not(.empty-exits)').length,
        scroll: document.documentElement.scrollHeight }));
      assert.deepEqual({road:after.road,delta:after.delta,exits:after.exits}, before,
        'opening Motion Beta settings must not reset route or pace');
      assert.ok(after.scroll <= height + 1);
      await page.close();
    }
  } finally { await browser.close(); await new Promise(resolve => http.close(resolve)); }
});

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
  await page.locator('#motionEnableButton').scrollIntoViewIfNeeded();
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

test('motion permission denial and absent sensor do not claim live feedback or recording', { timeout: 45000 }, async () => {
  const { http, url } = await preview();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const denied = await motionPage(browser, url, 'denied');
    await denied.locator('#motionEnableButton').click();
    assert.equal(await denied.evaluate(() => window.motionPermissionInGesture), true,
      'iOS permission request must happen inside the tap gesture');
    assert.match(await denied.locator('#motionStatus').textContent(), /permission.*not granted/i);
    assert.equal(await denied.locator('#motionBetaIndicator').isVisible(), false);
    assert.equal(await denied.locator('#diagnosticsIndicator').isVisible(), false);
    await denied.close();

    const absent = await motionPage(browser, url);
    await absent.locator('#motionEnableButton').click();
    assert.equal(await absent.evaluate(() => window.motionPermissionInGesture), true);
    assert.equal(await absent.locator('#motionBetaIndicator').textContent(), 'BETA · SETUP');
    await absent.waitForTimeout(10000);
    const absentState = await absent.evaluate(() => ({status:document.querySelector('#motionStatus').textContent,
      events:window.motionEventKinds.length,kinds:window.motionEventKinds.slice(0,3)}));
    assert.match(absentState.status, /No sensor readings arrived/, JSON.stringify(absentState));
    assert.equal(await absent.locator('#motionBetaIndicator').isVisible(), false);
    assert.equal(await absent.locator('#diagnosticsIndicator').isVisible(), false);
    await absent.close();
  } finally { await browser.close(); await new Promise(resolve => http.close(resolve)); }
});

test('calibration gates feedback and auto recording; motion colors and saved events stay local', { timeout: 60000 }, async () => {
  const { http, url } = await preview();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await motionPage(browser, url);
    let uploads = 0;
    page.on('request', request => { if (request.url().includes('/api/diagnostics/')) uploads++; });
    const before = await page.evaluate(() => ({ road: document.querySelector('#roadRef').textContent,
      delta: document.querySelector('#deltaValue').textContent,
      view: document.documentElement.dataset.dashboardView }));
    await page.locator('#motionEnableButton').click();
    assert.equal(await page.evaluate(() => window.motionPermissionInGesture), true);
    assert.equal(await page.locator('#motionBetaIndicator').textContent(), 'BETA · SETUP');
    await samples(page, 1);
    await page.waitForFunction(() => document.querySelector('#motionBetaIndicator')?.textContent === 'BETA · REC',
      null, { timeout: 5000 });
    assert.match(await page.locator('#motionStatus').textContent(), /Learning sensor orientation.*recording locally/i);
    assert.equal(await page.locator('#motionBorder').evaluate(node => node.classList.contains('neutral')), true,
      'warmup must remain neutral while already recording');
    await samples(page, 8, { x: 1.5, y: 0, z: 0 }, 150);
    assert.equal(await page.locator('#motionBetaIndicator').textContent(), 'BETA · REC');
    await samples(page, 22, { x: 0, y: 0, z: 0 }, 150);
    await page.waitForFunction(() => /Motion feedback active/.test(document.querySelector('#motionStatus')?.textContent),
      null, { timeout: 5000 });
    const afterSetup = await page.evaluate(() => ({ road: document.querySelector('#roadRef').textContent,
      delta: document.querySelector('#deltaValue').textContent,
      view: document.documentElement.dataset.dashboardView }));
    assert.deepEqual(afterSetup, before, 'Beta setup cannot reset route, pace, or dashboard view');
    assert.match(await page.locator('#motionStatus').textContent(), /recording locally/i);
    await page.locator('#closeInfoButton').click();
    await samples(page, 2);
    const calm = await page.locator('#motionBorder').evaluate(node => ({ hidden: node.hidden,
      neutral: node.classList.contains('neutral'), hue: Number(node.style.getPropertyValue('--motion-hue')),
      opacity: Number(node.style.getPropertyValue('--motion-opacity')) }));
    assert.equal(calm.hidden, false);
    assert.equal(calm.neutral, false);
    assert.ok(calm.hue >= 100 && calm.opacity >= .3 && calm.opacity <= .5,
      `calm motion is subtle green ${JSON.stringify(calm)}`);
    await page.evaluate(async () => {
      const { sampleAt } = await import('./engine.js');
      const data = await (await fetch('./data/roads.json')).json();
      const road = data.roads.find(row => row.id === 'osm-way-32877553');
      const point = sampleAt(road, 70);
      window.geoOk({ coords: { latitude: point.latitude, longitude: point.longitude,
        accuracy: 5, heading: point.heading, speed: 15 }, timestamp: Date.now() });
    });
    await samples(page, 4, { x: 8, y: 0, z: 0 }, 110);
    const abrupt = await page.locator('#motionBorder').evaluate(node => ({
      hue: Number(node.style.getPropertyValue('--motion-hue')),
      opacity: Number(node.style.getPropertyValue('--motion-opacity')) }));
    assert.ok(abrupt.hue < calm.hue && abrupt.opacity > calm.opacity,
      `abrupt synthetic motion should shift green toward red and raise opacity: ${JSON.stringify({ calm, abrupt })}`);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(await page.locator('#motionBorder').evaluate(node => node.classList.contains('neutral')), true,
      'backgrounding neutralizes motion feedback immediately');
    await page.locator('#settingsButton').click();
    assert.match(await page.locator('#motionStatus').textContent(),
      /App was in the background.*resumes automatically.*visible.*sensor readings return/i);
    await page.locator('#closeInfoButton').click();
    await page.evaluate(() => {
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await samples(page, 2);
    await page.locator('#settingsButton').click();
    assert.match(await page.locator('#motionStatus').textContent(), /Motion feedback active/,
      'background reason clears after valid readings');
    assert.doesNotMatch(await page.locator('#motionStatus').textContent(), /background|interrupted/i);
    await page.locator('#closeInfoButton').click();
    await page.waitForTimeout(1800);
    assert.equal(await page.locator('#motionBorder').evaluate(node => node.classList.contains('neutral')), true,
      'sensor stale state must be neutral');
    await page.locator('#settingsButton').click();
    assert.match(await page.locator('#motionStatus').textContent(),
      /Sensor readings interrupted.*resumes automatically after two valid readings/i);
    await page.locator('#closeInfoButton').click();
    await samples(page, 2);
    await page.locator('#settingsButton').click();
    assert.match(await page.locator('#motionStatus').textContent(), /Motion feedback active/,
      'sensor gap reason clears after two valid readings');
    await page.locator('#motionEnableButton').click();
    await page.waitForFunction(() => document.querySelector('#motionBetaIndicator').hidden &&
      document.querySelector('#diagnosticsIndicator').hidden);
    const saved = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('delta-diagnostics-v1');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const getAll = store => new Promise((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const records = await getAll('recordings'), chunks = await getAll('chunks');
      const events = [];
      for (const chunk of chunks) {
        const text = await new Response(new Blob([chunk.data]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
        events.push(...text.trim().split('\n').map(line => JSON.parse(line)));
      }
      return { records: records.map(row => ({ status: row.status, eventCount: row.eventCount })),
        types: [...new Set(events.map(event => event.type))],
        markers: events.filter(event => event.type === 'motion-event').map(event => event.motion) };
    });
    assert.equal(saved.records.length, 1);
    assert.notEqual(saved.records[0].status, 'recording');
    assert.ok(saved.records[0].eventCount > 0);
    assert.ok(saved.types.includes('motion') && saved.types.includes('motion-event'),
      `raw motion and markers must be retained locally: ${JSON.stringify(saved)}`);
    assert.ok(saved.markers.some(marker => marker.phase === 'feedback-paused' &&
      marker.reason === 'background' && marker.recovery === 'automatic'),
    'background pause reason must survive the hidden-page recording policy');
    assert.ok(saved.markers.some(marker => marker.phase === 'feedback-paused' &&
      marker.reason === 'sensor-gap' && marker.recovery === 'automatic'));
    assert.ok(saved.markers.some(marker => marker.phase === 'feedback-resumed' &&
      marker.previousReason === 'sensor-gap'));
    assert.equal(uploads, 0, 'beta never uploads automatically');
    await page.close();
  } finally { await browser.close(); await new Promise(resolve => http.close(resolve)); }
});

test('disabling Beta preserves a pre-existing manual recording and Beta stays off after reload', { timeout: 45000 }, async () => {
  const { http, url } = await preview();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await motionPage(browser, url);
    await page.locator('#recordDiagnosticsButton').click();
    await page.waitForFunction(() => document.querySelector('#recordDiagnosticsButton').getAttribute('aria-pressed') === 'true');
    await page.locator('#motionEnableButton').click();
    await samples(page, 22, { x: 0, y: 0, z: 0 }, 150);
    await page.waitForFunction(() => document.querySelector('#motionBetaIndicator')?.textContent === 'BETA · REC');
    await page.locator('#motionEnableButton').click();
    assert.equal(await page.locator('#motionBetaIndicator').isVisible(), false);
    assert.equal(await page.locator('#recordDiagnosticsButton').getAttribute('aria-pressed'), 'true',
      'Beta must not stop a recording the driver started manually');
    assert.equal(await page.locator('#diagnosticsIndicator').isVisible(), true);
    await page.locator('#recordDiagnosticsButton').click();
    await page.waitForFunction(() => document.querySelector('#recordDiagnosticsButton').getAttribute('aria-pressed') === 'false');
    await page.reload();
    assert.equal(await page.locator('#motionEnableButton').getAttribute('aria-pressed'), 'false',
      'Beta is off on every fresh launch');
    assert.equal(await page.locator('#motionBorder').isVisible(), false);
    await page.close();
  } finally { await browser.close(); await new Promise(resolve => http.close(resolve)); }
});

test('low local storage prevents Beta feedback from claiming an active recording', { timeout: 45000 }, async () => {
  const { http, url } = await preview();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await motionPage(browser, url);
    await page.evaluate(() => Object.defineProperty(navigator.storage, 'estimate', { configurable: true,
      value: async () => ({ quota: 100_000_000, usage: 95_000_000 }) }));
    await page.locator('#motionEnableButton').click();
    await samples(page, 1);
    await page.waitForFunction(() => /Diagnostics reached a recording or storage limit/.test(document.querySelector('#motionStatus')?.textContent),
      null, { timeout: 5000 });
    assert.match(await page.locator('#motionStatus').textContent(), /Free space if needed, then recalibrate while parked/i);
    assert.equal(await page.locator('#motionBetaIndicator').textContent(), 'BETA · REC OFF');
    assert.equal(await page.locator('#motionBorder').evaluate(node => node.classList.contains('neutral')), true);
    assert.equal(await page.locator('#diagnosticsIndicator').isVisible(), false);
    await page.locator('#motionEnableButton').click();
    await page.close();
  } finally { await browser.close(); await new Promise(resolve => http.close(resolve)); }
});

test('motion stability checks recover automatically but a persistent shifted mount requires parked restart', { timeout: 75000 }, async () => {
  const { http, url } = await preview();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await motionPage(browser, url);
    await page.locator('#motionEnableButton').click();
    await samples(page, 22, { x: 0, y: 0, z: 0 }, 150);
    await page.waitForFunction(() => document.querySelector('#motionBetaIndicator')?.textContent === 'BETA · REC');
    assert.match(await page.locator('#motionStatus').textContent(), /Motion feedback active/);
    await samples(page, 5, { x: 0, y: 0, z: 0 }, 100,
      { alpha: 100, beta: 0, gamma: 0 });
    assert.match(await page.locator('#motionStatus').textContent(), /Motion feedback active/,
      'yaw about gravity must not look like phone tilt');
    await samples(page, 8, { x: 0, y: 0, z: 0 }, 50,
      { alpha: 0, beta: 60, gamma: 0 });
    assert.match(await page.locator('#motionStatus').textContent(),
      /Checking stability.*resumes automatically after stable readings/i);
    assert.equal(await page.locator('#motionBorder').evaluate(node => node.classList.contains('neutral')), true);
    await samples(page, 12, { x: 0, y: 0, z: 0 }, 100);
    assert.match(await page.locator('#motionStatus').textContent(), /Motion feedback active/,
      'brief tilt recovers after stable readings without parked action');

    await page.evaluate(() => Object.defineProperty(screen.orientation, 'angle',
      { configurable: true, value: 90 }));
    await samples(page, 2);
    assert.match(await page.locator('#motionStatus').textContent(), /Motion feedback active/,
      'screen angle alone cannot force a mount pause');

    await samples(page, 25, { x: 0, y: 0, z: 0 }, 100,
      { alpha: 0, beta: 0, gamma: 0 }, { x: 3.5, y: 0, z: 9.1 });
    assert.match(await page.locator('#motionStatus').textContent(),
      /Setup required when parked.*Restart setup while parked/i);
    assert.equal(await page.locator('#motionBorder').evaluate(node => node.classList.contains('neutral')), true);
    assert.match(await page.locator('#motionCalibrateButton').textContent(), /Restart setup while parked/i);
    await page.locator('#motionCalibrateButton').click();
    await samples(page, 22, { x: 0, y: 0, z: 0 }, 150,
      { alpha: 0, beta: 0, gamma: 0 }, { x: 3.5, y: 0, z: 9.1 });
    assert.match(await page.locator('#motionStatus').textContent(), /Motion feedback active/,
      'explicit parked restart learns the new mount pose');

    await page.evaluate(async () => {
      const { sampleAt } = await import('./engine.js');
      const data = await (await fetch('./data/roads.json')).json();
      const point = sampleAt(data.roads.find(road => road.id === 'osm-way-32877553'), 70);
      window.geoOk({ coords: { latitude: point.latitude, longitude: point.longitude,
        accuracy: 5, heading: point.heading, speed: 15 }, timestamp: Date.now() });
    });
    await samples(page, 1, { x: 35, y: 0, z: 0 });
    assert.match(await page.locator('#motionStatus').textContent(),
      /extreme sensor reading was rejected.*resumes automatically after two clean readings/i);
    assert.equal(await page.locator('#motionBorder').evaluate(node => node.classList.contains('neutral')), true);
    await samples(page, 2);
    assert.match(await page.locator('#motionStatus').textContent(), /Motion feedback active/,
      'outlier explanation clears after clean readings');

    await page.locator('#recordDiagnosticsButton').click();
    await page.waitForFunction(() => document.querySelector('#motionBetaIndicator')?.textContent === 'BETA · REC OFF');
    assert.match(await page.locator('#motionStatus').textContent(),
      /Diagnostics stopped.*Recalibrate while parked/i);
    assert.equal(await page.locator('#motionBorder').evaluate(node => node.classList.contains('neutral')), true,
      'recording stop must not leave a false green border');
    const transitions = await page.evaluate(async () => {
      const db = await new Promise((resolve,reject) => {
        const request=indexedDB.open('delta-diagnostics-v1');
        request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      });
      const rows=await new Promise((resolve,reject) => {
        const request=db.transaction('chunks').objectStore('chunks').getAll();
        request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      });
      const motions=[];
      for(const row of rows){const text=await new Response(new Blob([row.data]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
        motions.push(...text.trim().split('\n').filter(Boolean).map(JSON.parse).filter(event=>event.type==='motion').map(event=>event.motion));}
      return motions.filter(motion=>motion.transition).map(motion=>({kind:motion.transition.kind,
        rotation:motion.rotation,gravity:motion.includingGravity,atMs:motion.atMs}));
    });
    assert.ok(transitions.some(event=>event.kind==='stability-check'&&event.rotation?.[1]===60),
      'native tilt trigger must be captured with its exact sensor sample');
    assert.ok(transitions.some(event=>event.kind==='stability-recovered'));
    assert.ok(transitions.some(event=>event.kind==='setup-required'&&event.gravity?.[0]===3.5));
    await page.locator('#motionEnableButton').click();
    await page.close();
  } finally { await browser.close(); await new Promise(resolve => http.close(resolve)); }
});
