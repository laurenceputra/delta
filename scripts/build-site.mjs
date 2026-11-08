import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'dist');
for (const name of ['client', 'server']) {
  rmSync(resolve(target, name), { recursive: true, force: true });
  mkdirSync(resolve(target, name), { recursive: true });
}
for (const entry of readdirSync(target, { withFileTypes: true })) {
  if (['client', 'server', '.openai'].includes(entry.name) || entry.name.endsWith('.test.mjs')) continue;
  cpSync(resolve(target, entry.name), resolve(target, 'client', entry.name), { recursive: true });
}
await build({ entryPoints: [resolve(root, 'worker/index.js')], outfile: resolve(target, 'server/index.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: false });
const hosting = JSON.parse(readFileSync(resolve(root, '.openai/hosting.json'), 'utf8'));
const wrangler = { name: 'delta-sg', main: 'index.js', compatibility_date: '2026-05-22',
  assets: { directory: '../client', binding: 'ASSETS', run_worker_first: true },
  d1_databases: [{ binding: hosting.d1, database_name: 'delta-diagnostics',
    database_id: '00000000-0000-0000-0000-000000000001', migrations_dir: '../../drizzle' }],
  r2_buckets: [{ binding: hosting.r2, bucket_name: 'delta-diagnostics' }] };
writeFileSync(resolve(target, 'server/wrangler.json'), JSON.stringify(wrangler, null, 2) + '\n');
mkdirSync(resolve(target, '.openai'), { recursive: true });
cpSync(resolve(root, '.openai/hosting.json'), resolve(target, '.openai/hosting.json'));
console.log('Built Delta Worker and static assets.');
