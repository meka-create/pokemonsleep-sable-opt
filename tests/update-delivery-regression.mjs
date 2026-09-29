// Verifies cache-busting and HTTP-cache bypass rules used for reliable GitHub Pages updates.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

const tokenMatch = index.match(/app\.js\?v=([A-Za-z0-9_-]+)/);
assert.ok(tokenMatch, 'index.html must version app.js');
const token = tokenMatch[1];

assert.match(index, new RegExp(`manifest\\.webmanifest\\?v=${token}`), 'manifest must use the same version token');
assert.match(app, new RegExp(`solver-worker\\.js\\?v=${token}`), 'worker must use the same version token');
assert.match(app, new RegExp(`sw\\.js\\?v=${token}`), 'service worker registration must use the same version token');
assert.match(app, /updateViaCache:\s*'none'/, 'service worker script must bypass the browser update cache');
assert.match(sw, new RegExp(`app\\.js\\?v=${token}`), 'precache must contain versioned app.js');
assert.match(sw, new RegExp(`solver-worker\\.js\\?v=${token}`), 'precache must contain versioned solver worker');
assert.match(sw, new RegExp(`manifest\\.webmanifest\\?v=${token}`), 'precache must contain versioned manifest');
assert.match(sw, /fetch\(url,\s*\{\s*cache:\s*'no-store'\s*\}\)/, 'install precache must bypass HTTP cache');
assert.match(sw, /fetch\(request,\s*\{\s*cache:\s*'no-store'\s*\}\)/, 'runtime network-first fetch must bypass HTTP cache');
assert.match(sw, /skipWaiting\(\)/, 'new service worker must activate without waiting for all tabs to close');
assert.match(sw, /clients\.claim\(\)/, 'new service worker must claim pages after activation');

console.log('OK: update-delivery regression checks passed');
