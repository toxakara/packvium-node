/**
 * Trucking: a multi-drop van with one rear door and a limit on each axle.
 *
 * Run it:
 *
 *     node examples/trucking.mjs
 *
 * A parcel carton only has to hold its contents. A delivery van has three more rules, and
 * each is a field in the same request:
 *
 * - `stop_index` on an item says at which drop it leaves the van, lowest first;
 * - `access_directions` on the container names the walls it is unloaded through, so the
 *   solver can keep every earlier drop between the later ones and the door;
 * - `axles` puts two axles under the container, each with its own `max_load`, and the
 *   result reports how the gross weight divides between them.
 *
 * The packing is then turned into a loading order someone can follow at the dock:
 * `safeLoadingOrder` computes it from the placements, and `buildExecutionPlan` numbers
 * the steps.
 */

import { explainUnpackedItem, pack, safeLoadingOrder } from '../index.js';
import { buildExecutionPlan } from '../execution.js';

// The van: 3.6 m of floor, the cab at x = 0 and the rear door on the +x wall.
const van = (rule) => ({
  id: 'van',
  quantity: 1,
  inner_dimensions: { length: '3600', width: '1200', height: '1400' },
  max_payload: '1500 kg',
  access_directions: ['+x'],
  ...rule,
});

// Three drops. Pallets stand upright on the floor; the bakery also has two parcels.
const pallet = (id, stop, weight) => ({
  id, quantity: 1, weight, stop_index: stop, keep_upright: true, must_be_on_floor: true,
  dimensions: { length: '1100', width: '1100', height: '1000' },
});
const items = [
  pallet('bakery', 0, '350 kg'),
  pallet('cafe', 1, '250 kg'),
  pallet('kiosk', 2, '150 kg'),
  { id: 'parcel', quantity: 2, weight: '20 kg', stop_index: 0,
    dimensions: { length: '500', width: '400', height: '300' } },
];
const stopOf = Object.fromEntries(items.map((item) => [item.id, item.stop_index]));

const solve = (container) => pack({
  units: { length: 'mm' },
  configuration: {
    // Counted work decides where the search stops; the wall clock is only a safety fuse.
    effort_budget: { max_candidates_evaluated: 1000000 },
    time_limit_ms: 60000,
  },
  items,
  containers: [container],
});

/**
 * Axle loads arrive as exact fractions: `front_numerator / denominator` is a weight in
 * ticks (8,000,000 per gram). BigInt keeps the division exact; only the rounding to a tenth
 * of a kilogram is for display; the two exact values sum to the gross weight.
 */
const kilograms = (numerator, denominator) => {
  const perTenth = BigInt(denominator) * 8000000n * 100n;
  const tenths = (BigInt(numerator) + perTenth / 2n) / perTenth;
  return `${tenths / 10n}.${tenths % 10n} kg`;
};

const rule = '='.repeat(78);
const section = (title) => console.log(`\n${rule}\n${title}\n${rule}`);

// ------------------------------------------------------------------------------------
section('1. Route order: the last drop goes in first, nearest the cab');

const result = solve(van({}));
const [load] = result.containers;
console.log(`status: ${result.status}, ${load.placements.length} placed`);
for (const placement of load.placements) {
  const { x, z } = placement.position;
  console.log(`  stop ${stopOf[placement.item_type]}  ${placement.item_id.padEnd(10)} ` +
    `x = ${x.value.padStart(4)} mm, z = ${z.value} mm`);
}
console.log('\n  The door is on the +x wall, so x grows towards it. Drop 0 sits by the door,');
console.log('  drop 2 against the cab: at every stop, what leaves is in front of what stays.');

// ------------------------------------------------------------------------------------
section('2. A loading order the dock can follow');

// The sequence helpers take plain integer ticks, the numbers the solver reasoned with.
const boxes = load.placements.map(({ position: p, dimensions: d }) => ({
  origin: { x: p.x.ticks, y: p.y.ticks, z: p.z.ticks },
  dimensions: { length: d.length.ticks, width: d.width.ticks, height: d.height.ticks },
}));
const inside = load.inner_dimensions;
const order = safeLoadingOrder(
  boxes,
  { length: inside.length.ticks, width: inside.width.ticks, height: inside.height.ticks },
  // Through the same door the van is unloaded from.
  ['+x'],
);
const request = { units: { length: 'mm' }, items, containers: [van({})] };
const plan = buildExecutionPlan(request, result, { loadingOrders: { 0: order } });
console.log(`order: ${plan.containers[0].order}`);
for (const step of plan.containers[0].steps) {
  // A step cites its placement by type, orientation and exact position, never by a
  // display string. 16000 ticks are one millimetre.
  const { item_type: itemType, position_ticks: ticks } = step.placement;
  console.log(`  ${step.sequence}. ${itemType.padEnd(7)} to x = ${ticks.x / 16000} mm, y = ${ticks.y / 16000} mm`);
}
console.log('\n  Every step slides in through the door without passing anything already loaded.');
console.log('  Without `loadingOrders` the plan would say its order is `unavailable` rather');
console.log('  than guess one -- see examples/execution.mjs.');

// ------------------------------------------------------------------------------------
section('3. Axles: where the weight lands, and what a tighter limit refuses');

const axles = (rearLimit) => van({
  axles: [
    { position: '500', max_load: '600 kg' },
    { position: '2800', max_load: rearLimit },
  ],
});
for (const rearLimit of ['700 kg', '450 kg']) {
  const loaded = solve(axles(rearLimit));
  const reactions = loaded.containers[0].axle_reactions;
  console.log(`\n  rear axle limit ${rearLimit}: ${loaded.status}`);
  console.log(`    front axle carries ${kilograms(reactions.front_numerator, reactions.denominator)}`);
  console.log(`    rear axle carries  ${kilograms(reactions.rear_numerator, reactions.denominator)}`);
  for (const unpacked of loaded.unpacked_items) {
    console.log(`    left behind: ${unpacked.item_id} (${unpacked.reason})`);
    console.log(`      ${explainUnpackedItem(unpacked)}`);
  }
}
console.log('\n  The axle limit is enforced while packing, not checked afterwards: the bakery');
console.log('  pallet is heaviest and nearest the rear axle, so at 450 kg it stays behind.');
console.log('  There is no axle-specific reason code; the refusal says the search found no');
console.log('  legal place, and `axle_reactions` on the result is where to look for why.');
