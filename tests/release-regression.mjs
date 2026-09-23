// Run with: node tests/release-regression.mjs
// One command for pre-release verification of solver behavior + persisted-user-data migration.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const checks = ['solver-regression.mjs', 'storage-migration-regression.mjs'];

for (const file of checks) {
  const result = spawnSync(process.execPath, [path.join(here, file)], { stdio:'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`OK: all ${checks.length} pre-release regression suites passed`);
