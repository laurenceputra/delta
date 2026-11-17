import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { makeUploadGroups, materializeGroup, uploadManifest, fetchBounded } from './upload.js';

const hash = value => createHash('sha256').update(value).digest('hex');
test('211 local chunks can pack into one resumable upload group', async () => {
  const chunks = [], data = new Map();
  for (let index = 0; index < 211; index++) {
    const plain = Buffer.from(JSON.stringify({ type: 'fix', seq: index, recordedAt: '2026-11-17T00:00:00.000Z', fix: { latitude: 1.2, longitude: 103.8 }, padding: 'x'.repeat(20000) }) + '\n');
    const zipped = gzipSync(plain);
    chunks.push({ index, sha256: hash(zipped), compressedBytes: zipped.length, expandedBytes: plain.length, eventCount: 1 });
    data.set(index, zipped);
  }
  const groups = await makeUploadGroups(chunks, async index => data.get(index));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].eventCount, 211);
  const packed = await materializeGroup(groups[0], chunks, async index => data.get(index));
  assert.equal(hash(packed), groups[0].sha256);
  const manifest = uploadManifest({ id: 'local', formatVersion: 1, appVersion: 'test', buildId: 'test', roadDataVersion: 'a'.repeat(64), configuration: {}, startedAt: '2026-11-17T00:00:00.000Z', endedAt: '2026-11-17T00:01:00.000Z', eventCount: 211 }, { id: 'server', issue: '', groups });
  assert.equal(manifest.recordingId, 'server');
  assert.equal(manifest.chunks.length, 1);
  assert.equal(manifest.chunks[0].sha256, hash(packed));
});

test('incompressible chunks split at local boundaries below 1 MiB', async () => {
  const chunks=[],data=new Map();
  for(let index=0;index<4;index++){const plain=randomBytes(600000),zipped=gzipSync(plain);chunks.push({index,sha256:hash(zipped),compressedBytes:zipped.length,expandedBytes:plain.length,eventCount:1});data.set(index,zipped);}
  const groups=await makeUploadGroups(chunks,async index=>data.get(index));
  assert.equal(groups.length,4);
  assert.ok(groups.every(group=>group.compressedBytes<=1024*1024));
  for(const group of groups)assert.equal(hash(await materializeGroup(group,chunks,async index=>data.get(index))),group.sha256);
});

test('validation responses stop immediately and transient 500 retries', async () => {
  const original=globalThis.fetch;
  try{
    for(const status of [401,422]){let calls=0;globalThis.fetch=async()=>{calls++;return new Response('{}',{status});};await assert.rejects(fetchBounded('/test'),/Upload rejected/);assert.equal(calls,1);}
    let calls=0;globalThis.fetch=async()=>new Response('{}',{status:++calls<3?500:200});
    assert.deepEqual(await fetchBounded('/test'),{});assert.equal(calls,3);
  }finally{globalThis.fetch=original;}
});

test('429 retry-after above 60 seconds stops without retry', async () => {
  const original=globalThis.fetch;let calls=0;
  try{globalThis.fetch=async()=>{calls++;return new Response('{}',{status:429,headers:{'Retry-After':'61'}});};await assert.rejects(fetchBounded('/test'),/retry later/);assert.equal(calls,1);}finally{globalThis.fetch=original;}
});

test('hung response body is aborted for each of three bounded attempts', async () => {
  const originalFetch=globalThis.fetch,originalTimeout=globalThis.setTimeout;let calls=0,aborts=0;
  try{
    globalThis.setTimeout=(callback,ms,...args)=>originalTimeout(callback,ms===30000?1:0,...args);
    globalThis.fetch=async(_url,{signal})=>{calls++;return {ok:true,status:200,arrayBuffer:()=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>{aborts++;reject(new DOMException('Aborted','AbortError'));},{once:true});})};};
    await assert.rejects(fetchBounded('/test'),/Upload interrupted/);
    assert.equal(calls,3);assert.equal(aborts,3);
  }finally{globalThis.fetch=originalFetch;globalThis.setTimeout=originalTimeout;}
});
