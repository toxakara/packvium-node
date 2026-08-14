/**
 * Compatibility wrapper for the original ESM preload path.
 *
 * The implementation lives in the CommonJS preload because the package test matrix
 * includes Node versions that predate synchronous ESM resolver hooks. Importing this
 * file still installs the same resolver block, so retained tooling that used the first
 * path does not silently stop forcing the fallback.
 */

import hook from './force-fallback.cjs';

export const { NATIVE_CANDIDATES, NativeBackendBlockedError } = hook;
