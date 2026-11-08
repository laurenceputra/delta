export const FORMAT_VERSION = 1;
export const MAX_CHUNK_EXPANDED_BYTES = 256 * 1024;
export const MAX_COMPRESSED_BYTES = 10 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
export const MAX_CHUNKS = 2048;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hex = /^[0-9a-f]{64}$/i;
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = (x, max) => typeof x === 'string' && x.length > 0 && x.length <= max;
const timestamp = x => text(x, 40) && Number.isFinite(Date.parse(x));
const integer = x => Number.isSafeInteger(x) && x >= 0;

export function validateEvent(event) {
  if (!plain(event) || !['fix', 'error', 'state', 'signal', 'visibility', 'session'].includes(event.type) || !timestamp(event.recordedAt) || !integer(event.seq)) return false;
  if (event.type === 'fix' && !plain(event.fix)) return false;
  return true;
}

export function validateManifest(manifest) {
  if (!plain(manifest) || !uuid.test(manifest.recordingId || '') || manifest.formatVersion !== FORMAT_VERSION ||
      !text(manifest.appVersion, 80) || !text(manifest.buildId, 120) || !text(manifest.roadDataVersion, 120) ||
      !plain(manifest.configuration) || JSON.stringify(manifest.configuration).length > 8192 ||
      !timestamp(manifest.startedAt) || !timestamp(manifest.endedAt) ||
      Date.parse(manifest.endedAt) < Date.parse(manifest.startedAt) ||
      Date.parse(manifest.endedAt) - Date.parse(manifest.startedAt) > 2 * 60 * 60 * 1000 ||
      typeof manifest.issue !== 'string' || manifest.issue.length > 4000 || !integer(manifest.eventCount) ||
      !Array.isArray(manifest.chunks) || manifest.chunks.length < 1 || manifest.chunks.length > MAX_CHUNKS) return false;
  let compressed = 0, expanded = 0, events = 0;
  for (const [index, chunk] of manifest.chunks.entries()) {
    if (!plain(chunk) || chunk.index !== index || !hex.test(chunk.sha256 || '') ||
        !integer(chunk.compressedBytes) || chunk.compressedBytes < 1 ||
        !integer(chunk.expandedBytes) || chunk.expandedBytes < 1 || chunk.expandedBytes > MAX_CHUNK_EXPANDED_BYTES ||
        !integer(chunk.eventCount) || chunk.eventCount < 1) return false;
    compressed += chunk.compressedBytes; expanded += chunk.expandedBytes; events += chunk.eventCount;
  }
  return compressed <= MAX_COMPRESSED_BYTES && expanded <= MAX_EXPANDED_BYTES && events === manifest.eventCount;
}
