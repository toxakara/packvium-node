/**
 * The commercial and control-plane models: carrier rating, eligibility policy and
 * catalog versioning.
 *
 * An independent implementation of the contract in docs/COMMERCE-API.md, held to
 * producing a valid result that meets each shared fixture's objective floor. For a
 * quote that floor is an exact integer price, so matching it means matching exactly.
 *
 * Money, weight and volume arithmetic runs in BigInt and every inexact division rounds
 * up, so a quote can neither drift through a double nor land a minor unit below what
 * the tariff charges. Results are converted back to Number at the boundary; a component
 * beyond Number.MAX_SAFE_INTEGER is refused rather than silently rounded.
 *
 * This module is package-internal: package.json exports only the root entry point.
 */

export class CommerceInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommerceInputError';
  }
}

/** Exact ceil(a * b / d) for non-negative inputs, in BigInt so nothing can wrap. */
export function ceilMulDiv(a, b, d) {
  const divisor = BigInt(d);
  if (divisor <= 0n) throw new CommerceInputError('divisor must be positive');
  const product = BigInt(a) * BigInt(b);
  return (product + divisor - 1n) / divisor;
}

/** Convert an exact BigInt back to a JSON number, refusing a value a double cannot hold. */
export function exact(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new CommerceInputError(
      `${value} is outside JavaScript's exact integer range; this quote cannot be represented`,
    );
  }
  return number;
}

/**
 * Order two strings by Unicode code point, the way every other implementation orders
 * them.
 *
 * JavaScript's default string comparison is by UTF-16 code unit, which disagrees with
 * Python, PHP and Rust for any character outside the Basic Multilingual Plane: an emoji
 * (U+1F600) sorts *before* a fullwidth Latin A (U+FF21) by code unit and *after* it by
 * code point. Sorted id lists are part of this contract's answer, so a default `.sort()`
 * would make this implementation disagree with the other three on exactly those inputs.
 */
export function compareCodePoints(left, right) {
  const a = Array.from(left);
  const b = Array.from(right);
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

// ------------------------------------------------------------------------------ rating

/** The charge one accessorial adds, given the base charge it may be a permille of. */
export function accessorialCharge(accessorial, baseChargeMinor) {
  if (accessorial.flatChargeMinor !== null) return BigInt(accessorial.flatChargeMinor);
  return ceilMulDiv(baseChargeMinor, accessorial.permilleOfBase, 1000);
}

/**
 * Rate a request against one already-resolved immutable tariff version.
 *
 * Returns either `{breakdown}` or `{rejection}`, where a rejection names structurally
 * what was missing -- never a silently-zero charge.
 */
export function rateTariff(tariff, request) {
  if (!Object.hasOwn(tariff.costPerDimensionalKgMinor, request.zone)) {
    return { rejection: { kind: 'zone', zone: request.zone } };
  }
  const unknown = request.requestedAccessorials
    .filter((id) => !Object.hasOwn(tariff.accessorials, id))
    .sort(compareCodePoints);
  if (unknown.length > 0) return { rejection: { kind: 'accessorial', accessorialIds: unknown } };

  // Dimensional weight in grams is volume (mm^3) over the divisor, rounded up.
  const dimensionalWeightG = ceilMulDiv(request.volumeMm3, 1, tariff.dimensionalWeightDivisor);
  const billedWeightG =
    BigInt(request.actualWeightG) > dimensionalWeightG
      ? BigInt(request.actualWeightG)
      : dimensionalWeightG;

  const rawBaseChargeMinor = ceilMulDiv(
    billedWeightG, tariff.costPerDimensionalKgMinor[request.zone], 1000,
  );
  const minimumChargeApplied = rawBaseChargeMinor < BigInt(tariff.minimumChargeMinor);
  const baseChargeMinor = minimumChargeApplied
    ? BigInt(tariff.minimumChargeMinor)
    : rawBaseChargeMinor;

  const fuelSurchargeMinor = ceilMulDiv(baseChargeMinor, tariff.fuelSurchargePermille, 1000);
  const accessorialCharges = request.requestedAccessorials.map((id) => [
    id, accessorialCharge(tariff.accessorials[id], baseChargeMinor),
  ]);
  const accessorialTotal = accessorialCharges.reduce((sum, [, amount]) => sum + amount, 0n);

  return {
    breakdown: {
      carrier_id: tariff.carrierId,
      service_id: tariff.serviceId,
      tariff_version: tariff.version,
      zone: request.zone,
      actual_weight_g: request.actualWeightG,
      dimensional_weight_g: exact(dimensionalWeightG),
      billed_weight_g: exact(billedWeightG),
      base_charge_minor: exact(baseChargeMinor),
      minimum_charge_applied: minimumChargeApplied,
      fuel_surcharge_minor: exact(fuelSurchargeMinor),
      accessorial_charges_minor: accessorialCharges.map(([id, amount]) => [id, exact(amount)]),
      total_minor: exact(baseChargeMinor + fuelSurchargeMinor + accessorialTotal),
    },
  };
}

/**
 * The version effective at `asOf`: the highest `effective_at` not after it, ties broken
 * by the higher (later-published) version number. Null when nothing has taken effect.
 */
export function effectiveVersion(history, asOf, numberOf) {
  let winner = null;
  for (const candidate of history) {
    if (candidate.effectiveAt > asOf) continue;
    if (
      winner === null
      || candidate.effectiveAt > winner.effectiveAt
      || (candidate.effectiveAt === winner.effectiveAt && numberOf(candidate) > numberOf(winner))
    ) {
      winner = candidate;
    }
  }
  return winner;
}

// ------------------------------------------------------------------------------ policy

export const POLICY_SCOPES = [
  'facility', 'customer', 'carrier', 'material', 'hazmat', 'temperature', 'service',
];
export const POLICY_OPERATORS = ['equals', 'not_equals', 'in', 'not_in', 'exists', 'absent'];
export const POLICY_ACTIONS = ['allow', 'reject'];
const UNARY_OPERATORS = ['exists', 'absent'];

export function isUnary(operator) {
  return UNARY_OPERATORS.includes(operator);
}

/**
 * Value equality over the JSON scalar types, matching the reference implementation
 * exactly -- including that a boolean equals the integer it stands for, the one place a
 * naive `===` would disagree and quietly change a decision.
 */
export function valuesEqual(left, right) {
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    if (typeof left === 'boolean' && typeof right === 'boolean') return left === right;
    const other = typeof left === 'boolean' ? right : left;
    return typeof other === 'number' && Number(left) === Number(right);
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => valuesEqual(entry, right[index]));
  }
  if (Array.isArray(left) || Array.isArray(right)) return false;
  if (left === null || right === null) return left === right;
  if (typeof left !== typeof right) return false;
  return left === right;
}

function contains(haystack, needle) {
  if (Array.isArray(haystack)) return haystack.some((entry) => valuesEqual(entry, needle));
  if (typeof haystack === 'string') return typeof needle === 'string' && haystack.includes(needle);
  return false;
}

export function predicateMatches(predicate, context) {
  const present = Object.hasOwn(context, predicate.field);
  if (predicate.operator === 'exists') return present;
  if (predicate.operator === 'absent') return !present;
  if (!present) return false;
  const actual = context[predicate.field];
  switch (predicate.operator) {
    case 'equals': return valuesEqual(actual, predicate.value);
    case 'not_equals': return !valuesEqual(actual, predicate.value);
    case 'in': return contains(predicate.value, actual);
    default: return !contains(predicate.value, actual);
  }
}

export function ruleMatches(rule, context) {
  return rule.predicates.every((predicate) => predicateMatches(predicate, context));
}

/**
 * Evaluate an already-resolved immutable rule set.
 *
 * Deny takes precedence: an explicit REJECT always outranks an ALLOW for the same
 * context. Among equals the highest priority wins, ties break on the lexicographically
 * smallest rule id, and nothing matching at all is allowed with no citation.
 */
export function decide(rules, scope, context) {
  const matching = rules.filter((rule) => rule.scope === scope && ruleMatches(rule, context));
  const rejects = matching.filter((rule) => rule.action === 'reject');
  const pool = rejects.length > 0 ? rejects : matching;
  if (pool.length === 0) return { scope, allowed: true, citation: null };

  // Ties break on the lexicographically smallest rule id -- by code point, because a
  // default `<` on strings compares UTF-16 code units and would cite a different rule
  // than the other three implementations whenever an id leaves the Basic Multilingual
  // Plane.
  const winner = pool.reduce((best, rule) => (
    rule.priority > best.priority
    || (rule.priority === best.priority && compareCodePoints(rule.ruleId, best.ruleId) < 0)
      ? rule : best
  ));
  return {
    scope,
    allowed: winner.action === 'allow',
    citation: {
      rule_id: winner.ruleId,
      version: winner.version,
      action: winner.action,
      priority: winner.priority,
      reason: winner.reason,
    },
  };
}
