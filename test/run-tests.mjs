import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const tests = fs.readdirSync(testDirectory)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join(testDirectory, name));

if (tests.length === 0) {
  process.stderr.write(`no test files found in ${testDirectory}\n`);
  process.exit(1);
}

const completed = spawnSync(process.execPath, ['--test', ...tests], {
  stdio: 'inherit',
});

if (completed.error) throw completed.error;
process.exit(completed.status ?? 1);
