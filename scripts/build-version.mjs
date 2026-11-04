import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('package.json version must be semver');
const template = readFileSync(resolve(root, 'scripts/sw.template.js'), 'utf8');
const runtimeAssets = ['dist/index.html', 'dist/styles.css', 'dist/app.js', 'dist/engine.js', 'dist/data/roads.json', 'dist/data/local-roads.json.gz', 'dist/data/local-roads.json', 'dist/manifest.webmanifest', 'dist/icons/icon-192.png', 'dist/icons/icon-512.png'];
const digest = createHash('sha256').update(version).update(template);
for (const name of runtimeAssets) digest.update(name).update(readFileSync(resolve(root, name)));
const buildId = digest.digest('hex').slice(0, 12);
const outputs = {
  'dist/version.js': `// Generated from package.json. Run npm run build:version after bumping the version.\nexport const APP_VERSION = '${version}';\nexport const BUILD_ID = '${buildId}';\n`,
  'dist/version.json': `${JSON.stringify({version, buildId}, null, 2)}\n`,
  'dist/sw.js': template.replaceAll('__APP_VERSION__', version).replaceAll('__BUILD_ID__', buildId),
};
const check = process.argv.includes('--check');
for (const [name, content] of Object.entries(outputs)) {
  const path = resolve(root, name);
  if (check) {
    if (readFileSync(path, 'utf8') !== content) throw new Error(`${name} is stale; run npm run build:version`);
  } else writeFileSync(path, content);
}
