/**
 * The forced-fallback hook is the load-bearing part of `make coverage-node`:
 * if it silently stopped blocking, the coverage run would quietly start measuring a
 * machine that has a native addon installed and the baseline would drift for reasons
 * nothing in the diff explains. So it is tested from both sides -- a fake but genuinely
 * resolvable native backend is picked up without the hook and rejected with it. A
 * one-sided test would pass just as happily against a hook that does nothing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { NATIVE_CANDIDATES } = require('./force-fallback.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.resolve(HERE, '..');
const HOOK = path.join(HERE, 'force-fallback.cjs');

const PROBE = "import {backend} from './index.js'; process.stdout.write(backend());";

/**
 * A copy of the package with a resolvable `@packvium/native` beside it. The stand-in
 * is plain JavaScript rather than a compiled addon because `index.js` only ever asks
 * whether the module resolves and exposes `packJson` -- nothing about the block depends
 * on it being real machine code, and a real one cannot be built inside a unit test.
 */
function packageWithAFakeNativeBackend() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packvium-forced-fallback-'));
  // Every module the package ships, taken from the manifest rather than listed again
  // here: a hand-written copy silently stops being a copy of the package the day a
  // module is added, and the probe fails to resolve an import for reasons nothing in
  // the diff explains.
  const shipped = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'package.json'), 'utf8')).files;
  for (const name of shipped.filter((file) => file.endsWith('.js'))) {
    fs.copyFileSync(path.join(PACKAGE, name), path.join(root, name));
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const fake = path.join(root, 'node_modules/@packvium/native');
  fs.mkdirSync(fake, { recursive: true });
  fs.writeFileSync(path.join(fake, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
  fs.writeFileSync(path.join(fake, 'index.cjs'), 'module.exports={packJson:(s)=>s};');
  fs.writeFileSync(path.join(root, 'probe.mjs'), PROBE);
  return root;
}

function backendOf(root, ...flags) {
  return execFileSync(process.execPath, [...flags, path.join(root, 'probe.mjs')], {
    cwd: root, encoding: 'utf8',
  });
}

test('the hook blocks a native backend that would otherwise be loaded', () => {
  const root = packageWithAFakeNativeBackend();
  try {
    assert.equal(backendOf(root), 'rust',
      'the fake backend must really be resolvable, or the block below proves nothing');
    assert.equal(backendOf(root, '--require', HOOK), 'javascript');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The hook blocks by construction, but only if it is actually loaded in the process
 * running the tests -- `node --test` executes each file in a child, and whether
 * `--import` reaches that child is a property of the Node version, not of this package.
 * `make coverage-node` sets the variable, so a Node that stopped propagating the
 * preload fails the coverage run instead of quietly measuring a native backend.
 */
test('the measured coverage run really is the fallback', { skip: !process.env.PACKVIUM_FORCED_FALLBACK }, async () => {
  const { backend } = await import('../index.js');
  assert.equal(backend(), 'javascript',
    'coverage was measured against the native backend; the forced-fallback preload did not reach this process');
});

test('the blocked candidates are the ones index.js actually tries', () => {
  const source = fs.readFileSync(path.join(PACKAGE, 'index.js'), 'utf8');
  const candidates = source.match(/for\(const candidate of \[([^\]]*)\]/);
  assert.ok(candidates, 'index.js no longer declares its native candidates as a literal list');
  const declared = [...candidates[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(declared, NATIVE_CANDIDATES,
    'index.js and force-fallback.mjs disagree about the native candidates');
});
