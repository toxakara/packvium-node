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

const NATIVE_CANDIDATES = ['./packvium-native.node', '@packvium/native'];

class NativeBackendBlockedError extends Error {
  constructor(specifier) {
    super(`native backend '${specifier}' is blocked: this process is pinned to the JavaScript fallback`);
    this.name = 'NativeBackendBlockedError';
    this.code = 'MODULE_NOT_FOUND';
  }
}

const nextResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWithoutNativeBackend(request, parent, isMain, options) {
  if (NATIVE_CANDIDATES.includes(request)) throw new NativeBackendBlockedError(request);
  return nextResolveFilename.call(this, request, parent, isMain, options);
};

module.exports = { NATIVE_CANDIDATES, NativeBackendBlockedError };
