// Release/package integrity checks. No browser dependency required.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const index = read('index.html');
const app = read('app.js');
const solver = read('solver-worker.js');
const sw = read('sw.js');
const manifestText = read('manifest.webmanifest');
const manifest = JSON.parse(manifestText);

for (const name of ['index.html','app.js','solver-worker.js','sw.js','manifest.webmanifest','ogp-card.png','.nojekyll']) {
  assert.ok(fs.existsSync(path.join(root, name)), `release file missing: ${name}`);
}

// Generic-name migration must stay complete in all user-visible runtime strings.
for (const [name, text] of [['index.html',index],['app.js',app],['solver-worker.js',solver],['manifest.webmanifest',manifestText]]) {
  assert.ok(!text.includes('ミュウツー'), `stale user-visible ミュウツー label in ${name}`);
}
assert.equal(manifest.name, '伝説サブレ最適化ツール', 'manifest app name regression');
assert.equal(manifest.short_name, '伝説サブレOpt', 'manifest short name regression');
assert.match(index, /<title>伝説サブレ最適化ツール<\/title>/, 'HTML title regression');

// Every cache-busting token in runtime text must be identical, preventing a mixed release.
const runtimeText = [index, app, sw, manifestText].join('\n');
const tokens = [...runtimeText.matchAll(/\?v=([A-Za-z0-9_-]+)/g)].map(m => m[1]);
assert.ok(tokens.length > 0, 'release must contain versioned asset URLs');
assert.equal(new Set(tokens).size, 1, `mixed cache-busting tokens: ${[...new Set(tokens)].join(', ')}`);

// Manifest icon URLs must resolve to packaged files.
for (const icon of manifest.icons || []) {
  const rel = String(icon.src || '').replace(/^\.\//,'').split(/[?#]/)[0];
  assert.ok(rel, 'manifest icon src must not be empty');
  assert.ok(fs.existsSync(path.join(root, rel)), `manifest icon target missing: ${icon.src}`);
}
assert.ok((manifest.icons || []).some(x => String(x.purpose).split(/\s+/).includes('maskable') && x.sizes === '192x192'), '192 maskable icon missing');
assert.ok((manifest.icons || []).some(x => String(x.purpose).split(/\s+/).includes('maskable') && x.sizes === '512x512'), '512 maskable icon missing');

// Every service-worker app-shell URL must resolve inside the release package.
const shellMatch = sw.match(/const APP_SHELL\s*=\s*\[([\s\S]*?)\];/);
assert.ok(shellMatch, 'APP_SHELL declaration missing');
const shellUrls = [...shellMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
assert.ok(shellUrls.length > 0, 'APP_SHELL must not be empty');
for (const url of shellUrls) {
  const clean = url.replace(/^\.\//,'').split(/[?#]/)[0];
  const rel = clean === '' ? 'index.html' : clean;
  assert.ok(fs.existsSync(path.join(root, rel)), `APP_SHELL target missing: ${url}`);
}

// Detect broken or duplicated DOM IDs and ensure app.js-referenced IDs exist.
const ids = [...index.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const idSet = new Set(ids);
assert.equal(idSet.size, ids.length, 'duplicate DOM id found');
const referenced = new Set();
const elsBlock = app.match(/Object\.fromEntries\(\[([\s\S]*?)\]\.map\(id=>\[id,\$\(id\)\]\)\)/);
assert.ok(elsBlock, 'app element registry could not be parsed');
for (const m of elsBlock[1].matchAll(/['"]([^'"]+)['"]/g)) referenced.add(m[1]);
for (const m of app.matchAll(/document\.getElementById\(['"]([^'"]+)['"]\)/g)) referenced.add(m[1]);
for (const id of referenced) assert.ok(idSet.has(id), `app.js references missing DOM id: ${id}`);

console.log('OK: release integrity regression checks passed');
