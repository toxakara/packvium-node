/**
 * Limits: space you cannot use, and counts you may not exceed.
 *
 * Run it:
 *
 *     node examples/limits.mjs
 *
 * Not every limit is a dimension or a weight. A van has wheel arches, a tote conveyor
 * rejects a tote with too many pieces in it, a carrier caps lithium batteries per
 * package, and the shelf holds only so many cartons. Each is a field in the request:
 *
 * - `obstacles` on a container, with `additional_boxes` for a shape made of several boxes;
 * - `max_items` on a container: pieces per container, whatever their size;
 * - `tag_limits` on a container: pieces carrying a given tag, per container;
 * - `quantity` on a container, and `configuration.max_containers`: how many may be opened.
 *
 * The first three change *where* things go. The last two decide what happens when there
 * is nowhere left, and there the answer is an item left out, never an error.
 */

import { pack } from '../index.js';

const solve = (items, containers, configuration = {}) => pack({
  units: { length: 'mm' },
  configuration: {
    // Counted work decides where the search stops; the wall clock is only a safety fuse.
    effort_budget: { max_candidates_evaluated: 1000000 },
    time_limit_ms: 60000,
    ...configuration,
  },
  items,
  containers,
});

const summarize = (label, result) => {
  const counts = result.containers.map((container) => container.placements.length);
  console.log(`  ${label.padEnd(26)} ${result.containers.length} container(s) holding ` +
    `[${counts.join(', ')}], ${result.unpacked_items.length} left out`);
  for (const unpacked of result.unpacked_items) {
    console.log(`      ${unpacked.item_id.padEnd(11)} ${unpacked.reason}`);
  }
};

const rule = '='.repeat(78);
const section = (title) => console.log(`\n${rule}\n${title}\n${rule}`);

// ------------------------------------------------------------------------------------
section('1. Obstacles: wheel arches in the load space');

// Two arches, 400 long, 300 wide and 300 high, one against each side wall. They are one
// obstacle made of two boxes: `origin` and `dimensions` give the first, and each entry in
// `additional_boxes` adds another. Nothing may overlap any of them.
const arches = {
  id: 'wheel-arches',
  origin: { x: '800', y: '0', z: '0' },
  dimensions: { length: '400', width: '300', height: '300' },
  additional_boxes: [
    { origin: { x: '800', y: '900', z: '0' }, dimensions: { length: '400', width: '300', height: '300' } },
  ],
};
const van = { id: 'van', quantity: 1, inner_dimensions: { length: '1600', width: '1200', height: '800' } };
const crates = [{ id: 'crate', quantity: 12, weight: '10 kg',
  dimensions: { length: '400', width: '400', height: '400' } }];

for (const [label, container] of [['flat floor', van], ['with wheel arches', { ...van, obstacles: [arches] }]]) {
  const result = solve(crates, [container]);
  const floor = result.containers[0].placements.filter((placement) => placement.position.z.ticks === 0);
  console.log(`  ${label.padEnd(18)} ${result.summary.packed_item_count} crates, ` +
    `${floor.length} of them on the floor`);
  for (const placement of floor) {
    const { x, y } = placement.position;
    console.log(`      at x = ${x.value.padStart(4)}, y = ${y.value.padStart(4)} mm`);
  }
}
console.log('\n  The arches take two floor positions. One crate squeezes between them at');
console.log('  y = 300, and the other two go on top: all twelve still ship.');

// ------------------------------------------------------------------------------------
section('2. Counts per container: max_items and tag_limits');

const tote = { id: 'tote', cost_minor: 100, inner_dimensions: { length: '600', width: '400', height: '400' } };
const jars = [{ id: 'jar', quantity: 6, weight: '500 g',
  dimensions: { length: '100', width: '100', height: '150' } }];
summarize('six jars, no count limit', solve(jars, [tote]));
summarize('six jars, max_items: 4', solve(jars, [{ ...tote, max_items: 4 }]));

// A tag limit counts only the pieces carrying that tag; the chargers ride along freely.
const batteries = [
  { id: 'battery', quantity: 5, weight: '900 g', tags: ['lithium'],
    dimensions: { length: '150', width: '100', height: '80' } },
  { id: 'charger', quantity: 2, weight: '200 g',
    dimensions: { length: '100', width: '100', height: '50' } },
];
summarize('lithium: 2 per tote', solve(batteries, [{ ...tote, tag_limits: { lithium: 2 } }]));

// ------------------------------------------------------------------------------------
section('3. Running out of containers');

const lithiumOnly = [batteries[0]];
const limited = { ...tote, tag_limits: { lithium: 2 } };
summarize('unlimited totes', solve(lithiumOnly, [limited]));
summarize('only 2 totes in stock', solve(lithiumOnly, [{ ...limited, quantity: 2 }]));
summarize('max_containers: 2', solve(lithiumOnly, [limited], { max_containers: 2 }));

console.log('\n  `quantity` is stock of one container type; `max_containers` caps the whole');
console.log('  answer across every type. Either way one battery is left out, the result says');
console.log('  so, and nothing is thrown: a limit reached is an answer, not a bad request.');
console.log('  Which instance stays behind, and the reason code it is given, is the search\'s');
console.log('  own account and can differ between engines; that one is left out does not.');
