// Browser regression for staged, parked-only PWA updates. Run with node --test.
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
  let generation = 'a', stallActivation = false;
  const http = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/unknown-client') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>Other scoped window</title>');
      return;
    }
    const path = normalize(join(dist, pathname === '/' ? 'index.html' : pathname.slice(1)));
    if (!path.startsWith(`${dist}/`)) { response.writeHead(403).end(); return; }
    try {
      let content = await readFile(path);
      if (pathname === '/sw.js') content = Buffer.from(String(content).replace(
        /const CACHE = '[^']+';/, `const CACHE = 'delta-sg-qa-${generation}';`));
      if (pathname === '/sw.js' && generation === 'b' && stallActivation)
        content = Buffer.from(String(content).replace("self.addEventListener('message', event => {",
          "self.addEventListener('message', event => { if(event.data?.type==='SKIP_WAITING')return; if(event.data?.type==='QA_FORCE_ACTIVATE'){self.skipWaiting();return;}"));
      if (pathname === '/version.js') content = Buffer.from(String(content).replace(
        /export const BUILD_ID = '[^']+';/, `export const BUILD_ID = 'qa-${generation}';`));
      if (pathname === '/version.json') {
        const value = JSON.parse(content);
        value.buildId = `qa-${generation}`;
        content = Buffer.from(JSON.stringify(value));
      }
      response.setHeader('cache-control', 'no-store');
      response.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' :
        path.endsWith('.css') ? 'text/css' : path.endsWith('.json') ? 'application/json' :
        path.endsWith('.gz') ? 'application/gzip' : 'text/html');
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  return { http, url: `http://127.0.0.1:${http.address().port}/`,
    setGeneration: value => { generation = value; },
    stall: value => { stallActivation = value; } };
}

async function controlled(page, url) {
  await page.goto(url);
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!await page.evaluate(() => !!navigator.serviceWorker.controller)) await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.waitForFunction(() => document.querySelector('#signalText')?.textContent.includes('Ready'));
}

async function workerState(page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return { active: registration.active?.scriptURL || null,
      waiting: registration.waiting?.state || null,
      controller: navigator.serviceWorker.controller?.scriptURL || null,
      caches: await caches.keys(),
      version: document.querySelector('#appVersion')?.textContent,
      gate: !document.querySelector('#safetyGate').hidden,
      update: !document.querySelector('#updateNotice').hidden };
  });
}

test('parked update lifecycle', { timeout: 120000 }, async () => {
  const { http, url, setGeneration } = await preview();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext();
    const first = await context.newPage();
    await controlled(first, url);
    assert.match((await workerState(first)).version, /qa-a/);
    await first.close();
    setGeneration('b');
    const startup = await context.newPage();
    await startup.goto(url);
    // The app must activate B only if this is the sole still-parked Delta window.
    await startup.waitForFunction(() => document.querySelector('#appVersion')?.textContent.includes('qa-b'), null, { timeout: 15000 });
    assert.equal((await workerState(startup)).gate, true);
    await startup.close();
    await context.close();
  } finally { await browser.close(); await new Promise(resolve => http.close(resolve)); }
});

test('active session and other Delta window block automatic activation; sole-window manual action works', { timeout: 60000 }, async () => {
  const { http, url, setGeneration } = await preview();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      navigator.geolocation.watchPosition = () => 1;
      navigator.geolocation.clearWatch = () => {};
    });
    const active = await context.newPage();
    await controlled(active, url);
    await active.locator('#parkedButton').click();
    await active.waitForFunction(() => document.querySelector('#modeBadge')?.textContent.includes('LIVE'));
    const other = await context.newPage();
    await other.goto(url);
    const unknown = await context.newPage();
    await unknown.goto(`${url}unknown-client`);
    setGeneration('b');
    await active.evaluate(async () => (await navigator.serviceWorker.ready).update());
    await active.waitForFunction(async () => !!(await navigator.serviceWorker.ready).waiting);
    await active.waitForTimeout(400);
    assert.match((await workerState(active)).version, /qa-a/, 'active drive stays on installed code');
    assert.equal((await workerState(active)).gate, false, 'drive gate stays closed');
    assert.match(await active.locator('#modeBadge').textContent(), /LIVE/);
    await other.bringToFront();
    await active.bringToFront();
    await active.waitForTimeout(400);
    assert.match((await workerState(active)).version, /qa-a/, 'visibility resume cannot auto-reload a drive');
    assert.equal((await workerState(active)).gate, false, 'resume cannot reopen the parked gate');
    assert.match(await active.locator('#modeBadge').textContent(), /LIVE/);
    const blocked = await active.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return new Promise(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = event => resolve(event.data?.type);
        registration.waiting.postMessage({ type: 'SKIP_WAITING' }, [channel.port2]);
      });
    });
    assert.equal(blocked, 'UPDATE_BLOCKED', 'worker rejects activation with another window open');
    assert.equal((await workerState(active)).waiting, 'installed');
    await other.close();
    const unknownBlocked = await active.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return new Promise(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = event => resolve(event.data?.type);
        registration.waiting.postMessage({ type: 'SKIP_WAITING' }, [channel.port2]);
      });
    });
    assert.equal(unknownBlocked, 'UPDATE_BLOCKED', 'unknown scoped window also blocks activation');
    await unknown.close();
    await active.locator('#settingsButton').click();
    await active.waitForFunction(() => !document.querySelector('#updateNotice').hidden);
    await active.locator('#updateButton').click();
    await active.waitForFunction(() => document.querySelector('#appVersion')?.textContent.includes('qa-b'), null, { timeout: 12000 });
    assert.equal((await workerState(active)).gate, true, 'approved reload returns to parked gate');
    await context.close();
  } finally { await browser.close(); await new Promise(resolve => http.close(resolve)); }
});

test('offline startup releases gate; timed-out activation cannot reload later', { timeout: 60000 }, async () => {
  const { http, url, setGeneration, stall } = await preview();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const loads = Number(sessionStorage.getItem('qa-loads') || 0) + 1;
      sessionStorage.setItem('qa-loads', String(loads));
      navigator.geolocation.watchPosition = () => 1;
      navigator.geolocation.clearWatch = () => {};
    });
    const first = await context.newPage();
    await controlled(first, url);
    await first.close();
    await context.setOffline(true);
    const offline = await context.newPage();
    await offline.goto(url);
    await offline.waitForFunction(() => !document.querySelector('#parkedButton').disabled, null, { timeout: 4000 });
    await offline.waitForFunction(() => document.querySelector('#signalText')?.textContent.includes('Ready'), null, { timeout: 4000 });
    assert.match((await workerState(offline)).version, /qa-a/);
    await offline.close();
    await context.close();
    const activeContext = await browser.newContext();
    await activeContext.addInitScript(() => {
      const loads = Number(sessionStorage.getItem('qa-loads') || 0) + 1;
      sessionStorage.setItem('qa-loads', String(loads));
    });
    const initial = await activeContext.newPage();
    await controlled(initial, url);
    await initial.close();
    const stalled = await activeContext.newPage();
    await controlled(stalled, url);
    setGeneration('b'); stall(true);
    await stalled.evaluate(async () => (await navigator.serviceWorker.ready).update());
    await stalled.waitForFunction(async () => !!(await navigator.serviceWorker.ready).waiting, null, { timeout: 12000 });
    await stalled.reload();
    await stalled.waitForFunction(() => !document.querySelector('#parkedButton').disabled, null, { timeout: 12000 });
    const loads = await stalled.evaluate(() => Number(sessionStorage.getItem('qa-loads')));
    const before = await workerState(stalled);
    assert.match(before.version, /qa-a/);
    assert.equal(before.waiting, 'installed', `stalled worker must remain waiting: ${JSON.stringify(before)}`);
    await stalled.locator('#parkedButton').click();
    await stalled.waitForFunction(() => document.querySelector('#modeBadge')?.textContent.includes('LIVE'));
    await stalled.evaluate(async () => (await navigator.serviceWorker.ready).waiting.postMessage({ type: 'QA_FORCE_ACTIVATE' }));
    await stalled.waitForFunction(async () => !(await navigator.serviceWorker.ready).waiting, null, { timeout: 5000 });
    await stalled.waitForTimeout(800);
    assert.equal(await stalled.evaluate(() => Number(sessionStorage.getItem('qa-loads'))), loads,
      'late activation after timeout must not reload the page');
    assert.match(await stalled.locator('#modeBadge').textContent(), /LIVE/,
      'late activation must leave the active drive intact');
    await stalled.locator('#settingsButton').click();
    await stalled.waitForFunction(() => !document.querySelector('#updateNotice').hidden);
    assert.match(await stalled.locator('#updateButton').textContent(), /reload/i);
    await stalled.locator('#updateButton').click();
    await stalled.waitForFunction(() => document.querySelector('#appVersion')?.textContent.includes('qa-b'), null, { timeout: 10000 });
    assert.equal((await workerState(stalled)).gate, true,
      'an explicit parked reload installs the late update on a new gate');
    await activeContext.close();
  } finally { await browser.close(); await new Promise(resolve => http.close(resolve)); }
});
