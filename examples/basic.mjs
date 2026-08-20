/**
 * Pack an order, read the placements, and see why anything was refused.
 *
 * Run it:
 *
 *     node examples/basic.mjs
 *
 * `@packvium/engine` takes and returns the same JSON contract every Packvium
 * implementation speaks, so a request you build here also works against the Python CLI,
 * the PHP CLI or the Rust core, and comes back with the same answer.
 *
 * The package prefers the compiled N-API addon when `@packvium/native` is installed and
 * falls back to a deterministic JavaScript engine otherwise. You do not choose, and you
 * do not need to: `backend()` reports which one answered, and both answer the same.
 */

import { backend, pack, version } from '../index.js';

console.log(`engine ${version()} using the ${backend()} backend\n`);

const request = {
  items: [
    // Lengths and weights are strings on purpose. They are parsed into exact integers,
    // so '0.1' means a tenth of a millimetre and never 0.09999999999999999. Plain
    // integers and fractions like '3/16' work too.
    { id: 'mug', quantity: 6, dimensions: { length: '120', width: '120', height: '100' }, weight: '400 g' },
    { id: 'plate', quantity: 8, dimensions: { length: '260', width: '260', height: '20' }, weight: '600 g' },
    // Too long for the box in every orientation, so it cannot be placed.
    { id: 'ladder', quantity: 1, dimensions: { length: '1800', width: '300', height: '100' }, weight: '6 kg' },
  ],
  containers: [
    {
      id: 'box',
      inner_dimensions: { length: '400', width: '400', height: '400' },
      max_payload: '15 kg',
      cost_minor: 180,
    },
  ],
};

const result = pack(request);

console.log(`status: ${result.status}`);
console.log(`containers opened: ${result.containers.length}`);

for (const [index, container] of result.containers.entries()) {
  console.log(`\nbox #${index + 1}: ${container.placements.length} placement(s), ` +
    `${container.volume_utilization} of the volume used`);
  for (const placement of container.placements) {
    // Every measurement arrives as { ticks, value, unit }: `ticks` is the exact integer
    // the engine reasoned about, `value` is that same number written for a human.
    const { x, y, z } = placement.position;
    console.log(
      `  ${placement.item_type.padEnd(8)} at (${x.value}, ${y.value}, ${z.value}) ${x.unit}` +
      `  orientation ${placement.orientation}`,
    );
  }
}

// A refusal is an answer, not an error. Each entry says which instance was refused and
// the structured reason, so you can act on it rather than re-guessing.
if (result.unpacked_items.length > 0) {
  console.log('\nnot packed:');
  for (const unpacked of result.unpacked_items) {
    console.log(`  ${unpacked.item_id.padEnd(10)} ${unpacked.reason}`);
  }
}
