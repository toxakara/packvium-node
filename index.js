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
import { SUITE_VERSION } from './artifacts.js';
const require = createRequire(import.meta.url);

/** The largest `maxMoves` the addon's `u32` parameter holds; napi wraps anything above it. */
const MAX_U32 = 0xffffffff;

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
 *
 * An addon built for another release is treated the same way: it would answer
 * with that release's rules and schema while `version()` and the package claim this one.
 */
function loadNative() {
  try {
    const binding = require('./packvium-native.node');
    return isThisRelease(binding) ? binding : null;
  } catch { /* no addon beside this file */ }
  return null;
}

/** Whether `binding` reports exactly the suite version this package was released at. */
function isThisRelease(binding) {
  return typeof binding?.version === 'function' && binding.version() === SUITE_VERSION;
}

/**
 * The fields the core names in its one unsupported-feature sentence (`packvium-core`
 * `api.rs`, "does not yet implement a, b; the request was rejected ..."), read from the
 * message because the core keeps only that sentence -- the same reading `@packvium/browser`
 * makes of the same error.
 */
const UNSUPPORTED_FIELDS = /does not yet implement (.+?); the request was rejected/;

/**
 * The class a native refusal stands for, or the error itself when it is not one: the addon
 * raises a plain `Error` whose `code`, `reason`, `field` and `detail` carry the core's
 * structured refusal, and a caller must get the class the fallback throws for the same input.
 */
function fromNative(error) {
  if (!(error instanceof Error)) return error;
  if (error.code === InvalidRequestError.code) {
    return new InvalidRequestError(error.reason, error.field, error.detail);
  }
  if (error.code === FixedPlacementError.code) {
    return new FixedPlacementError(error.detail, error.reason, error.field);
  }
  if (error.code === 'unsupported_feature') return unsupportedFromNative(error.message);
  return error;
}

/** The core's refusal as the fallback's class, keeping the core's own sentence as the message. */
function unsupportedFromNative(message) {
  const named = UNSUPPORTED_FIELDS.exec(message);
  const translated = new UnsupportedFeatureError(named ? named[1].split(', ') : []);
  // The sentence names the engine that refused -- here the Rust core, not the JavaScript fallback.
  translated.message = message;
  return translated;
}

/** The native call's answer, or its refusal re-thrown as the fallback's class. */
function answered(call) {
  try {
    return call();
  } catch (error) {
    throw fromNative(error);
  }
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
    return answered(() => binding.packJson(input));
  }
  return JSON.stringify(packFallback(JSON.parse(input)));
}

export function pack(request) {
  return JSON.parse(packJson(JSON.stringify(request)));
}

export function rebalanceWeight(request, result, options) {
  return rebalanceWeightWith(native, request, result, options);
}

/**
 * Separate from `rebalanceWeight` so the native path can be exercised without a native build.
 *
 * The bound is the addon's: it takes `maxMoves` as a `u32`, and napi wraps anything above it
 * (`2 ** 32` would arrive as zero moves). Refused on both backends, with `@packvium/browser`'s
 * message, so the answer to an out-of-range value does not depend on which one is installed.
 */
export function rebalanceWeightWith(binding, request, result, { maxMoves = 64 } = {}) {
  if (!Number.isSafeInteger(maxMoves) || maxMoves < 0 || maxMoves > MAX_U32) {
    throw new RangeError('maxMoves must be an integer from 0 to 4294967295');
  }
  if (binding?.rebalanceJson) {
    return JSON.parse(answered(() => binding.rebalanceJson(JSON.stringify(request), JSON.stringify(result), maxMoves)));
  }
  return rebalanceFallback(request, result, { maxMoves });
}

export const version = () => native?.version?.() ?? '1.7.0-js-fallback';

/**
 * The result is not a document the reference validator can judge (docs/VALIDATION-CONTRACT.md):
 * a contract break, not a packing defect. `kind` is `contract` when the reference raises
 * `MalformedResult` with this same message, `shape` when it fails on the input another way.
 */
export class MalformedResult extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'MalformedResult';
    this.kind = kind;
  }
}

/**
 * `validate` needs the compiled addon: the reference validator is ported to the Rust core
 *, and the JavaScript fallback's own port is.
 */
export class ValidatorUnavailableError extends Error {
  constructor() {
    super('validate() needs the compiled addon; the JavaScript fallback has no validator yet');
    this.name = 'ValidatorUnavailableError';
    this.code = 'validator_unavailable';
  }
}

/**
 * Every way `result` fails to be a sound answer to `request`, as `{code, detail}` objects
 * identical to `packvium.validate`'s in every package; an empty list means valid. Throws
 * `MalformedResult` for a result that does not have the documented shape at all.
 */
export function validate(request, result) {
  return validateWith(native, request, result);
}

// Separate from `validate` so the native path can be exercised without a native build.
export function validateWith(binding, request, result) {
  if (!binding?.validateJson) {
    throw new ValidatorUnavailableError();
  }
  const outcome = JSON.parse(binding.validateJson(JSON.stringify(request), JSON.stringify(result)));
  if (outcome.refusal) {
    throw new MalformedResult(outcome.refusal.message, outcome.refusal.kind);
  }
  return outcome.issues;
}

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
