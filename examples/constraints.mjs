/**
 * Constraints: how to say "this may not go there", and how to read the refusal.
 *
 * Run it:
 *
 *     node examples/constraints.mjs
 *
 * Most real packing rules are refusals — this side up, nothing on top of that, keep the
 * chemicals away from the food — and the useful half of the answer is often the item that
 * did *not* fit and the reason it did not.
 *
 * Every rule below is a field on an item or a container. None of them needs a custom
 * class, none of them changes how you call `pack`, and every one is part of the shared
 * JSON contract, so the same request answers the same way from the Python, PHP and Rust
 * engines.
 */

import { explainUnpackedItem, pack } from '../index.js';

const MM = { units: { length: 'mm' } };
// An example must not change answer merely because the host was busy. `effort_budget`
// bounds the search by counted work, which is the same on every machine; the generous
// wall-clock value is only a safety fuse, so a loaded machine cannot cut the multi-start
// portfolio short and let a different start win. See examples/reproducibility.mjs.
const SAFETY_FUSE = {
  configuration: { time_limit_ms: 60000, effort_budget: { max_candidates_evaluated: 1000000 } },
};

/**
 * Pack one variant and print what it cost.
 *
 * Both numbers matter. A constraint only sometimes shows up as a refusal; more often the
 * solver satisfies it by opening another container, which costs money and is the outcome
 * you actually wanted to see coming.
 */
const solve = (label, items, containers) => {
  const result = pack({ ...MM, ...SAFETY_FUSE, items, containers });
  const placed = result.containers.reduce((n, c) => n + c.placements.length, 0);
  console.log(
    `  ${label.padEnd(20)} ${result.containers.length} container(s), ` +
    `${placed} placed, ${result.unpacked_items.length} refused`,
  );
  // `reason` is the stable code to branch on; `explainUnpackedItem` renders the same
  // structured reason and its proof as a sentence a person can read.
  for (const unpacked of result.unpacked_items) {
    console.log(`      ${unpacked.item_id.padEnd(12)} ${unpacked.reason}`);
    console.log(`      ${' '.repeat(12)} ${explainUnpackedItem(unpacked)}`);
  }
};

const shelf = [{ id: 'shelf', inner_dimensions: { length: '800', width: '400', height: '500' } }];

// ------------------------------------------------------------------ a plain refusal
//
// The ladder is longer than the shelf's longest inner edge in every orientation, so no
// solver can place it. The reason code says exactly that, and it is a fact about the
// request rather than a solver failure — which is why it is safe to show a customer.

console.log('a refusal that no solver can avoid');
solve('ladder + books',
  [{ id: 'ladder', quantity: 1, dimensions: { length: '1800', width: '300', height: '100' } },
   { id: 'book', quantity: 4, dimensions: { length: '210', width: '140', height: '30' } }],
  shelf);

// --------------------------------------------------------------- one rule at a time
//
// Each rule below is shown twice: same items, same container, once without it and once
// with it. A constraint you cannot watch change the answer is one the reader has to take
// on faith, and the pair makes the rule — rather than the geometry — provably the cause.

// `allowed_rotations` narrows the six orientations to the ones you permit, and
// `keep_upright` is the shorthand for "the item's own height stays vertical". The pole is
// 700 mm tall and the shelf 500 mm high, so it fits only lying down -- which both forbid.
// The refusal is `proven`: no permitted orientation fits any container on offer.
const pole = { length: '90', width: '90', height: '700' };
console.log('\nallowed_rotations / keep_upright — a pole that only fits lying down');
solve('without', [{ id: 'pole', quantity: 1, dimensions: pole, weight: '1 kg' }], shelf);
solve('allowed_rotations', [{ id: 'pole', quantity: 1, dimensions: pole, weight: '1 kg', allowed_rotations: ['LWH', 'WLH'] }], shelf);
solve('keep_upright', [{ id: 'pole', quantity: 1, dimensions: pole, weight: '1 kg', keep_upright: true }], shelf);

// `minimum_support_ratio` is how much of an item's base must rest on something solid.
// The plinth has to stand on the floor and covers only part of the ledge, so the slab's
// one place in the first ledge is perched on it. At 0.9 that is refused, and the price
// is a second ledge rather than a refusal.
const ledge = [{ id: 'ledge', inner_dimensions: { length: '400', width: '400', height: '350' } }];
const plinth = { id: 'plinth', quantity: 1, dimensions: { length: '200', width: '200', height: '300' },
  weight: { value: '5', unit: 'kg' }, must_be_on_floor: true };
const slab = (rule) => ({ id: 'slab', quantity: 1, dimensions: { length: '400', width: '400', height: '60' },
  weight: { value: '9', unit: 'kg' }, ...rule });

console.log('\nminimum_support_ratio — a slab perched on part of its base');
solve('without', [plinth, slab({})], ledge);
solve('with', [plinth, slab({ minimum_support_ratio: 0.9 })], ledge);

// `max_top_load` caps the weight resting on an item -- everything above it, not only the
// box touching it. Two 5 kg sacks on a crate of eggs is 10 kg; a 6 kg limit lets one stay
// and sends the other to a second column.
const narrow = [{ id: 'column', inner_dimensions: { length: '310', width: '310', height: '600' } }];
const eggs = (rule) => ({ id: 'egg-crate', quantity: 1, dimensions: { length: '300', width: '300', height: '200' },
  weight: { value: '1', unit: 'kg' }, must_be_on_floor: true, ...rule });
const sack = { id: 'rice-sack', quantity: 2, dimensions: { length: '300', width: '300', height: '150' },
  weight: { value: '5', unit: 'kg' } };

console.log('\nmax_top_load — what may rest on a crate of eggs');
solve('without', [eggs({}), sack], narrow);
solve('with', [eggs({ max_top_load: { value: '6', unit: 'kg' } }), sack], narrow);

const tin = { length: '150', width: '150', height: '120' };
const column = [{ id: 'column', inner_dimensions: { length: '160', width: '160', height: '600' } }];

// `max_stacked_items` caps how many units may sit above one item — a pallet-pattern rule
// ("three high, no more"), not a weight limit. The column is one tin wide, so height is
// the only way to fit more, and the second column is the price of the cap.
console.log('\nmax_stacked_items — five tins fit one column; three-high needs two');
solve('without', [{ id: 'tin', quantity: 5, dimensions: tin, weight: { value: '800', unit: 'g' } }], column);
solve('with', [{ id: 'tin', quantity: 5, dimensions: tin, weight: { value: '800', unit: 'g' }, max_stacked_items: 3 }], column);

// Tags are how two items refuse each other. `incompatible_tags` is checked both ways, so
// tagging one side is enough. Nothing asked for a second shelf — the tag did.
const bleach = (tags) => ({ id: 'bleach', quantity: 2,
  dimensions: { length: '120', width: '120', height: '300' }, weight: { value: '2', unit: 'kg' }, ...tags });
const flour = { id: 'flour', quantity: 3,
  dimensions: { length: '200', width: '150', height: '100' }, weight: { value: '1500', unit: 'g' }, tags: ['food'] };

console.log('\nincompatible_tags — hazmat and food cannot share a container');
solve('without', [bleach({}), flour], shelf);
solve('with', [bleach({ tags: ['hazmat'], incompatible_tags: ['food'] }), flour], shelf);

// `group` is atomic: every member ships in one container or none of them does. The third
// part is deliberately too long for the shelf, so it takes the other two down with it
// rather than shipping two thirds of an assembly nobody can use.
const parts = [{ length: '200', width: '200', height: '100' },
               { length: '200', width: '200', height: '100' },
               { length: '900', width: '100', height: '100' }];
const kit = (group) => parts.map((dimensions, n) => ({
  id: `kit-${n + 1}`, quantity: 1, dimensions, weight: { value: '2', unit: 'kg' }, ...group }));

console.log('\ngroup — one member cannot be placed, so none of them is');
solve('without', kit({}), shelf);
solve('with', kit({ group: 'assembly' }), shelf);

// Every reason code above is structured, not prose: `reason` is a stable identifier and
// `proof` carries the observations behind it. `explainUnpackedItem` turns both into the
// sentence printed under each code, and `explanationForUnpackedItem` returns the same
// sentence as a message key plus arguments, for when you render your own wording.
