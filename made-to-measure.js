/**
 * Made-to-measure containers (docs/MADE-TO-MEASURE-CONTAINERS.md "1.6 implementation
 * contract"): the exact arithmetic every engine shares.
 *
 * A machine is `{minimum, increment, price, tarePerSquareMetre, allowance}`: three-element
 * tick arrays and integer prices. The declared container's inner dimensions are the largest
 * box it can cut. Ticks fit a safe integer; every area, volume and product is a BigInt, so
 * the rungs, the box and its price agree with Python, PHP and Rust to the unit.
 *
 * This module is package-internal: `fallback.js` and `request-errors.js` import it.
 */

/** One square metre in square length ticks: a tick is 1/16 000 000 m. */
const SQUARE_METRE_TICKS2 = 16000000n * 16000000n;
/** Each compact rung's side as a fraction of the integer cube root of the round's volume. */
const RUNG_FACTORS = [[5n, 4n], [3n, 2n], [2n, 1n]];

/** The smallest size the machine can cut on `axis` that is at least `value`. */
export function grid(machine, axis, value) {
  const minimum = machine.minimum[axis], step = machine.increment[axis];
  // Remainder and exact quotient only: no floating-point division decides a size.
  const span = Math.max(value, minimum) - minimum, remainder = span % step;
  return minimum + (span - remainder) + (remainder ? step : 0);
}

/** The inner surface of a closed box, 2(LW + LH + WH), in square ticks. */
export function surfaceArea([length, width, height]) {
  const [l, w, h] = [BigInt(length), BigInt(width), BigInt(height)];
  return 2n * (l * w + l * h + w * h);
}

/**
 * ceil(rate * area / 1 m^2), as `p*q + ceil(p*r / T^2)` with `q, r = divmod(area, T^2)`: the
 * split Rust needs to stay inside i128, kept here so the engines share one formula.
 */
export function perSquareMetre(rate, area) {
  const price = BigInt(rate), whole = area / SQUARE_METRE_TICKS2, fraction = area % SQUARE_METRE_TICKS2;
  return price * whole + (price * fraction + SQUARE_METRE_TICKS2 - 1n) / SQUARE_METRE_TICKS2;
}

/** A box's price: the container's fee plus its material, rounded up. Grows with every side. */
export const boxCost = (price, fee, sides) => BigInt(fee) + perSquareMetre(price, surfaceArea(sides));

/** The smallest non-negative c with c^3 >= value: doubling, then bisection, O(log value) steps. */
export function icbrtCeil(value) {
  let high = 1n;
  while (high * high * high < value) high *= 2n;
  let low = 0n;
  while (low < high) {
    const middle = (low + high) / 2n;
    if (middle * middle * middle >= value) high = middle;
    else low = middle + 1n;
  }
  return low;
}

/**
 * The rungs one trial tries, ascending on every axis, the machine maximum last. `edges` are each
 * remaining instance's envelope edges (nominal plus twice the clearance). O(r) over the r
 * instances plus the cube root; the list depends only on their multiset.
 */
export function solvingEnvelopes(machine, maximum, edges) {
  let total = 0n;
  const floors = [0, 0, 0];
  for (const instance of edges) {
    total += BigInt(instance[0]) * BigInt(instance[1]) * BigInt(instance[2]);
    const ranked = [...instance].sort((a, b) => b - a);
    for (let rank = 0; rank < 3; rank++) floors[rank] = Math.max(floors[rank], ranked[rank]);
  }
  const side = icbrtCeil(total), rungs = [];
  for (const [numerator, denominator] of RUNG_FACTORS) {
    const scaled = Number((side * numerator + denominator - 1n) / denominator);
    const rung = [0, 1, 2].map((axis) => Math.min(maximum[axis], grid(machine, axis, Math.max(scaled, floors[axis]))));
    const kept = rungs.some((other) => other.every((value, axis) => value === rung[axis]));
    if (!kept && BigInt(rung[0]) * BigInt(rung[1]) * BigInt(rung[2]) >= total) rungs.push(rung);
  }
  if (!rungs.some((rung) => rung.every((value, axis) => value === maximum[axis]))) rungs.push(maximum.slice());
  return rungs;
}

/**
 * The box cut for an achieved extent: its inner and outer sides, price and tare. O(1). The grid
 * never rounds below the extent or past the maximum, which is what lets the placements stand.
 */
export function fabricate(machine, maximum, achieved, fee, tare) {
  const sides = [0, 1, 2].map((axis) => grid(machine, axis, achieved[axis]));
  if (sides.some((side, axis) => side > maximum[axis])) throw new Error('fabricated box exceeds the machine');
  const area = surfaceArea(sides);
  return {
    sides,
    outer: sides.map((side, axis) => side + machine.allowance[axis]),
    cost: Number(BigInt(fee) + perSquareMetre(machine.price, area)),
    tare: Number(BigInt(tare) + perSquareMetre(machine.tarePerSquareMetre, area)),
  };
}
