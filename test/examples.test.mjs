/**
 * Every shipped Node example is executable documentation.
 *
 * The workspace-level examples gate pins stdout. This package-level suite adds the same
 * ownership checks the Python and PHP ports already have, so publishing only the Node
 * tree cannot silently leave its examples untested.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const PACKAGE = dirname(dirname(fileURLToPath(import.meta.url)));
const EXAMPLES = join(PACKAGE, 'examples');
const files = readdirSync(EXAMPLES).filter((name) => name.endsWith('.mjs')).sort();

const mask = (output) => output
  .replace(/("(?:duration_ms|elapsed_ms)":\s*)\d+/g, '$1<masked>')
  .replace(/\b(?:native|javascript)\b(?= backend\b)|(?<=^backend: )\S+/gm, '<backend>')
  .replace(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g, '<version>');

const run = (name) => execFileSync(process.execPath, [join('examples', name)], {
  cwd: PACKAGE,
  encoding: 'utf8',
  env: { ...process.env },
  timeout: 300_000,
});

test('the examples directory is not empty', () => {
  assert.notEqual(files.length, 0);
});

for (const name of files) {
  test(`${name} runs, documents its command, and is deterministic`, () => {
    const source = readFileSync(join(EXAMPLES, name), 'utf8');
    assert.match(source, /Run it:/);
    assert.ok(source.includes(`examples/${name}`));
    assert.match(source, /from ['"]\.\.\/index\.js['"]/);

    const first = run(name);
    assert.notEqual(first.trim(), '');
    assert.equal(mask(first), mask(run(name)));
  });
}

