// Run with: node tests/solver-regression.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(here, '../solver-worker.js');
const code = fs.readFileSync(workerPath, 'utf8');
let response = null;
const sandbox = { performance, console, self: { postMessage(message) { response = message; } } };
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: workerPath });

function solve(payload) {
  response = null;
  sandbox.self.onmessage({ data: payload });
  assert.ok(response, 'solver must respond');
  assert.notEqual(response.type, 'error', response.message || 'solver error');
  return response.result;
}

const baseInv = (overrides={}) => ({ s6:6, s5:10, s4:1, s3:'∞', s1:'∞', ...overrides });
const request = ({ premium=true, guaranteedCount=3, detailEnabled=false, futureGuarantees=[], gauge=0, fedCount=0, chance=false, encounters=1, inventory=baseInv(), encounterEnded=false }) => ({
  type:'solve', requestId:1, premium, guaranteedCount, detailEnabled, futureGuarantees,
  state:{ gauge, fedCount, chance, encounters, inventory, encounterEnded }
});
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 1e-12, `${message}: ${actual} != ${expected}`);

const cases = [
  {
    name:'7 encounters / premium baseline',
    input:request({ encounters:7 }),
    expected:{ ev:4.256326229324175, catchProb:0.38814543999999995, action:'s5', route:['ハイパー(5)','ハイパー(5)','ハイパー(5)','ハイパー(5)','ボーナス+(4)','ミュウツー(6)'] }
  },
  {
    name:'final encounter prioritizes current catch rate',
    input:request({ encounters:1, inventory:baseInv({s6:3,s5:0}) }),
    expected:{ ev:0.4199889376, catchProb:0.4199889376, action:'s6' }
  },
  {
    name:'chance remaining 3 -> poke',
    input:request({ encounters:3, gauge:27, chance:true }),
    expected:{ ev:2.2865940267947904, catchProb:1, action:'s1', route:['ポケ(1)'] }
  },
  {
    name:'chance remaining 9 -> super',
    input:request({ encounters:3, gauge:21, chance:true }),
    expected:{ ev:2.2865940267947904, catchProb:1, action:'s3', route:['スーパー(3)'] }
  },
  {
    name:'chance remaining 15 final -> hyper one throw',
    input:request({ encounters:1, gauge:15, chance:true }),
    expected:{ ev:1, catchProb:1, action:'s5', route:['ハイパー(5)'] }
  },
  {
    name:'two-guarantee remaining 12 -> 6 + 6',
    input:request({ guaranteedCount:2, encounters:2, gauge:18, inventory:{s6:2,s5:0,s4:0,s3:0,s1:0} }),
    expected:{ ev:1.03124, catchProb:1, action:'s6', route:['ミュウツー(6)','ミュウツー(6)'] }
  },
  {
    name:'two-guarantee remaining 10 -> 5 + 5',
    input:request({ guaranteedCount:2, encounters:2, gauge:20, inventory:{s6:0,s5:2,s4:0,s3:0,s1:0} }),
    expected:{ ev:1.029944, catchProb:1, action:'s5', route:['ハイパー(5)','ハイパー(5)'] }
  },
  {
    name:'premium off equal-value bonus beats super',
    input:request({ premium:false, encounters:2, gauge:27, inventory:{s6:0,s5:0,s4:1,s3:'∞',s1:0} }),
    expected:{ ev:1.154519797015862, catchProb:1, action:'s4', route:['ボーナス(3)'] }
  },
  {
    name:'mixed future 2/3 guarantee schedule',
    input:request({ encounters:4, detailEnabled:true, futureGuarantees:[2,3,2], inventory:baseInv({s6:5,s5:4,s3:6,s1:'∞'}) }),
    expected:{ ev:2.1240506300119093, catchProb:0.4659054400000001, action:'s6' }
  },
  {
    name:'infinite-resource tie-break',
    input:request({ encounters:3, gauge:24, fedCount:1, inventory:{s6:0,s5:10,s4:0,s3:'∞',s1:'∞'} }),
    expected:{ ev:2.170921381331712, catchProb:1, action:'s3', route:['スーパー(3)','スーパー(3)'] }
  }
];

for (const test of cases) {
  const result = solve(test.input);
  close(result.ev, test.expected.ev, `${test.name} ev`);
  close(result.catchProb, test.expected.catchProb, `${test.name} catchProb`);
  assert.equal(result.action?.id ?? null, test.expected.action, `${test.name} action`);
  if (test.expected.route) assert.deepEqual(Array.from(result.route), test.expected.route, `${test.name} route`);
}

// 2枚保証では、UIを迂回してボーナス1枚を渡しても計算結果は0枚と同一でなければならない。
const invalidBonus = request({ guaranteedCount:2, encounters:1, gauge:24, inventory:{s6:0,s5:0,s4:1,s3:1,s1:0} });
const noBonus = request({ guaranteedCount:2, encounters:1, gauge:24, inventory:{s6:0,s5:0,s4:0,s3:1,s1:0} });
const a = solve(invalidBonus);
const b = solve(noBonus);
close(a.ev, b.ev, '2-guarantee bonus guard ev');
close(a.catchProb, b.catchProb, '2-guarantee bonus guard catchProb');
assert.equal(a.action?.id ?? null, b.action?.id ?? null, '2-guarantee bonus guard action');
assert.deepEqual(Array.from(a.route), Array.from(b.route), '2-guarantee bonus guard route');

console.log(`OK: ${cases.length + 1} solver regression checks passed`);
