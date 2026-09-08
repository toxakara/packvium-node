import { createRequire } from 'node:module';
import {
  UnsupportedFeatureError,
  packFallback,
  rebalanceWeight as rebalanceFallback,
} from './fallback.js';
export {
  ALL_DIRECTIONS, InvalidDirectionError, LoadingDependencyGraph, SequenceError,
  SequenceReplayError, SequenceWarning, UnloadingDependencyGraph, replayLoadingOrder,
  replayRemovalOrder, safeLoadingOrder, safeLoadingOrderWithEvidence,
  safeLoadingOrderForPlacements, safeRemovalOrder, safeRemovalOrderWithEvidence,
  placementReachability,
  verifyLoadingPrefixBusinessRules, REASON_MESSAGES, explainReason,
  explanationForUnpackedItem, explainUnpackedItem,
} from './fallback.js';
export { UnsupportedFeatureError };
import * as commerceFallback from './commerce.js';
export { CommerceInputError } from './commerce.js';
const require = createRequire(import.meta.url);

/**
 * Every module this package can load as a compiled backend, in probe order: a binary
 * built beside this file first, then the `@packvium/native` optional dependency.
 *
 * `test/force-fallback.cjs` blocks exactly this list, and asserts it stays identical to
 * the specifiers `loadNative` passes.
 */
const NATIVE_CANDIDATES = ['./packvium-native.node', '@packvium/native'];

/**
 * Resolve the compiled backend, or report that there is none.
 *
 * Each candidate is required by a *literal* specifier rather than through a loop
 * variable, so every module this package is able to load can be resolved by reading it.
 * A probe that misses is not an error: absent, unbuilt and ABI-incompatible addons all
 * land here, and every one of them means the same thing -- answer from the JavaScript
 * fallback, which returns the same result more slowly.
 */
function loadNative() {
  try {
    return require('./packvium-native.node');
  } catch { /* no addon beside this file */ }
  try {
    return require('@packvium/native');
  } catch { /* optional dependency absent or unloadable */ }
  return null;
}

const native = loadNative();

export const backend = () => (native ? 'rust' : 'javascript');

export function packJson(input) {
  if (native?.packJson) return native.packJson(input);
  return JSON.stringify(packFallback(JSON.parse(input)));
}

export function pack(request) {
  return JSON.parse(packJson(JSON.stringify(request)));
}

export function rebalanceWeight(request, result, { maxMoves = 64 } = {}) {
  if (!Number.isSafeInteger(maxMoves) || maxMoves < 0) {
    throw new RangeError('maxMoves must be a non-negative safe integer');
  }
  if (native?.rebalanceJson) {
    return JSON.parse(native.rebalanceJson(JSON.stringify(request), JSON.stringify(result), maxMoves));
  }
  return rebalanceFallback(request, result, { maxMoves });
}

export const version = () => native?.version?.() ?? '1.1.0-js-fallback';

/**
 * The exported commercial and control-plane API: a quote, a policy decision and catalog
 * version metadata over one canonical JSON document (docs/COMMERCE-API.md).
 *
 * Native-first with a deterministic JavaScript fallback, the same backend selection the
 * packing entry points use. The two agree on every shared fixture; `backend()` reports
 * which one answered a `pack`, and `commerce.backend()` which one answers these.
 */
export const commerce = {
  backend: () => (native?.commerceQuoteJson ? 'rust' : 'javascript'),
  API_VERSION: commerceFallback.API_VERSION,
  REJECTION_CODES: commerceFallback.REJECTION_CODES,
  canonicalJson: commerceFallback.canonicalJson,
  quote: (document, request) =>
    viaNative(native?.commerceQuoteJson, document, request) ?? commerceFallback.quote(document, request),
  evaluatePolicy: (document, request) =>
    viaNative(native?.commerceEvaluatePolicyJson, document, request)
      ?? commerceFallback.evaluatePolicy(document, request),
  catalogVersionInfo: (document, request) =>
    viaNative(native?.commerceCatalogVersionInfoJson, document, request)
      ?? commerceFallback.catalogVersionInfo(document, request),
};

/**
 * Call one native commerce entry point, or report that there is none.
 *
 * A native input error is re-thrown as the same `CommerceInputError` the fallback
 * raises, so a caller never has to know which backend answered to catch the failure.
 */
function viaNative(entry, document, request) {
  if (!entry) return null;
  try {
    return JSON.parse(entry(JSON.stringify({ document, request })));
  } catch (error) {
    throw new commerceFallback.CommerceInputError(error.message);
  }
}
