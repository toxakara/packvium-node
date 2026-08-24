/**
 * Objectives: six ways to be "best", and the scenes where they disagree.
 *
 * Run it:
 *
 *     node examples/objectives.mjs
 *
 * Every solve returns the arrangement that scores best -- but "best" is a choice, and it
 * is the one setting most likely to make the library look wrong when it is merely
 * answering a different question than you meant to ask. This example builds scenes where
 * two objectives genuinely pick different containers, so the difference is visible
 * rather than asserted.
 *
 * The score is always a lexicographic array of exact integers, never a float, and its
 * first key is always the unpacked count: no objective will ever leave an item behind to
 * save money. The same request handed to the Python, PHP or Rust engine prints the same
 * vector.
 */

import { pack } from '../index.js';

const widgets = [{
  id: 'widget', quantity: 8,
  dimensions: { length: '100', width: '100', height: '100' },
  weight: '500 g',
}];

const solve = (configuration, containers) => {
  const result = pack({ units: { length: 'mm' }, configuration, items: widgets, containers });
  const chosen = result.containers.length > 0 ? result.containers[0].container_type : 'none';
  return `${chosen.padEnd(6)} score=${JSON.stringify(result.score)}`;
};

const box = (id, side, extra = {}) => ({
  id,
  inner_dimensions: { length: side, width: side, height: side },
  max_payload: '20 kg',
  ...extra,
});

const weightPricing = {
  dimensional_weight_divisor: 5000,
  dimensional_weight_length_unit: 'cm',
  dimensional_weight_weight_unit: 'kg',
};

const snug = box('snug', '300', { cost_minor: 500 });
const roomy = box('roomy', '400', { cost_minor: 150 });

// `default` -- fewest containers, then tightest fit. What you want when the boxes are
// interchangeable and you are simply trying not to open another one.
console.log('default             ', solve({ seed: 42 }, [snug, roomy]));

// `lowest_cost` -- the cheapest *packaging*. `cost_minor` is what the box costs you, so
// this is the objective for a warehouse buying cartons, not a shipper paying a carrier.
console.log('lowest_cost         ', solve({ seed: 42, objective: 'lowest_cost' }, [snug, roomy]));

// `shipping_cost` -- carrier-billable *weight*: the greater of actual gross weight and
// dimensional weight. A big light box can bill more than a small heavy one, which is why
// this is not the same objective as `lowest_cost`. It needs a divisor and refuses rather
// than guessing one, because a wrong divisor silently misprices every shipment.
console.log('shipping_cost       ',
  solve({ seed: 42, objective: 'shipping_cost', ...weightPricing }, [snug, roomy]));

// `lowest_landed_cost` -- carrier-billable *money*, with the rate card arriving as
// request data. Weight and money do not always agree: a bracket step, or a minimum
// charge, can make the cheaper shipment the heavier one. Below the roomy box bills
// heavier (12,800 g of dimensional weight against the snug box's 5,400) and still costs
// less, because the snug box's carrier charges a steep first bracket.
const dearPerGram = box('snug', '300', {
  rate_table: { weight_brackets_g: [6000, 20000], prices_minor: [2400, 3100] },
});
const cheapPerGram = box('roomy', '400', {
  rate_table: { weight_brackets_g: [6000, 20000], prices_minor: [900, 1500] },
});
const byMoney = { seed: 42, objective: 'lowest_landed_cost', ...weightPricing };
console.log('lowest_landed_cost  ', solve(byMoney, [dearPerGram, cheapPerGram]));

// A rate card that stops short of the shipment is a refusal, never a silent clamp to the
// top bracket -- you would otherwise be quoted a price the carrier never published.
const tooNarrow = box('roomy', '400', {
  rate_table: { weight_brackets_g: [2000], prices_minor: [900] },
});
try {
  solve(byMoney, [tooNarrow]);
} catch (refusal) {
  console.log('lowest_landed_cost* ', `refused: ${refusal.message}`);
}

// `open_dimension_height` -- pack into the shortest stack, for a lidless container or a
// pallet that has to clear a doorway.
console.log('open_dimension_height',
  solve({ seed: 42, objective: 'open_dimension_height' }, [snug, roomy]));

// `maximum_value` -- when not everything fits, leave the *cheap* things behind. It orders
// by value; it does not solve the knapsack problem to optimality. `quantity: 1` on the
// container is what makes it a choice at all -- with an unlimited supply the packer
// simply opens another box.
const scarce = pack({
  units: { length: 'mm' },
  configuration: { seed: 42, objective: 'maximum_value' },
  items: [
    { id: 'gold', quantity: 2, dimensions: { length: '100', width: '100', height: '100' }, weight: '500 g', value: 90000 },
    { id: 'gravel', quantity: 2, dimensions: { length: '100', width: '100', height: '100' }, weight: '500 g', value: 10 },
  ],
  containers: [{
    id: 'tiny', quantity: 1,
    inner_dimensions: { length: '200', width: '100', height: '100' },
    max_payload: '20 kg',
  }],
});
const kept = scarce.containers.flatMap((c) => c.placements.map((p) => p.item_type)).sort();
const left = (scarce.unpacked_items ?? []).map((u) => u.item_type ?? u.item_id).sort();
console.log('maximum_value       ', `packed=${JSON.stringify(kept)} left behind=${JSON.stringify(left)}`);
