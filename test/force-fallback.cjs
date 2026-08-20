/**
 * Make the native addon unresolvable for the lifetime of this process.
 *
 * This is a CommonJS preload on purpose. The package supports Node 16 and its full test
 * suite runs on Node 18 and newer, while `node:module.registerHooks` only exists in much
 * newer Node releases. `index.js` probes native backends through `createRequire()`, so
 * intercepting the CommonJS filename resolver blocks exactly that boundary on every
 * supported runtime.
 *
 * Preload with `node --require ./test/force-fallback.cjs`.
 */

'use strict';

const Module = require('node:module');

// Exactly what `index.js` probes, and nothing else -- `force-fallback.test.mjs` asserts
// the two lists stay identical, which is what makes "this hook blocks the package's
// native backend" a checkable claim rather than a comment.
const NATIVE_CANDIDATES = ['./packvium-native.node', '@packvium/native'];

// Paths only a test reaches for: the in-workspace build directory the commerce suite
// loads when it compares the native and fallback backends against each other. Blocked
// too, because "forced fallback" has to mean forced everywhere -- a suite that loaded
// the addon by a path this hook did not know would measure the wrong backend and pull a
// file outside `package.json`'s `files` into the coverage report.
const TEST_ONLY_CANDIDATES = ['../../packvium-rust/bindings/node'];

const BLOCKED = [...NATIVE_CANDIDATES, ...TEST_ONLY_CANDIDATES];

class NativeBackendBlockedError extends Error {
  constructor(specifier) {
    super(`native backend '${specifier}' is blocked: this process is pinned to the JavaScript fallback`);
    this.name = 'NativeBackendBlockedError';
    this.code = 'MODULE_NOT_FOUND';
  }
}

const nextResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWithoutNativeBackend(request, parent, isMain, options) {
  if (BLOCKED.includes(request)) throw new NativeBackendBlockedError(request);
  return nextResolveFilename.call(this, request, parent, isMain, options);
};

module.exports = { NATIVE_CANDIDATES, TEST_ONLY_CANDIDATES, NativeBackendBlockedError };
