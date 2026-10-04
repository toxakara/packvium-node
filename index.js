import { createRequire } from 'node:module';
import {
  FixedPlacementError,
  InvalidRequestError,
  UnsupportedFeatureError,
  checkRequestShape,
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
export { FixedPlacementError, InvalidRequestError, UnsupportedFeatureError };
import * as commerceFallback from './commerce.js';
export { CommerceInputError } from './commerce.js';
const require = createRequire(import.meta.url);

/**
 * Every module this package can load as a compiled backend: a binary built beside this
 * file. No npm package is probed -- a specifier the manifest does not declare cannot be
 * resolved by a supply-chain scanner, and none is published to declare.
 *
 * `test/force-fallback.cjs` blocks exactly this list, and asserts it stays identical to
 * the specifiers `loadNative` passes.
 */
const NATIVE_CANDIDATES = ['./packvium-native.node'];

/**
 * Resolve the compiled backend, or report that there is none.
 *
 * The candidate is required by a *literal* specifier rather than through a variable, so
 * every module this package is able to load can be resolved by reading it. A probe that
 * misses is not an error: absent, unbuilt and ABI-incompatible addons all land here, and
 * every one of them means the same thing -- answer from the JavaScript fallback, which
 * returns the same result more slowly.
 */
function loadNative() {
  try {
    return require('./packvium-native.node');
  } catch { /* no addon beside this file */ }
  return null;
}

const native = loadNative();

export const backend = () => (native ? 'rust' : 'javascript');

export function packJson(input) {
  return packJsonWith(native, input);
}

// Separate from `packJson` so the native path can be exercised without a native build.
export function packJsonWith(binding, input) {
  if (binding?.packJson) {
    // The native binding reports errors as text; checking the rule table here first gives a
    // caller the same InvalidRequestError whichever backend answers.
    checkRequestShape(JSON.parse(input));
    return binding.packJson(input);
  }
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

export const version = () => native?.version?.() ?? '1.5.0-js-fallback';

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
