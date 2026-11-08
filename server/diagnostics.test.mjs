import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { handleDiagnostics } from './diagnostics.js';
import { validateManifest, validateEvent } from '../dist/diagnostics-format.js';

const schema = [new URL('../drizzle/0000_calm_thunderball.sql', import.meta.url), new URL('../drizzle/0001_nebulous_squadron_supreme.sql', import.meta.url)].map(url => readFileSync(url, 'utf8').replaceAll('--> statement-breakpoint', '')).join('\n');
const hash = x => createHash('sha256').update(x).digest('hex');
function fixture() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(schema);
  const objects = new Map();
  const env = {
    DIAGNOSTICS_UPLOAD_KEY: 'a-secret-long-enough-for-diagnostics',
    DIAGNOSTICS_RETENTION_READY: 'true',
    DIAGNOSTICS_ANALYST_EMAILS: 'analyst@example.com',
    ROAD_DATA_VERSION: 'a'.repeat(64),
    DIAGNOSTICS_DB: { prepare(sql) { let params = []; return {
      bind(...values) { params = values; return this; },
      first() { return sqlite.prepare(sql).get(...params) || null; },
      all() { return { results: sqlite.prepare(sql).all(...params) }; },
      run() { return sqlite.prepare(sql).run(...params); }
    }; } },
    DIAGNOSTICS_BUCKET: {
      async put(key, value) { objects.set(key, new Uint8Array(value instanceof Uint8Array ? value : await new Response(value).arrayBuffer())); },
      async get(key) { const value = objects.get(key); return value ? { arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) } : null; },
      async head(key) { const value = objects.get(key); return value ? { size: value.byteLength } : null; },
      async delete(key) { objects.delete(key); }
    }
  };
  objects.set(`road-data/${env.ROAD_DATA_VERSION}/roads.json`, new Uint8Array([123,125]));
  objects.set(`road-data/${env.ROAD_DATA_VERSION}/local-roads.json.gz`, new Uint8Array([1]));
  return { env, sqlite, objects };
}
const origin = 'https://delta.example';
const request = (path, method, body, headers = {}) => new Request(origin + path, { method, headers: { origin, ...headers }, body });

test('manifest and event limits', () => {
  assert.equal(validateEvent({ type: 'fix', recordedAt: new Date().toISOString(), seq: 0, fix: {} }), true);
  assert.equal(validateEvent({ type: 'fix', recordedAt: new Date().toISOString(), seq: 0 }), false);
  assert.equal(validateManifest({}), false);
});

test('upload key configuration requires six characters and still validates the supplied key', async () => {
  for (const key of ['', '12345', '123456', '1234567']) {
    const { env } = fixture();
    env.DIAGNOSTICS_UPLOAD_KEY = key;
    const response = await handleDiagnostics(request('/api/diagnostics/auth', 'POST', JSON.stringify({ key })), env);
    assert.equal(response.status, key.length >= 6 ? 204 : 503);
    if (key.length >= 6) {
      const rejected = await handleDiagnostics(request('/api/diagnostics/auth', 'POST', JSON.stringify({ key: 'incorrect' })), env);
      assert.equal(rejected.status, 401);
    }
  }
});

test('owner health verifies the canonical asset URL without exposing recordings', async () => {
  const { env } = fixture();
  env.ASSETS = { fetch: async request => new Response('', { status: new URL(request.url).pathname === '/' ? 200 : 307 }) };
  const response = await handleDiagnostics(request('/mcp', 'POST', JSON.stringify({ jsonrpc: '2.0', id: 1,
    method: 'tools/call', params: { name: 'diagnostics_health', arguments: {} } }), {
      'oai-authenticated-user-id': 'owner', 'oai-authenticated-user-email': 'analyst@example.com'
    }), env);
  const health = JSON.parse((await response.json()).result.content[0].text);
  assert.equal(health.schemaReady, true);
  assert.equal(health.assetsReady, true);
});

test('two-hour 1440-chunk manifests fit while chunk and body caps remain bounded', async () => {
  const { env } = fixture();
  const now = new Date().toISOString();
  const base = { recordingId: crypto.randomUUID(), formatVersion: 1, appVersion: 'test', buildId: 'test', roadDataVersion: env.ROAD_DATA_VERSION, configuration: {}, startedAt: now, endedAt: now, issue: '', eventCount: 1440 };
  const chunk = index => ({ index, sha256: '0'.repeat(64), compressedBytes: 1, expandedBytes: 1, eventCount: 1 });
  const manifest = { ...base, chunks: Array.from({ length: 1440 }, (_, i) => chunk(i)) };
  assert.equal(validateManifest(manifest), true);
  assert.equal(validateManifest({ ...manifest, eventCount: 2049, chunks: Array.from({ length: 2049 }, (_, i) => chunk(i)) }), false);
  const auth = await handleDiagnostics(request('/api/diagnostics/auth', 'POST', JSON.stringify({ key: env.DIAGNOSTICS_UPLOAD_KEY })), env);
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const created = await handleDiagnostics(request('/api/diagnostics/recordings', 'POST', JSON.stringify({ manifest }), { cookie, 'x-upload-token': 'f'.repeat(64) }), env);
  assert.equal(created.status, 201);
});

test('same-origin auth, per-record capability, checksum, idempotence, finalize and owner read', async () => {
  const { env, sqlite } = fixture();
  const blocked = await handleDiagnostics(new Request(origin + '/api/diagnostics/auth', { method: 'POST', body: JSON.stringify({ key: env.DIAGNOSTICS_UPLOAD_KEY }) }), env);
  assert.equal(blocked.status, 403);
  const auth = await handleDiagnostics(request('/api/diagnostics/auth', 'POST', JSON.stringify({ key: env.DIAGNOSTICS_UPLOAD_KEY })), env);
  assert.equal(auth.status, 204);
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  assert.match(auth.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Strict/);
  const event = { type: 'fix', recordedAt: new Date().toISOString(), seq: 0, fix: { latitude: 1 } };
  const expanded = Buffer.from(JSON.stringify(event) + '\n');
  const gzip = gzipSync(expanded);
  const recordingId = crypto.randomUUID(), capability = 'b'.repeat(64);
  const manifest = { recordingId, formatVersion: 1, appVersion: '0.3.7', buildId: 'build', roadDataVersion: env.ROAD_DATA_VERSION, configuration: {}, startedAt: event.recordedAt, endedAt: event.recordedAt, issue: '', eventCount: 1, chunks: [{ index: 0, sha256: hash(gzip), compressedBytes: gzip.length, expandedBytes: expanded.length, eventCount: 1 }] };
  assert.equal(validateManifest(manifest), true);
  const headers = { cookie, 'x-upload-token': capability };
  const base = `/api/diagnostics/recordings/${recordingId}`;
  const created = await handleDiagnostics(request('/api/diagnostics/recordings', 'POST', JSON.stringify({ manifest }), headers), env);
  assert.equal(created.status, 201);
  assert.equal((await handleDiagnostics(request(base + '/status', 'GET', undefined, { cookie, 'x-upload-token': 'c'.repeat(64) }), env)).status, 404);
  const uploaded = await handleDiagnostics(request(base + '/chunks/0', 'PUT', gzip, { ...headers, 'content-encoding': 'gzip' }), env);
  assert.equal(uploaded.status, 201);
  assert.equal((await handleDiagnostics(request(base + '/chunks/0', 'PUT', gzip, { ...headers, 'content-encoding': 'gzip' }), env)).status, 200);
  const status = await (await handleDiagnostics(request(base + '/status', 'GET', undefined, headers), env)).json();
  assert.deepEqual(status.uploadedChunks, [0]); assert.equal(status.uploadedChunkChecksums[0], hash(gzip));
  assert.equal((await handleDiagnostics(request(base + '/finalize', 'POST', undefined, headers), env)).status, 200);
  assert.equal(sqlite.prepare('SELECT status FROM diagnostic_recordings').get().status, 'completed');
  const mcp = await handleDiagnostics(request('/mcp', 'POST', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recording_summary', arguments: { recordingId } } }), { 'oai-authenticated-user-id': 'owner', 'oai-authenticated-user-email': 'analyst@example.com' }), env);
  assert.equal(mcp.status, 200);
  assert.equal(JSON.parse((await mcp.json()).result.content[0].text).manifestBase.recordingId, recordingId);
  assert.equal((await handleDiagnostics(request('/mcp', 'POST', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recording_summary', arguments: { recordingId } } })), env)).status, 401);
});

test('authentication limit persists in D1 and key rotation invalidates cookies', async () => {
  const { env, sqlite } = fixture();
  const make = key => request('/api/diagnostics/auth', 'POST', JSON.stringify({ key }), { 'cf-connecting-ip': '203.0.113.9' });
  for (let i = 0; i < 5; i++) assert.equal((await handleDiagnostics(make('wrong'), env)).status, 401);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM diagnostic_auth_failures').get().n, 5);
  assert.equal((await handleDiagnostics(make(env.DIAGNOSTICS_UPLOAD_KEY), env)).status, 429);
  const good = await handleDiagnostics(request('/api/diagnostics/auth', 'POST', JSON.stringify({ key: env.DIAGNOSTICS_UPLOAD_KEY }), { 'cf-connecting-ip': '203.0.113.10' }), env);
  assert.equal(good.status, 204);
  const cookie = good.headers.get('set-cookie').split(';')[0];
  env.DIAGNOSTICS_UPLOAD_KEY = 'rotated-secret-long-enough-for-diagnostics';
  assert.equal((await handleDiagnostics(request('/api/diagnostics/recordings/x/status', 'GET', undefined, { cookie }), env)).status, 401);
});

test('unauthorized requests are rejected before reading bodies; malformed MCP stays JSON-RPC', async () => {
  const { env } = fixture();
  const bad = new Request(origin + '/api/diagnostics/recordings', { method: 'POST', headers: { origin: 'https://attacker.example' }, body: new ReadableStream({ pull() { throw new Error('body read'); } }), duplex: 'half' });
  assert.equal((await handleDiagnostics(bad, env)).status, 403);
  const malformed = await handleDiagnostics(request('/mcp', 'POST', '{invalid'), env);
  assert.equal((await malformed.json()).error.code, -32700);
  const discover = await handleDiagnostics(request('/mcp', 'POST', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' })), { DIAGNOSTICS_DB: null });
  assert.deepEqual((await discover.json()).result.supportedVersions, ['2026-07-28']);
});

test('chunk validation rejects bad gzip and expanded sizes without storing data', async () => {
  const { env, objects } = fixture();
  const auth = await handleDiagnostics(request('/api/diagnostics/auth', 'POST', JSON.stringify({ key: env.DIAGNOSTICS_UPLOAD_KEY })), env);
  const cookie = auth.headers.get('set-cookie').split(';')[0], capability = 'd'.repeat(64);
  const headers = { cookie, 'x-upload-token': capability };
  const id = crypto.randomUUID();
  const event = { type: 'fix', recordedAt: new Date().toISOString(), seq: 0, fix: {} };
  const oversized = Buffer.from(JSON.stringify({ ...event, padding: 'x'.repeat(262144) }) + '\n');
  const gzip = gzipSync(oversized);
  const manifest = { recordingId: id, formatVersion: 1, appVersion: 'test', buildId: 'test', roadDataVersion: env.ROAD_DATA_VERSION, configuration: {}, startedAt: event.recordedAt, endedAt: event.recordedAt, issue: '', eventCount: 1, chunks: [{ index: 0, sha256: hash(gzip), compressedBytes: gzip.length, expandedBytes: 1, eventCount: 1 }] };
  assert.equal((await handleDiagnostics(request('/api/diagnostics/recordings', 'POST', JSON.stringify({ manifest }), headers), env)).status, 201);
  const path = `/api/diagnostics/recordings/${id}/chunks/0`;
  assert.equal((await handleDiagnostics(request(path, 'PUT', gzip, { ...headers, 'content-encoding': 'gzip' }), env)).status, 422);
  assert.equal((await handleDiagnostics(request(path, 'PUT', Buffer.from('bogus'), { ...headers, 'content-encoding': 'gzip' }), env)).status, 422);
  assert.equal([...objects.keys()].filter(x => x.startsWith(`diagnostics/${id}/`)).length, 0);
  const blocked = new Request(origin + path, { method: 'PUT', headers: { origin, cookie, 'x-upload-token': 'e'.repeat(64), 'content-encoding': 'gzip' }, body: new ReadableStream({ pull() { throw new Error('body read'); } }), duplex: 'half' });
  assert.equal((await handleDiagnostics(blocked, env)).status, 404);
});

test('expired rows are hidden and cleanup pages through orphan objects', async () => {
  const { env, sqlite, objects } = fixture();
  const id = crypto.randomUUID();
  sqlite.prepare('INSERT INTO diagnostic_recordings(id,manifest,status,created_at,completed_at,expires_at,upload_token_hash) VALUES(?,?,?,?,?,?,?)').run(id, JSON.stringify({ issue: '', roadDataVersion: env.ROAD_DATA_VERSION }), 'completed', 1, 1, 1, 'x');
  const call = (name, args) => request('/mcp', 'POST', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), { 'oai-authenticated-user-id': 'owner', 'oai-authenticated-user-email': 'analyst@example.com' });
  const listing = await (await handleDiagnostics(call('list_recordings', {}), env)).json();
  assert.deepEqual(JSON.parse(listing.result.content[0].text), []);
  const summary = await (await handleDiagnostics(call('recording_summary', { recordingId: id }), env)).json();
  assert.equal(summary.result.isError, true);
  const cleaned = await (await handleDiagnostics(call('cleanup_expired', {}), env)).json();
  assert.equal(JSON.parse(cleaned.result.content[0].text).deleted, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM diagnostic_recordings').get().n, 0);
});
