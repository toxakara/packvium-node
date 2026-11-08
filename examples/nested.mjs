/**
 * Nested packing: items into cartons, cartons onto a pallet, in one call.
 *
 * Run it:
 *
 *     node examples/nested.mjs
 *
 * Fulfilment is rarely one level. Units go into cartons and cartons go onto a pallet.
 * `packNested` runs the levels in order, each an ordinary request, and hands every packed
 * container of one level to the next as an item: upright, at its outer dimensions and its
 * gross weight, named by its container id. A level that lists no items packs what the
 * level before it handed up.
 *
 * The levels stay independent: a pallet never repacks a carton already taped shut. That
 * is exactly why the first answer for the cartons can be the wrong one for the pallet,
 * and `levelBeamWidth` is the remedy: it carries that many of the best carton sets up a
 * level, and the outermost level's score picks between them.
 */

import { packNested } from '../index.js';

const configuration = {
  // Counted work decides where the search stops; the wall clock is only a safety fuse.
  effort_budget: { max_candidates_evaluated: 1000000 },
  time_limit_ms: 60000,
};
const sides = (length, width, height) => ({ length, width, height });

const levels = [
  {
    name: 'carton',
    request: {
      units: { length: 'mm' }, configuration,
      items: [{ id: 'cube', quantity: 2, weight: '1 kg', dimensions: sides('100', '100', '100') }],
      // One long carton holds both cubes, so on its own it is the better carton level.
      containers: [
        { id: 'long', inner_dimensions: sides('200', '100', '100') },
        { id: 'single', inner_dimensions: sides('100', '100', '100') },
      ],
    },
  },
  {
    // A narrow, tall stand: two single cartons stack on it, the long carton does not fit
    // upright.
    name: 'pallet',
    request: {
      units: { length: 'mm' }, configuration, items: [],
      containers: [{ id: 'tower', inner_dimensions: sides('100', '100', '200') }],
    },
  },
];

for (const levelBeamWidth of [1, 2]) {
  console.log(`levelBeamWidth ${levelBeamWidth}`);
  for (const { name, result } of packNested({ levels, levelBeamWidth }).levels) {
    const used = result.containers.map((container) => container.id).join(', ') || 'none';
    console.log(`  ${name.padEnd(7)} complete ${String(result.complete).padEnd(5)} containers: ${used}`);
    for (const unpacked of result.unpacked_items) {
      console.log(`          left out: ${unpacked.item_id} (${unpacked.reason})`);
    }
  }
}

console.log(`
  Width 1 is the greedy chain: the long carton wins its own level and then cannot go on
  the tower. Width 2 carries both carton sets up, and the one the tower can finish wins.
  Each level runs at most levelBeamWidth x (container types + 1) packs, so a wider beam
  costs time in proportion to its width, never an exponential search.`);
