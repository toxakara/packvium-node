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

import { pack } from '../index.js';

const MM = { units: { length: 'mm' } };

/**
 * Pack one variant and print what it cost.
 *
 * Both numbers matter. A constraint only sometimes shows up as a refusal; more often the
 * solver satisfies it by opening another container, which costs money and is the outcome
 * you actually wanted to see coming.
 */
const solve = (label, items, containers) => {
  const result = pack({ ...MM, items, containers });
  const placed = result.containers.reduce((n, c) => n + c.placements.length, 0);
  console.log(
    `  ${label.padEnd(20)} ${result.containers.length} container(s), ` +
    `${placed} placed, ${result.unpacked_items.length} refused`,
  );
  for (const unpacked of result.unpacked_items) {
    console.log(`      ${unpacked.item_id.padEnd(12)} ${unpacked.reason}`);
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
// `proof` carries the observations behind it. Render your own wording from the code —
// the strings here are the contract's, not a message meant for your customer.
