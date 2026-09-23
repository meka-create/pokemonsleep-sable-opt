// Run with: node tests/storage-migration-regression.mjs
// This executes the exact storage bootstrap code from ../app.js in a VM with fake localStorage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.resolve(here, '../app.js');
const appCode = fs.readFileSync(appPath, 'utf8');
const marker = '    const $ = (id) => document.getElementById(id);';
const markerIndex = appCode.indexOf(marker);
assert.ok(markerIndex > 0, 'app.js storage bootstrap marker not found');

// Only execute the production storage/bootstrap portion. No DOM is required before this marker.
const bootstrapCode = `${appCode.slice(0, markerIndex)}\n` +
  `globalThis.__storageTest = { storedState, state, STORAGE_KEY, STORAGE_SCHEMA };\n` +
  `})();\n`;

class FakeStorage {
  constructor(initial={}) {
    this.map = new Map(Object.entries(initial).map(([k,v]) => [k, String(v)]));
  }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
  key(index) { return Array.from(this.map.keys())[index] ?? null; }
  get length() { return this.map.size; }
  snapshot() { return Object.fromEntries(this.map.entries()); }
}

const j = (value) => JSON.stringify(value);

function runBootstrap(initial) {
  const localStorage = new FakeStorage(initial);
  const sandbox = { localStorage, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bootstrapCode, sandbox, { filename: appPath });
  assert.ok(sandbox.__storageTest, 'storage bootstrap must expose test state');
  return { ...sandbox.__storageTest, localStorage };
}

function assertState(actual, expected, message) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
}

let checks = 0;

// 1) Existing users on the legacy multi-key format must retain all material progress/settings.
{
  const history = [{ gauge: 11, fedCount: 1, action: 's3' }];
  const legacy = {
    mewtwo_inventory: j({ s6:7, s5:4, s4:1, s3:12, s1:'∞', encounters:5 }),
    mewtwo_gauge: j(17),
    mewtwo_isChance: j(true),
    mewtwo_fedCount: j(1),
    mewtwo_guaranteedCount: j(3),
    mewtwo_isFull: j(false),
    mewtwo_history: j(history),
    mewtwo_bonusUsedThisEncounter: j(true),
    mewtwo_isPremium: j(false),
    mewtwo_futureGuaranteeDetailEnabled: j(true),
    mewtwo_futureGuarantees: j([2,3,2,3])
  };
  const { storedState, state, localStorage } = runBootstrap(legacy);
  const expected = {
    schemaVersion:3,
    inventory:{ s6:7, s5:4, s4:1, s3:12, s1:'∞', encounters:5 },
    gauge:17,
    isChance:true,
    fedCount:1,
    guaranteedCount:3,
    isFull:false,
    history,
    bonusUsedThisEncounter:true,
    isPremium:false,
    detailEnabled:true,
    futureGuarantees:[2,3,2,3]
  };
  assertState(storedState, expected, 'legacy -> v3 stored state must preserve user data');
  assertState({
    inventory:state.inventory, gauge:state.gauge, isChance:state.isChance, fedCount:state.fedCount,
    guaranteedCount:state.guaranteedCount, isFull:state.isFull, history:state.history,
    bonusUsedThisEncounter:state.bonusUsedThisEncounter, isPremium:state.isPremium,
    detailEnabled:state.detailEnabled, futureGuarantees:state.futureGuarantees
  }, {
    inventory:expected.inventory, gauge:17, isChance:true, fedCount:1, guaranteedCount:3,
    isFull:false, history, bonusUsedThisEncounter:true, isPremium:false,
    detailEnabled:true, futureGuarantees:[2,3,2,3]
  }, 'runtime state must match migrated legacy values');
  assertState(JSON.parse(localStorage.getItem('mewtwo_state_v3')), expected, 'v3 snapshot must be persisted');
  for (const key of Object.keys(legacy)) assert.notEqual(localStorage.getItem(key), null, `legacy key must not be deleted: ${key}`);
  checks++;
}

// 2) The 2-guarantee invariant must normalize an old saved bonus biscuit to zero, without resetting anything else.
{
  const legacy = {
    mewtwo_inventory: j({ s6:3, s5:8, s4:1, s3:4, s1:9, encounters:3 }),
    mewtwo_gauge: j(23),
    mewtwo_isChance: j(false),
    mewtwo_fedCount: j(1),
    mewtwo_guaranteedCount: j(2),
    mewtwo_isFull: j(false),
    mewtwo_history: j([]),
    mewtwo_bonusUsedThisEncounter: j(false),
    mewtwo_isPremium: j(true),
    mewtwo_futureGuaranteeDetailEnabled: j(true),
    mewtwo_futureGuarantees: j([3,2])
  };
  const { storedState, state } = runBootstrap(legacy);
  assert.equal(storedState.inventory.s4, 0, '2-guarantee migration must force bonus to zero');
  assert.equal(state.inventory.s4, 0, '2-guarantee runtime must force bonus to zero');
  assert.equal(state.gauge, 23, 'gauge must survive 2-guarantee normalization');
  assert.equal(state.inventory.s6, 3, 's6 must survive 2-guarantee normalization');
  assert.equal(state.inventory.s5, 8, 's5 must survive 2-guarantee normalization');
  assert.equal(state.inventory.s3, 4, 's3 must survive 2-guarantee normalization');
  assert.equal(state.inventory.s1, 9, 's1 must survive 2-guarantee normalization');
  assert.equal(state.inventory.encounters, 3, 'encounters must survive 2-guarantee normalization');
  assert.deepEqual(Array.from(state.futureGuarantees), [3,2], 'future schedule must survive 2-guarantee normalization');
  checks++;
}

// 3) Once v3 exists, it is authoritative; stale legacy keys must not overwrite newer user data.
{
  const v3 = {
    schemaVersion:3,
    inventory:{ s6:9, s5:2, s4:1, s3:'∞', s1:6, encounters:4 },
    gauge:14,
    isChance:false,
    fedCount:2,
    guaranteedCount:3,
    isFull:false,
    history:[{ gauge:5 }],
    bonusUsedThisEncounter:false,
    isPremium:true,
    detailEnabled:true,
    futureGuarantees:[2,3,3]
  };
  const { storedState, state } = runBootstrap({
    mewtwo_state_v3:j(v3),
    mewtwo_inventory:j({ s6:0, s5:0, s4:0, s3:0, s1:0, encounters:1 }),
    mewtwo_gauge:j(0),
    mewtwo_guaranteedCount:j(2)
  });
  assertState(storedState, v3, 'existing v3 must win over stale legacy data');
  assert.equal(state.gauge, 14, 'runtime must use v3 gauge');
  assert.equal(state.inventory.s6, 9, 'runtime must use v3 inventory');
  checks++;
}

// 4) A malformed v3 blob must fail safely back to the existing legacy data rather than defaults.
{
  const { storedState } = runBootstrap({
    mewtwo_state_v3:'{broken-json',
    mewtwo_inventory:j({ s6:4, s5:6, s4:1, s3:8, s1:'∞', encounters:6 }),
    mewtwo_gauge:j(19),
    mewtwo_guaranteedCount:j(3),
    mewtwo_isPremium:j(false)
  });
  assert.equal(storedState.gauge, 19, 'malformed v3 must recover legacy gauge');
  assert.equal(storedState.inventory.s6, 4, 'malformed v3 must recover legacy inventory');
  assert.equal(storedState.inventory.encounters, 6, 'malformed v3 must recover legacy encounter count');
  assert.equal(storedState.isPremium, false, 'malformed v3 must recover legacy settings');
  checks++;
}

// 5) Migration is idempotent: loading the just-written v3 state again must not mutate user data.
{
  const first = runBootstrap({
    mewtwo_inventory:j({ s6:5, s5:7, s4:1, s3:11, s1:'∞', encounters:4 }),
    mewtwo_gauge:j(12),
    mewtwo_isChance:j(true),
    mewtwo_fedCount:j(0),
    mewtwo_guaranteedCount:j(3),
    mewtwo_isPremium:j(true),
    mewtwo_futureGuaranteeDetailEnabled:j(true),
    mewtwo_futureGuarantees:j([3,2,3])
  });
  const firstV3 = JSON.parse(first.localStorage.getItem('mewtwo_state_v3'));
  const second = runBootstrap({ mewtwo_state_v3:j(firstV3) });
  const secondV3 = JSON.parse(second.localStorage.getItem('mewtwo_state_v3'));
  assertState(secondV3, firstV3, 'v3 re-load must be idempotent');
  checks++;
}

console.log(`OK: ${checks} storage migration regression checks passed`);
