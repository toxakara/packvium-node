/**
 * Units and numbers: why nothing here is a JavaScript number until you make it one.
 *
 * Run it:
 *
 *     node examples/units.mjs
 *
 * Every length and weight in the contract travels as a **decimal string**, and every
 * length in a result is an exact integer count of ticks — one tick is 1/16000 mm. That is
 * not ceremony. `0.1 + 0.2 !== 0.3` is true in this language, and a packing engine that
 * decides a fit by a hair has no room for a representation that rounds.
 *
 * This example is the JavaScript one on purpose. Of the four engines, this is the one
 * whose native number type stops being exact partway through the range the contract
 * allows, and the last section shows exactly where that boundary is and what happens when
 * you cross it.
 */

import { pack, commerce, CommerceInputError } from '../index.js';

// ------------------------------------------------------------- fractions survive intact
//
// Imperial sizes arrive as fractions far more often than as decimals, and "12 3/8" is an
// exact quantity while 12.375 is a float that happens to be exact and 8.1 is one that is
// not. Send the fraction; the engine converts once, exactly, into integer ticks.

const inches = pack({
  units: { length: 'in' },
  items: [{ id: 'plank', quantity: 2, dimensions: { length: '12 3/8', width: '8 1/2', height: '3/4' } }],
  containers: [{ id: 'crate', inner_dimensions: { length: '24', width: '24', height: '24' } }],
});

console.log('fractional inches');
console.log(`  status: ${inches.status}`);
for (const placement of inches.containers[0].placements) {
  const { x, y, z } = placement.position;
  console.log(`  ${placement.item_id.padEnd(9)} at ticks (${x.ticks}, ${y.ticks}, ${z.ticks})`
    + `  = (${x.value}, ${y.value}, ${z.value}) ${x.unit}`);
}

// Both forms come back: `ticks` is the exact integer the engine reasoned with, `value` is
// the same quantity rendered in the unit you asked for. Compare `ticks` when you need to
// know whether two things are the same; `value` is for showing a human.

// ------------------------------------------------------------------ one tick decides it
//
// A container exactly one tick shorter than the item refuses it. There is no tolerance to
// tune, because a tolerance is a decision about someone else's warehouse.

const TICKS_PER_MM = 16000;
const fit = (containerMm) => {
  const result = pack({
    units: { length: 'mm' },
    items: [{ id: 'rod', quantity: 1, dimensions: { length: '100', width: '10', height: '10' } }],
    containers: [{ id: 'tube', inner_dimensions: { length: containerMm, width: '10', height: '10' } }],
  });
  const refused = result.unpacked_items[0];
  return refused ? `refused: ${refused.reason}` : 'placed';
};

console.log('\none tick decides it');
console.log(`  container 100 mm exactly     -> ${fit('100')}`);
console.log(`  container one tick shorter   -> ${fit(String((100 * TICKS_PER_MM - 1) / TICKS_PER_MM))}`);

// ------------------------------------------------- where JavaScript's numbers give out
//
// Lengths never reach the boundary in practice. Money does: a quote is minor currency
// units, and a large enough shipment at a large enough rate multiplies past `2^53 - 1`,
// after which a JavaScript number is no longer exact and `n + 1 === n` becomes possible.
//
// The engine refuses rather than returning a rounded price. A wrong number that looks
// right is the worst outcome available here — it would be invoiced.

const document = {
  tariffs: [{
    carrier_id: 'acme',
    service_id: 'ground',
    versions: [{
      effective_at: 0,
      dimensional_weight_divisor: 1,
      cost_per_dimensional_kg_minor: { 'zone-a': 1_000_000 },
      minimum_charge_minor: 0,
      fuel_surcharge_permille: 0,
      accessorials: [],
    }],
  }],
};

const quote = (volumeMm3) => commerce.quote(document, {
  carrier_id: 'acme', service_id: 'ground', zone: 'zone-a',
  as_of: 0, actual_weight_g: 0, volume_mm3: volumeMm3,
});

console.log('\nwhere JavaScript stops being exact');
console.log(`  Number.MAX_SAFE_INTEGER = ${Number.MAX_SAFE_INTEGER}  (2^53 - 1)`);
console.log(`  and past it: 2^53 + 1 === 2^53 is ${2 ** 53 + 1 === 2 ** 53}`);

for (const volume of [10 ** 12, 10 ** 15]) {
  try {
    const answer = quote(volume);
    console.log(`  volume ${String(volume).padEnd(16)} -> ${answer.quote.total_minor} minor units`);
  } catch (error) {
    if (!(error instanceof CommerceInputError)) throw error;
    console.log(`  volume ${String(volume).padEnd(16)} -> refused: ${error.message}`);
  }
}

// The refusal is the contract working, not the binding failing: an answer this engine
// cannot represent exactly is one it declines to give.
//
// The check lives here and nowhere else — `commerce-model.js` is the only file in the
// suite that carries it — because `2^53` is a property of this language's number type
// rather than of the contract. What the Python and PHP engines return for the same
// request is their own business and is not asserted here; if you need a number this large
// to survive, do not read it out of a JavaScript `Number`.
