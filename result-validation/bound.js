/**
 * The optimality bound and gap of docs/OPTIMALITY-GAP.md § 6.2, recomputed from the request
 *: `optimality.lower_bound` is the recomputed prefix, the gap agrees with it and the
 * score, no score falls below it, and `optimal` / `proven_optimal` are claimed only by
 * attainment. The reference's own copy of docs/OPTIMALITY-CERTIFICATES.md's formulas and its one
 * refusal predicate, shared with nothing in the fallback solver.
 *
 * Every quantity is a `BigInt`: volumes are products of three tick lengths and the guarded sums
 * reach 10^30, so no `Number` product is ever formed. O(t log t + c log c) for `t` item types and
 * `c` container types, O(t + c) memory, once per result.
 */

import {
  at, getNull, getOr, int, isDict, strictInt, truthy,
} from './json.js';
import { ceilDiv, floorDiv, max, min, pyMod, ratioPpm } from './num.js';
import { issue } from './outcome.js';
import { intList, pyRepr } from './pyfmt.js';
import { SCORE_SCALE } from './stacking.js';

/** Where each covered objective reads `(L0, L1, L2, L3, L4)` in its own score order. */
const BOUND_ORDERS = new Map([['default', [0, 1, 2, 3, 4]], ['lowest_cost', [0, 2, 1, 3, 4]]]);

const MAX_BOUND_SUM = 10n ** 30n;
const MAX_BOUND_VALUE = 2n ** 53n - 1n;
const GAP_FIELDS = ['gap_key', 'absolute_gap', 'relative_gap'];
const SHRINKING_SHAPES = ['convex_hull', 'compressible'];

const ascending = (left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);

/** `[value, count]` runs, sorted by value: one entry per item type, however large its quantity. */
const runsOf = (pairs) => pairs.slice().sort(ascending);

const runCount = (runs) => runs.reduce((total, [, count]) => total + count, 0n);

const largestOf = (values) => values.reduce((largest, value) => max(largest, value));

/** How many of the smallest values sum to at most `capacity`; all of them when it is unlimited. */
function fit(runs, capacity) {
  if (capacity === null) return runCount(runs);
  if (capacity < 0n) return 0n;
  let taken = 0n;
  let used = 0n;
  for (const [value, count] of runs) {
    const room = value === 0n ? count : min(count, floorDiv(capacity - used, value));
    taken += room;
    used += value * room;
    if (room < count) break;
  }
  return taken;
}

/** The sum of the `count` smallest values. */
function smallest(runs, count) {
  let total = 0n;
  let remaining = count;
  for (const [value, available] of runs) {
    if (remaining <= 0n) break;
    const taken = min(available, remaining);
    total += value * taken;
    remaining -= taken;
  }
  return total;
}

const largest = (runs, count) => smallest(runs.slice().reverse(), count);

/** `Σ value × quantity`, or `null` when unbounded; a type that holds nothing adds 0. */
function capacityTotal(values, quantities) {
  let total = 0n;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const quantity = quantities[index];
    if (value === null) return null;
    if (quantity === null) {
      if (value > 0n) return null;
    } else {
      total += value * quantity;
    }
  }
  return total;
}

/** `L1`, given `L0`. */
function containerBound(volumes, weights, shrinks, placed, containers) {
  if (placed <= 0n || containers.length === 0) return 0n;
  let bound = 1n;
  const largestVolume = largestOf(containers.map((container) => container.usable));
  if (!shrinks && largestVolume > 0n) bound = max(bound, ceilDiv(smallest(volumes, placed), largestVolume));
  const payloads = containers.map((container) => container.payload);
  if (payloads.every((payload) => payload !== null)) {
    const largestPayload = largestOf(payloads);
    if (largestPayload > 0n) bound = max(bound, ceilDiv(smallest(weights, placed), largestPayload));
  }
  const slots = containers.map((container) => container.maxItems);
  if (slots.every((slot) => slot !== null)) {
    const largestSlots = largestOf(slots);
    if (largestSlots > 0n) bound = max(bound, ceilDiv(placed, largestSlots));
  }
  return bound;
}

/** `L2`: the `opened` cheapest containers the inventory holds, greedily by cost (stable). */
function costBound(containers, opened) {
  const byCost = containers.map((container, index) => [container.costMinor, index])
    .sort((left, right) => ascending(left, right) || left[1] - right[1]);
  let total = 0n;
  let remaining = opened;
  for (const [cost, index] of byCost) {
    if (remaining <= 0n) break;
    const { quantity } = containers[index];
    const taken = quantity === null ? remaining : min(quantity, remaining);
    total += cost * taken;
    remaining -= taken;
  }
  return total;
}

/** `L3`. */
function unusedBound(volumes, shrinks, placed, containers, opened) {
  const inner = containers.map((container) => container.innerVolume).filter((volume) => volume > 0n);
  if (opened <= 0n || shrinks || inner.length === 0) return 0n;
  const smallestInner = inner.reduce((least, volume) => min(least, volume));
  const filled = ceilDiv(largest(volumes, placed) * SCORE_SCALE, smallestInner);
  return max(0n, opened * SCORE_SCALE - filled - (opened - 1n));
}

/** `L4`. */
function heightBound(volumes, shrinks, placed, containers, opened) {
  const floors = containers.map((container) => container.baseArea).filter((area) => area > 0n);
  const heights = containers.map((container) => container.height).filter((height) => height > 0n);
  if (opened <= 0n || shrinks || floors.length === 0 || heights.length === 0) return 0n;
  const required = ceilDiv(smallest(volumes, placed), largestOf(floors));
  return max(0n, floorDiv(required * SCORE_SCALE, largestOf(heights)) - (opened - 1n));
}

/**
 * `[L0, L1, L2, L3, L4]` of docs/OPTIMALITY-CERTIFICATES.md, or `null` where its one refusal
 * predicate withholds the bound. Exported so the shared scene can hold it to the oracle.
 */
export function lowerBound(volumes, weights, shrinks, containers) {
  const quantities = containers.map((container) => container.quantity);
  const sumOf = (runs) => runs.reduce((total, [value, count]) => total + value * count, 0n);
  const guarded = [
    sumOf(volumes),
    sumOf(weights),
    capacityTotal(containers.map((container) => container.usable), quantities),
    capacityTotal(containers.map((container) => container.payload), quantities),
    capacityTotal(containers.map((container) => container.maxItems), quantities),
  ];
  if (guarded.some((total) => total !== null && total > MAX_BOUND_SUM)) return null;
  const count = runCount(volumes);
  let placeable = 0n;
  if (containers.length > 0) {
    placeable = count;
    if (!shrinks) placeable = min(placeable, fit(volumes, guarded[2]));
    placeable = min(placeable, fit(weights, guarded[3]));
    if (guarded[4] !== null) placeable = min(placeable, guarded[4]);
  }
  const opened = containerBound(volumes, weights, shrinks, placeable, containers);
  const bound = [
    count - placeable,
    opened,
    costBound(containers, opened),
    unusedBound(volumes, shrinks, placeable, containers, opened),
    heightBound(volumes, shrinks, placeable, containers, opened),
  ];
  return bound.some((value) => value > MAX_BOUND_VALUE) ? null : bound;
}

/** The request as the bound reads it: every instance, fixed ones included, and every type. */
function boundInputs(items, containers) {
  const specs = items.values();
  const quantityOf = (spec) => int(spec.quantity, 'quantity');
  const volumes = runsOf(specs.map((spec) => [spec.dimensions[0] * spec.dimensions[1] * spec.dimensions[2], quantityOf(spec)]));
  const weights = runsOf(specs.map((spec) => [spec.weight, quantityOf(spec)]));
  const shrinks = specs.some((spec) => quantityOf(spec) > 0n
    && (spec.nestingHeight !== null || SHRINKING_SHAPES.includes(spec.shapeType)));
  const types = containers.values().map((spec) => {
    const volume = spec.inner[0] * spec.inner[1] * spec.inner[2];
    const scaled = ratioPpm(spec.voidFillReserveRatio);
    const reserved = floorDiv(volume, SCORE_SCALE) * scaled + floorDiv(pyMod(volume, SCORE_SCALE) * scaled, SCORE_SCALE);
    return {
      innerVolume: volume,
      baseArea: spec.inner[0] * spec.inner[1],
      height: spec.inner[2],
      usable: volume - reserved,
      costMinor: spec.costMinor,
      payload: spec.maxPayload,
      maxItems: spec.maxItems,
      quantity: spec.quantity,
    };
  });
  return [volumes, weights, shrinks, types];
}

/** The bound in the objective's score order, or `null` with the reason none is stated (§ 1.5). */
function statedBound(request, status, items, containers) {
  const name = getOr(getOr(request, 'configuration', {}), 'objective', 'default');
  const order = typeof name === 'string' ? BOUND_ORDERS.get(name) : undefined;
  if (order === undefined) return { bound: null, withheld: `objective ${pyRepr(name)} has no bound` };
  if (containers.values().some((spec) => spec.madeToMeasure !== null)) {
    return { bound: null, withheld: 'a container is made to measure' };
  }
  if (status === 'infeasible') return { bound: null, withheld: "status is 'infeasible'" };
  if (status === 'invalid_result') return { bound: null, withheld: "status is 'invalid_result'" };
  const bound = lowerBound(...boundInputs(items, containers));
  if (bound === null) return { bound: null, withheld: 'the request is past a declared ceiling' };
  return { bound: order.map((position) => bound[position]), withheld: '' };
}

/** The first position where `score` leaves `bound`, and whether it is above (1) or below (-1). */
function departureOf(score, bound) {
  const shared = Math.min(score.length, bound.length);
  for (let index = 0; index < shared; index += 1) {
    if (score[index] !== bound[index]) return { index, sign: score[index] > bound[index] ? 1 : -1 };
  }
  return null;
}

const isCount = (value) => {
  const integer = strictInt(value);
  return integer !== null && integer >= 0n;
};

/** The prefix length and the three gap fields a correct result carries (§ 1.1). */
function expectedGap(score, bound, departure) {
  if (departure === null) return { length: bound.length, gap: { gap_key: null, absolute_gap: null, relative_gap: null } };
  const key = departure.index;
  const absolute = score[key] - bound[key];
  return {
    length: key + 1,
    gap: { gap_key: BigInt(key), absolute_gap: absolute, relative_gap: bound[key] === 0n ? null : [absolute, bound[key]] },
  };
}

function gapFieldMatches(name, actual, expected) {
  if (expected === null) return actual === null;
  if (name !== 'relative_gap') return strictInt(actual) === expected;
  return isDict(actual) && Object.keys(actual).length === 2
    && strictInt(getNull(actual, 'numerator')) === expected[0]
    && strictInt(getNull(actual, 'denominator')) === expected[1];
}

function gapText(name, expected) {
  if (expected === null) return 'absent';
  return name === 'relative_gap' ? `${expected[0]}/${expected[1]}` : String(expected);
}

const sameInts = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

function checkReportedBound(emitted, score, bound, departure, fact, issues) {
  const prefix = bound.slice(0, emitted.length);
  if (!sameInts(emitted, prefix)) {
    issues.push(issue('optimality_bound_mismatch', `reported ${intList(emitted)}, recomputed ${intList(prefix)}`));
  }
  const { length, gap } = expectedGap(score, bound, departure);
  if (emitted.length !== length) {
    issues.push(issue('optimality_gap_mismatch', `lower_bound has ${emitted.length} entries, expected ${length}`));
  }
  for (const name of GAP_FIELDS) {
    if (!gapFieldMatches(name, getNull(fact, name), gap[name])) {
      issues.push(issue('optimality_gap_mismatch', `${name} should be ${gapText(name, gap[name])}`));
    }
  }
}

/** `lower_bound` as a list of counts when it is one of 1 to 5 non-negative integers, else `null`. */
function wellFormed(emitted) {
  if (!Array.isArray(emitted) || emitted.length < 1 || emitted.length > 5 || !emitted.every(isCount)) return null;
  return emitted.map(strictInt);
}

function checkEmitted(fact, emitted, counts, stated, score, departure, below, issues) {
  if (emitted === null) {
    if (GAP_FIELDS.some((name) => getNull(fact, name) !== null)) {
      issues.push(issue('optimality_gap_mismatch', 'a gap is reported without lower_bound'));
    }
  } else if (counts === null) {
    issues.push(issue('optimality_bound_mismatch', 'lower_bound must be a list of 1 to 5 non-negative integers'));
  } else if (stated.bound === null) {
    issues.push(issue('optimality_bound_mismatch', `lower_bound is reported where no bound is stated: ${stated.withheld}`));
  } else if (below) {
    issues.push(issue('optimality_bound_mismatch', 'lower_bound is reported for a score below the recomputed bound'));
  } else {
    checkReportedBound(counts, score, stated.bound, departure, fact, issues);
  }
}

function checkClaims(result, fact, attained, claimsAttainment, issues) {
  const status = at(result, 'status');
  const complete = truthy(at(result, 'complete'));
  if (status === 'optimal' && !(complete && attained)) {
    issues.push(issue('result_fact_mismatch',
      "status 'optimal' requires a complete result that attains the recomputed lower bound"));
  }
  if (status === 'feasible' && complete && claimsAttainment) {
    issues.push(issue('result_fact_mismatch',
      "status is 'feasible', but the result attains its lower_bound; expected 'optimal'"));
  }
  if (getNull(fact, 'code') !== 'proven_optimal' || claimsAttainment) return;
  issues.push(issue('unproven_optimality_claim', "optimality.code is 'proven_optimal' without an attained lower_bound"));
}

/**: the reference's `_check_optimality_bound`. Absence of the field is never an issue. */
export function checkOptimalityBound(request, result, items, containers, score, issues) {
  const fact = at(result, 'optimality');
  const stated = statedBound(request, at(result, 'status'), items, containers);
  const departure = stated.bound === null ? null : departureOf(score, stated.bound);
  const below = departure !== null && departure.sign < 0;
  if (below) {
    const key = departure.index;
    issues.push(issue('score_below_bound', `score[${key}] is ${score[key]}, below its lower bound ${stated.bound[key]}`));
  }
  const emitted = getNull(fact, 'lower_bound');
  if (emitted !== null && stated.bound !== null && departure !== null
      && score[departure.index] - stated.bound[departure.index] > MAX_BOUND_VALUE) {
    issues.push(issue('optimality_gap_mismatch', 'the gap exceeds the portable result ceiling'));
  }
  const counts = emitted === null ? null : wellFormed(emitted);
  checkEmitted(fact, emitted, counts, stated, score, departure, below, issues);
  const attained = stated.bound !== null && departure === null;
  checkClaims(result, fact, attained, counts !== null && sameInts(counts, score), issues);
}
