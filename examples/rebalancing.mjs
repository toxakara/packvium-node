/**
 * Rebalancing: even out the weight between containers that are already packed.
 *
 * Run it:
 *
 *     node examples/rebalancing.mjs
 *
 * `pack` fills containers to use as few as it can, and nothing in that goal cares whether
 * one crate weighs 41 kg and the other 1 kg. A person lifting them does, and so does a
 * pallet or a trailer with a weight limit per position.
 *
 * `rebalanceWeight(request, result)` is a separate, opt-in step. It moves whole items
 * between the containers of a finished result to narrow the spread of payload weights,
 * and it never runs unless you call it. Each move is checked against every rule the
 * request states before it is kept, so the rebalanced result is still a valid packing.
 */

import { pack, rebalanceWeight } from '../index.js';

const request = {
  units: { length: 'mm' },
  configuration: {
    // Counted work decides where the search stops; the wall clock is only a safety fuse.
    effort_budget: { max_candidates_evaluated: 1000000 },
    time_limit_ms: 60000,
  },
  items: [
    { id: 'anvil', quantity: 2, weight: '20 kg', dimensions: { length: '300', width: '300', height: '300' } },
    { id: 'pillow', quantity: 4, weight: '500 g', dimensions: { length: '300', width: '300', height: '300' } },
  ],
  containers: [
    { id: 'crate', quantity: 2, max_payload: '50 kg',
      inner_dimensions: { length: '1200', width: '300', height: '300' } },
  ],
};

const describe = (containers) => {
  for (const container of containers) {
    const contents = container.placements.map((placement) => placement.item_type).join(', ');
    console.log(`    ${container.id}  ${container.payload_weight.value.padStart(5)} ` +
      `${container.payload_weight.unit}   ${contents}`);
  }
};

const result = pack(request);
console.log('as packed:');
describe(result.containers);

const rebalanced = rebalanceWeight(request, result);
console.log(`\nrebalanced (improved: ${rebalanced.improved}):`);
describe(rebalanced.containers);

console.log('\nmoves:');
for (const move of rebalanced.moves) {
  console.log(`    ${move.item_id} from ${move.from_container_id} to ${move.to_container_id}`);
}

// `maxMoves` bounds the work. Zero asks for none, and returns the result unchanged.
const untouched = rebalanceWeight(request, result, { maxMoves: 0 });
console.log(`\nwith maxMoves: 0 -> improved: ${untouched.improved}, ${untouched.moves.length} moves`);

console.log('\nThe container count and every item stay the same; only who carries what changes.');
console.log('An empty move list means no move made the spread strictly narrower and stayed valid.');
