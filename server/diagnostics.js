import { validateManifest, validateEvent, MAX_UPLOAD_CHUNK_EXPANDED_BYTES } from '../dist/diagnostics-format.js';

const encoder = new TextEncoder();
const hour = 3600000, day = 86400000;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const error = (message, status) => json({ error: message }, status);
const hex = bytes => [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
const sha256 = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', value)));
const hmac = async (key, value) => hex(new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), encoder.encode(value))));
const equal = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let n = 0; for (let i = 0; i < a.length; i++) n |= a.charCodeAt(i) ^ b.charCodeAt(i); return n === 0; };
const db = env => env.DIAGNOSTICS_DB;
const bucket = env => env.DIAGNOSTICS_BUCKET;
const secret = env => env.DIAGNOSTICS_UPLOAD_KEY;
const configured = env => typeof secret(env) === 'string' && secret(env).length >= 6 && db(env) && bucket(env) && env.DIAGNOSTICS_RETENTION_READY === 'true';
const analysisConfigured = env => db(env) && bucket(env) && typeof env.DIAGNOSTICS_ANALYST_EMAILS === 'string' && env.DIAGNOSTICS_ANALYST_EMAILS.trim();
const body = async (request, max) => {
  if (Number(request.headers.get('content-length')) > max) throw new Error('too_large');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const pieces = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) { await reader.cancel(); throw new Error('too_large'); }
    pieces.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
  return bytes;
};
const uploadToken = request => request.headers.get('x-upload-token');
const validUploadToken = value => /^[0-9a-f]{64}$/i.test(value || '');
const parse = async (request, max = 65536) => JSON.parse(new TextDecoder().decode(await body(request, max)));
const token = request => /(?:^|;\s*)delta_upload=([^;]+)/.exec(request.headers.get('cookie') || '')?.[1];
const sameOrigin = request => {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  if (origin) return origin === new URL(request.url).origin;
  return request.method === 'GET' && site === 'same-origin';
};
async function session(request, env) {
  const value = token(request);
  if (!value) return null;
  const [nonce, expiry, signature] = value.split('.');
  if (!/^[0-9a-f]{32}$/.test(nonce || '') || !/^\d{13}$/.test(expiry || '') || Number(expiry) <= Date.now() || Number(expiry) > Date.now() + hour || !/^[0-9a-f]{64}$/.test(signature || '')) return null;
  const expected = await hmac(secret(env), `${nonce}.${expiry}`);
  return equal(expected, signature) ? value : null;
}
const ip = request => request.headers.get('CF-Connecting-IP') || 'unknown';
async function auth(request, env) {
  const identity = await sha256(encoder.encode(ip(request)));
  const now = Date.now();
  const count = await db(env).prepare('SELECT COUNT(*) AS n FROM diagnostic_auth_failures WHERE ip_hash=? AND attempted_at>?').bind(identity, now - 15 * 60000).first();
  if (count.n >= 5) return error('Too many authentication attempts', 429);
  let supplied;
  try { supplied = (await parse(request, 4096)).key; } catch { return error('Invalid request', 400); }
  const expected = await sha256(encoder.encode(secret(env)));
  const actual = await sha256(encoder.encode(typeof supplied === 'string' ? supplied : ''));
  if (!equal(actual, expected)) {
    await db(env).prepare('INSERT INTO diagnostic_auth_failures(ip_hash,attempted_at) VALUES(?,?)').bind(identity, now).run();
    return error('Unauthorized', 401);
  }
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const expiry = String(now + hour);
  const value = `${nonce}.${expiry}.${await hmac(secret(env), `${nonce}.${expiry}`)}`;
  return new Response(null, { status: 204, headers: { 'set-cookie': `delta_upload=${value}; Max-Age=3600; Path=/api/diagnostics; Secure; HttpOnly; SameSite=Strict`, 'cache-control': 'no-store' } });
}
const record = (env, id) => db(env).prepare('SELECT * FROM diagnostic_recordings WHERE id=?').bind(id).first();
const objectKey = (id, index) => `diagnostics/${id}/${index}.ndjson.gz`;
const roadFiles = ['roads.json', 'local-roads.json.gz'];
const roadObjectKey = (version, file) => `road-data/${version}/${file}`;
async function ensureRoadSnapshot(env, version) {
  if (!/^[0-9a-f]{64}$/i.test(version)) return false;
  const missing = [];
  for (const file of roadFiles) if (!await bucket(env).head(roadObjectKey(version, file))) missing.push(file);
  if (!missing.length) return true;
  if (version !== env.ROAD_DATA_VERSION || !env.ASSETS?.fetch) return false;
  for (const file of missing) {
    const response = await env.ASSETS.fetch(new Request(`https://assets.internal/data/${file}`));
    if (!response.ok) return false;
    await bucket(env).put(roadObjectKey(version, file), response.body, { httpMetadata: { contentType: file.endsWith('.gz') ? 'application/gzip' : 'application/json' } });
  }
  return true;
}
const publicStatus = async (env, row) => {
  const result = await db(env).prepare('SELECT chunk_index,sha256 FROM diagnostic_chunks WHERE recording_id=? ORDER BY chunk_index').bind(row.id).all();
  return { recordingId: row.id, status: row.status, uploadedChunks: result.results.map(x => x.chunk_index), uploadedChunkChecksums: Object.fromEntries(result.results.map(x => [x.chunk_index, x.sha256])), expiresAt: new Date(row.expires_at).toISOString() };
};

async function create(request, env, sessionValue) {
  const capability = uploadToken(request);
  if (!validUploadToken(capability)) return error('Upload token required', 400);
  let manifest;
  try { manifest = (await parse(request, 512 * 1024)).manifest; } catch { return error('Invalid manifest', 400); }
  if (!validateManifest(manifest)) return error('Invalid manifest', 400);
  const id = manifest.recordingId;
  const hash = await sha256(encoder.encode(capability.toLowerCase()));
  const existing = await record(env, id);
  if (existing) {
    if (!equal(existing.upload_token_hash, hash) || existing.manifest !== JSON.stringify(manifest) || existing.expires_at < Date.now()) return error('Recording ID conflict', 409);
    return json(await publicStatus(env, existing));
  }
  const now = Date.now();
  await db(env).prepare('INSERT INTO diagnostic_recordings(id,manifest,status,created_at,expires_at,upload_token_hash) VALUES(?,?,?,?,?,?)').bind(id, JSON.stringify(manifest), 'uploading', now, now + day, hash).run();
  return json({ recordingId: id, status: 'uploading', uploadedChunks: [], expiresAt: new Date(now + day).toISOString() }, 201);
}

async function authorizedRecord(env, id, capability) {
  const row = await record(env, id);
  return row && validUploadToken(capability) && row.expires_at > Date.now() && equal(row.upload_token_hash, await sha256(encoder.encode(capability.toLowerCase()))) ? row : null;
}

async function inflateBounded(compressed, limit) {
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const parts = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new Error('expanded limit'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

async function validatePackedChunk(compressed, expected, firstSeq) {
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const summary = { counts: {}, markers: [] };
  let expandedBytes = 0, eventCount = 0, line = '';
  const consume = value => {
    if (!value) throw new Error('empty event');
    if (encoder.encode(value).byteLength > 256 * 1024) throw new Error('event line limit');
    let event;
    try { event = JSON.parse(value); } catch { throw new Error('invalid event'); }
    if (!validateEvent(event) || event.seq !== firstSeq + eventCount) throw new Error('invalid sequence');
    eventCount++;
    summary.counts[event.type] = (summary.counts[event.type] || 0) + 1;
    if (summary.markers.length < 100 && event.type !== 'motion' &&
        (event.type !== 'fix' || /outage|ramp|reset|recovery/i.test(JSON.stringify(event.state || {}))))
      summary.markers.push({ seq: event.seq, recordedAt: event.recordedAt, type: event.type,
        status: String(event.state?.status || '').slice(0, 80),
        reason: String(event.state?.reason || '').slice(0, 120),
        motionKind: String(event.motion?.kind || '').slice(0, 40),
        motionPhase: String(event.motion?.phase || '').slice(0, 60) });
  };
  const appendDecoded = decoded => {
    let start = 0, end;
    while ((end = decoded.indexOf('\n', start)) !== -1) {
      const part = decoded.slice(start, end);
      if (line.length + part.length > 256 * 1024) throw new Error('event line limit');
      consume(line + part);
      line = ''; start = end + 1;
    }
    const tail = decoded.slice(start);
    if (line.length + tail.length > 256 * 1024) throw new Error('event line limit');
    line += tail;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      expandedBytes += value.byteLength;
      if (expandedBytes > expected.expandedBytes || expandedBytes > MAX_UPLOAD_CHUNK_EXPANDED_BYTES) throw new Error('expanded limit');
      appendDecoded(decoder.decode(value, { stream: true }));
    }
    line += decoder.decode();
    if (line) consume(line);
    if (expandedBytes !== expected.expandedBytes || eventCount !== expected.eventCount) throw new Error('size/count mismatch');
    return summary;
  } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}

async function readEventPage(compressed, expected, firstSeq, eventOffset, limit) {
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const events = [];
  let expandedBytes = 0, index = 0, responseBytes = 0, line = '', pageFull = false;
  const consume = value => {
    if (!value) throw new Error('empty event');
    if (encoder.encode(value).byteLength > 256 * 1024) throw new Error('event line limit');
    let event;
    try { event = JSON.parse(value); } catch { throw new Error('invalid event'); }
    if (!validateEvent(event) || event.seq !== firstSeq + index) throw new Error('invalid sequence');
    if (index >= eventOffset && events.length < limit && !pageFull) {
      const bytes = encoder.encode(value).length;
      if (!events.length || responseBytes + bytes <= 256 * 1024) {
        events.push(event); responseBytes += bytes;
      } else pageFull = true;
    }
    index++;
  };
  const appendDecoded = decoded => {
    let start = 0, end;
    while ((end = decoded.indexOf('\n', start)) !== -1) {
      const part = decoded.slice(start, end);
      if (line.length + part.length > 256 * 1024) throw new Error('event line limit');
      consume(line + part);
      line = ''; start = end + 1;
    }
    const tail = decoded.slice(start);
    if (line.length + tail.length > 256 * 1024) throw new Error('event line limit');
    line += tail;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      expandedBytes += value.byteLength;
      if (expandedBytes > expected.expandedBytes || expandedBytes > MAX_UPLOAD_CHUNK_EXPANDED_BYTES) throw new Error('expanded limit');
      appendDecoded(decoder.decode(value, { stream: true }));
    }
    line += decoder.decode();
    if (line) consume(line);
    if (expandedBytes !== expected.expandedBytes || index !== expected.eventCount) throw new Error('size/count mismatch');
    return { events, nextEventOffset: eventOffset + events.length < index ? eventOffset + events.length : null };
  } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}

async function upload(request, env, row, index) {
  if (row.status !== 'uploading') return error('Recording finalized', 409);
  const expected = JSON.parse(row.manifest).chunks[index];
  if (!expected) return error('Invalid chunk index', 404);
  if (request.headers.get('content-encoding') !== 'gzip') return error('Gzip content encoding required', 415);
  let compressed;
  try { compressed = await body(request, expected.compressedBytes); } catch { return error('Chunk exceeds declared size', 413); }
  if (compressed.byteLength !== expected.compressedBytes || !equal(await sha256(compressed), expected.sha256.toLowerCase())) return error('Chunk checksum mismatch', 422);
  const old = await db(env).prepare('SELECT * FROM diagnostic_chunks WHERE recording_id=? AND chunk_index=?').bind(row.id, index).first();
  if (old) return equal(old.sha256, expected.sha256.toLowerCase()) ? json({ index, sha256: old.sha256, status: 'present' }) : error('Chunk conflict', 409);
  const firstSeq = JSON.parse(row.manifest).chunks.slice(0, index).reduce((n, chunk) => n + chunk.eventCount, 0);
  let summary;
  try { summary = await validatePackedChunk(compressed, expected, firstSeq); }
  catch { return error('Invalid gzip, event, or expanded size', 422); }
  const key = objectKey(row.id, index);
  await bucket(env).put(key, compressed, { httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' }, customMetadata: { sha256: expected.sha256.toLowerCase() } });
  try { await db(env).prepare('INSERT INTO diagnostic_chunks(recording_id,chunk_index,sha256,compressed_bytes,expanded_bytes,event_count,object_key,event_summary) VALUES(?,?,?,?,?,?,?,?)').bind(row.id, index, expected.sha256.toLowerCase(), expected.compressedBytes, expected.expandedBytes, expected.eventCount, key, JSON.stringify(summary)).run(); }
  catch { const current = await db(env).prepare('SELECT sha256 FROM diagnostic_chunks WHERE recording_id=? AND chunk_index=?').bind(row.id, index).first(); if (!current || !equal(current.sha256, expected.sha256.toLowerCase())) throw new Error('chunk conflict'); }
  return json({ index, sha256: expected.sha256.toLowerCase(), status: 'stored' }, 201);
}

async function finalize(env, row) {
  if (row.status === 'completed') return json(await publicStatus(env, row));
  const expected = JSON.parse(row.manifest).chunks;
  const result = await db(env).prepare('SELECT chunk_index,sha256 FROM diagnostic_chunks WHERE recording_id=? ORDER BY chunk_index').bind(row.id).all();
  if (result.results.length !== expected.length || result.results.some((x, i) => x.chunk_index !== i || !equal(x.sha256, expected[i].sha256.toLowerCase()))) return error('Missing chunks', 409);
  if (!await ensureRoadSnapshot(env, JSON.parse(row.manifest).roadDataVersion)) return error('Matching road data unavailable', 409);
  const now = Date.now();
  await db(env).prepare("UPDATE diagnostic_recordings SET status='completed',completed_at=?,expires_at=? WHERE id=? AND status='uploading'").bind(now, now + 30 * day, row.id).run();
  return json(await publicStatus(env, await record(env, row.id)));
}

function owner(request, env) {
  const allow = new Set((env.DIAGNOSTICS_ANALYST_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
  const email = (request.headers.get('oai-authenticated-user-email') || '').trim().toLowerCase();
  return allow.size > 0 && allow.has(email) && !!request.headers.get('oai-authenticated-user-id');
}

async function mcp(request, env) {
  let call;
  try { call = await parse(request, 16384); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  if (!call || typeof call !== 'object' || Array.isArray(call) || call.jsonrpc !== '2.0') return json({ jsonrpc: '2.0', id: call?.id ?? null, error: { code: -32600, message: 'Invalid request' } });
  const reply = result => json({ jsonrpc: '2.0', id: call.id ?? null, result });
  const toolError = (message) => reply({ isError: true, content: [{ type: 'text', text: message }] });
  const tool = (name, description, inputSchema, readOnly = true) => ({ name, description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly } });
  if (call.method === 'server/discover') return reply({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} } });
  if (call.method === 'initialize') return reply({ protocolVersion: '2026-07-28', capabilities: { tools: {} }, serverInfo: { name: 'delta-diagnostics', version: '1.0.0' } });
  if (call.method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (call.method === 'tools/list') return reply({ tools: [
    tool('diagnostics_health', 'Verify diagnostic storage, schema, static assets and upload readiness without reading recordings', { type: 'object', properties: {} }),
    tool('list_recordings', 'List completed diagnostic recordings', { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, before: { type: 'integer' } } }),
    tool('recording_summary', 'Read a completed recording manifest and paged event markers', { type: 'object', properties: { recordingId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['recordingId'] }),
    tool('recording_events', 'Read a bounded page of one event chunk', { type: 'object', properties: { recordingId: { type: 'string' }, index: { type: 'integer', minimum: 0 }, eventOffset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, required: ['recordingId', 'index'] }),
    tool('export_recording', 'Export a bounded base64 slice of one gzip chunk', { type: 'object', properties: { recordingId: { type: 'string' }, index: { type: 'integer', minimum: 0 }, byteOffset: { type: 'integer', minimum: 0 }, byteLength: { type: 'integer', minimum: 1, maximum: 65536 } }, required: ['recordingId', 'index'] }),
    tool('export_road_data', 'Export a bounded range of a matching road data file', { type: 'object', properties: { roadDataVersion: { type: 'string' }, file: { type: 'string', enum: roadFiles }, offset: { type: 'integer', minimum: 0 } }, required: ['roadDataVersion', 'file', 'offset'] }),
    tool('cleanup_expired', 'Delete expired recordings and orphan chunks; repeat with returned cursors until null', { type: 'object', properties: { diagnosticsCursor: { type: 'string' }, roadCursor: { type: 'string' } } }, false)
  ] });
  if (call.method !== 'tools/call') return json({ jsonrpc: '2.0', id: call.id ?? null, error: { code: -32601, message: 'Method not found' } });
  if (!analysisConfigured(env) || !owner(request, env)) return json({ jsonrpc: '2.0', id: call.id ?? null, error: { code: -32001, message: 'Unauthorized' } }, 401);
  const name = call.params?.name, args = call.params?.arguments || {};
  const content = value => reply({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  if (name === 'diagnostics_health') {
    const tables = await db(env).prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('diagnostic_recordings','diagnostic_chunks','diagnostic_auth_failures')").all();
    const asset = env.ASSETS ? await env.ASSETS.fetch(new Request('https://assets.internal/')) : null;
    return content({ schemaReady: tables.results.length === 3, assetsReady: asset?.status === 200,
      uploadsConfigured: !!configured(env), retentionReady: env.DIAGNOSTICS_RETENTION_READY === 'true',
      roadDataVersion: env.ROAD_DATA_VERSION || null });
  }
  if (name === 'cleanup_expired') return content(await cleanupDiagnostics(env, args));
  if (name === 'export_road_data') {
    if (!/^[0-9a-f]{64}$/i.test(args.roadDataVersion || '') || !roadFiles.includes(args.file) || !Number.isSafeInteger(args.offset) || args.offset < 0) return toolError('Invalid range');
    const linked = await db(env).prepare("SELECT id FROM diagnostic_recordings WHERE status='completed' AND expires_at>? AND json_extract(manifest, '$.roadDataVersion')=? LIMIT 1").bind(Date.now(), args.roadDataVersion).first();
    if (!linked) return toolError('Road data unavailable');
    const key = roadObjectKey(args.roadDataVersion, args.file);
    const head = await bucket(env).head(key);
    if (!head || args.offset >= head.size) return toolError('Range unavailable');
    const length = Math.min(65536, head.size - args.offset);
    const object = await bucket(env).get(key, { range: { offset: args.offset, length } });
    const bytes = new Uint8Array(await object.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return content({ roadDataVersion: args.roadDataVersion, file: args.file, offset: args.offset, totalBytes: head.size, data: btoa(binary), nextOffset: args.offset + bytes.length < head.size ? args.offset + bytes.length : null });
  }
  if (name === 'list_recordings') {
    const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
    const before = Number.isSafeInteger(args.before) ? args.before : Date.now() + 1;
    const rows = await db(env).prepare("SELECT id,created_at,completed_at,expires_at,manifest FROM diagnostic_recordings WHERE status='completed' AND expires_at>? AND completed_at<? ORDER BY completed_at DESC LIMIT ?").bind(Date.now(), before, limit).all();
    return content(rows.results.map(x => ({ recordingId: x.id, completedAt: new Date(x.completed_at).toISOString(), expiresAt: new Date(x.expires_at).toISOString(), issue: JSON.parse(x.manifest).issue })));
  }
  if (!/^[0-9a-f-]{36}$/i.test(args.recordingId || '')) return toolError('Invalid recording ID');
  const row = await record(env, args.recordingId);
  if (!row || row.status !== 'completed' || row.expires_at <= Date.now()) return toolError('Recording unavailable');
  const manifest = JSON.parse(row.manifest);
  const { chunks: chunkMetadata, ...manifestBase } = manifest;
  if (name === 'recording_summary') { const offset = Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0; const chunks = await db(env).prepare('SELECT chunk_index,event_summary FROM diagnostic_chunks WHERE recording_id=? AND chunk_index>=? ORDER BY chunk_index LIMIT 10').bind(row.id, offset).all(); return content({ manifestBase, chunkCount: chunkMetadata.length, chunkMetadata: chunkMetadata.slice(offset, offset + 10), completedAt: new Date(row.completed_at).toISOString(), summaries: chunks.results.map(x => ({ index: x.chunk_index, ...JSON.parse(x.event_summary || '{}') })), nextOffset: offset + 10 < chunkMetadata.length ? offset + 10 : null }); }
  if ((name === 'recording_events' || name === 'export_recording') && Number.isInteger(args.index) && args.index >= 0 && args.index < manifest.chunks.length) {
    const object = await bucket(env).get(objectKey(row.id, args.index));
    if (!object) return toolError('Chunk unavailable');
    const compressed = new Uint8Array(await object.arrayBuffer());
    if (!equal(await sha256(compressed), manifest.chunks[args.index].sha256.toLowerCase())) return toolError('Chunk corrupted');
    if (name === 'export_recording') {
      const offset = args.byteOffset === undefined ? 0 : args.byteOffset;
      const requested = args.byteLength === undefined ? 65536 : args.byteLength;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= compressed.length ||
          !Number.isSafeInteger(requested) || requested < 1 || requested > 65536) return toolError('Invalid byte range');
      const slice = compressed.subarray(offset, Math.min(compressed.length, offset + requested));
      let binary = '';
      for (let i = 0; i < slice.length; i += 8192) binary += String.fromCharCode(...slice.subarray(i, i + 8192));
      const nextByteOffset = offset + slice.length < compressed.length ? offset + slice.length : null;
      return content({ manifestBase, chunkCount: chunkMetadata.length, chunkMetadata: chunkMetadata[args.index], index: args.index, byteOffset: offset, data: btoa(binary), nextByteOffset, nextIndex: nextByteOffset === null && args.index + 1 < chunkMetadata.length ? args.index + 1 : null });
    }
    const offset = args.eventOffset === undefined ? 0 : args.eventOffset;
    const limit = args.limit === undefined ? 100 : args.limit;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= manifest.chunks[args.index].eventCount ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 200) return toolError('Invalid event range');
    let page;
    try { page = await readEventPage(compressed, manifest.chunks[args.index], chunkMetadata.slice(0, args.index).reduce((n, c) => n + c.eventCount, 0), offset, limit); }
    catch { return toolError('Chunk corrupted'); }
    return content({ recordingId: row.id, index: args.index, eventOffset: offset, ...page,
      nextIndex: page.nextEventOffset === null && args.index + 1 < manifest.chunks.length ? args.index + 1 : null });
  }
  return toolError('Unknown tool or invalid arguments');
}

export async function cleanupDiagnostics(env, cursors = {}) {
  if (!db(env) || !bucket(env)) return { deleted: 0 };
  const rows = await db(env).prepare('SELECT id FROM diagnostic_recordings WHERE expires_at<=? LIMIT 100').bind(Date.now()).all();
  for (const row of rows.results) {
    const chunks = await db(env).prepare('SELECT object_key FROM diagnostic_chunks WHERE recording_id=?').bind(row.id).all();
    for (const chunk of chunks.results) await bucket(env).delete(chunk.object_key);
    await db(env).prepare('DELETE FROM diagnostic_chunks WHERE recording_id=?').bind(row.id).run();
    await db(env).prepare('DELETE FROM diagnostic_recordings WHERE id=?').bind(row.id).run();
  }
  let orphanObjects = 0, diagnosticsCursor = null, roadCursor = null;
  if (bucket(env).list) {
    const listing = await bucket(env).list({ prefix: 'diagnostics/', limit: 100, cursor: cursors.diagnosticsCursor });
    diagnosticsCursor = listing?.truncated ? listing.cursor : null;
    for (const object of listing.objects || []) {
      if (object.uploaded && Date.now() - new Date(object.uploaded).getTime() < hour) continue;
      const linked = await db(env).prepare('SELECT recording_id FROM diagnostic_chunks WHERE object_key=? LIMIT 1').bind(object.key).first();
      if (!linked) { await bucket(env).delete(object.key); orphanObjects++; }
    }
    const roads = await bucket(env).list({ prefix: 'road-data/', limit: 100, cursor: cursors.roadCursor });
    roadCursor = roads?.truncated ? roads.cursor : null;
    for (const object of roads.objects || []) {
      const version = /^road-data\/([0-9a-f]{64})\//i.exec(object.key)?.[1];
      if (!version || (object.uploaded && Date.now() - new Date(object.uploaded).getTime() < hour)) continue;
      const linked = await db(env).prepare("SELECT id FROM diagnostic_recordings WHERE expires_at>? AND json_extract(manifest, '$.roadDataVersion')=? LIMIT 1").bind(Date.now(), version).first();
      if (!linked) { await bucket(env).delete(object.key); orphanObjects++; }
    }
  }
  await db(env).prepare('DELETE FROM diagnostic_auth_failures WHERE attempted_at<?').bind(Date.now() - 15 * 60000).run();
  return { deleted: rows.results.length, orphanObjects, more: rows.results.length === 100, diagnosticsCursor, roadCursor };
}

export async function handleDiagnostics(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/mcp' && request.method === 'POST') return mcp(request, env);
  if (!path.startsWith('/api/diagnostics')) return null;
  if (!configured(env)) return error('Diagnostics unavailable', 503);
  if (!sameOrigin(request)) return error('Same-origin request required', 403);
  if (path === '/api/diagnostics/auth' && request.method === 'POST') return auth(request, env);
  const sessionValue = await session(request, env);
  if (!sessionValue) return error('Unauthorized', 401);
  if (path === '/api/diagnostics/recordings' && request.method === 'POST') return create(request, env, sessionValue);
  const match = /^\/api\/diagnostics\/recordings\/([0-9a-f-]{36})(?:\/(status|finalize|chunks\/([0-9]+)))?$/.exec(path);
  if (!match) return error('Not found', 404);
  const row = await authorizedRecord(env, match[1], uploadToken(request));
  if (!row) return error('Recording unavailable', 404);
  if (match[2] === 'status' && request.method === 'GET') return json(await publicStatus(env, row));
  if (match[2] === 'finalize' && request.method === 'POST') return finalize(env, row);
  if (match[3] !== undefined && request.method === 'PUT') return upload(request, env, row, Number(match[3]));
  return error('Not found', 404);
}
