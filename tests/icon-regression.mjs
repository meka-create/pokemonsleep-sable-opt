// Verifies the PWA icon set, including Android/Pixel maskable icons.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

const tokenMatch = index.match(/app\.js\?v=([A-Za-z0-9_-]+)/);
assert.ok(tokenMatch, 'index.html must version app.js');
const token = tokenMatch[1];

const readPngSize = (file) => {
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString('ascii', 1, 4), 'PNG', `${file} must be PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};

// Exact hashes of the user-supplied icon set. This prevents future releases from
// silently regenerating, recompressing, or replacing the approved artwork.
const expected = [
  ['icon-192.png', 192, 'any', '08240a3bef56571878b1b6e6c2b2e0818a974175b32eb0868e3d794b68a22713'],
  ['icon-512.png', 512, 'any', '0267781092fc4802d602bfd367b44afa2c141e7eff79e675b8f5efdc977ce960'],
  ['icon-maskable-192.png', 192, 'maskable', '72b351c7e38fa34ebe7ac9b2ee48b1963e0023fb38a7811819b12d8812d64df8'],
  ['icon-maskable-512.png', 512, 'maskable', '46553ab695d0668271b6132bfa7d1cc54de4d906cd284f24cc1a41a987caf5e2'],
  ['apple-touch-icon.png', 180, 'any', '7b4e2135c2f281391dcb6df05a3704379ff551e5e0172a3b6d4e31feb6ff05aa']
];

for (const [name, size, purpose, sha256] of expected) {
  const entry = manifest.icons.find((x) => x.src === `./icons/${name}?v=${token}`);
  assert.ok(entry, `manifest entry missing: ${name}`);
  assert.equal(entry.sizes, `${size}x${size}`, `manifest size mismatch: ${name}`);
  assert.equal(entry.type, 'image/png', `manifest type mismatch: ${name}`);
  assert.equal(entry.purpose, purpose, `manifest purpose mismatch: ${name}`);
  const file = path.join(root, 'icons', name);
  const actual = readPngSize(file);
  assert.deepEqual(actual, { width:size, height:size }, `PNG dimensions mismatch: ${name}`);
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(actualHash, sha256, `approved icon bytes changed: ${name}`);
  assert.match(sw, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + `\\?v=${token}`), `service worker precache missing: ${name}`);
}

const favFile = path.join(root, 'icons', 'favicon-32.png');
const fav = readPngSize(favFile);
assert.deepEqual(fav, { width:32, height:32 }, 'favicon dimensions mismatch');
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(favFile)).digest('hex'), '0e6faa1f8e8cb7ccc1306b50ab58d453386b1bc274160b85cbbf2160a3d42dff', 'approved favicon bytes changed');
assert.match(sw, new RegExp(`favicon-32\\.png\\?v=${token}`), 'service worker precache missing: favicon');
assert.match(index, new RegExp(`favicon-32\\.png\\?v=${token}`), 'favicon must be cache-busted');
assert.match(index, new RegExp(`icon-192\\.png\\?v=${token}`), 'HTML icon must be cache-busted');
assert.match(index, new RegExp(`apple-touch-icon\\.png\\?v=${token}`), 'apple touch icon must be cache-busted');

console.log('OK: icon regression checks passed');
