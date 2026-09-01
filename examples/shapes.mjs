/**
 * Shapes: when an item is not its box.
 *
 * Run it:
 *
 *     node examples/shapes.mjs
 *
 * Every other example treats an item as the box it declares. That is the default and it
 * is right for almost everything, because a carton *is* a cuboid. Two kinds of goods are
 * not: a moulded or tapered part that leaves a usable void beside it, and a soft one that
 * gives way under whatever is stacked on it.
 *
 * `shape_type` narrows the box in one direction each -- `convex_hull` in space,
 * `compressible` in height under load -- and neither is ever inferred. An engine that
 * quietly packed a hull as its bounding box would return a plan that validates and does
 * not physically fit, so the value must be asked for.
 *
 * These fields are part of the shared request contract, so the same document runs
 * unchanged against the Python, PHP and Rust engines. It does not follow that all four
 * print the same numbers -- see the note on the compressible section below, which is the
 * more useful half of the lesson.
 */

import { pack } from '../index.js';

const MM = { units: { length: 'mm' } };
const crate = (length, width, height) => [
  { id: 'crate', inner_dimensions: { length, width, height } },
];

/** Run one request and print only what the shape changed: containers and refusals. */
const summarise = (label, request) => {
  const result = pack({ ...MM, ...request });
  const placed = result.containers.reduce((n, c) => n + c.placements.length, 0);
  console.log(
    `  ${label.padEnd(22)} ${result.status.padEnd(10)} ` +
    `${result.containers.length} container(s), ${placed} placed, ` +
    `${result.unpacked_items.length} refused`,
  );
};

// ------------------------------------------------------------------ convex_hull
//
// Two triangular prisms, each cut from the same 100 mm cube along the diagonal. Their
// bounding boxes are identical and fill the crate on their own, so as cuboids the second
// one has nowhere to go. As hulls they are complementary halves and share the crate
// exactly -- the collision test is an exact integer separating-axis test on the vertices,
// not a box overlap.
//
// The hull is given in the item's own coordinates, in the request's length unit, and must
// fit inside the declared dimensions. It is not a replacement for them: the box still
// bounds the item, the hull only says how much of that box is solid.

const LOWER_WEDGE = [
  { x: '0', y: '0', z: '0' }, { x: '100', y: '0', z: '0' },
  { x: '0', y: '100', z: '0' }, { x: '0', y: '0', z: '100' },
  { x: '100', y: '0', z: '100' }, { x: '0', y: '100', z: '100' },
];
const UPPER_WEDGE = [
  { x: '100', y: '100', z: '0' }, { x: '100', y: '0', z: '0' },
  { x: '0', y: '100', z: '0' }, { x: '100', y: '100', z: '100' },
  { x: '100', y: '0', z: '100' }, { x: '0', y: '100', z: '100' },
];

const wedge = (id, vertices) => ({
  id,
  quantity: 1,
  dimensions: { length: '100', width: '100', height: '100' },
  weight: { value: '1', unit: 'kg' },
  ...(vertices ? { shape_type: 'convex_hull', hull_vertices: vertices } : {}),
});

console.log('convex_hull -- two complementary wedges cut from one cube');
summarise('as cuboids', {
  items: [wedge('wedge-lower', null), wedge('wedge-upper', null)],
  containers: crate('100', '100', '100'),
});
summarise('as hulls', {
  items: [wedge('wedge-lower', LOWER_WEDGE), wedge('wedge-upper', UPPER_WEDGE)],
  containers: crate('100', '100', '100'),
});

// One crate instead of two, for the same goods and the same crate. Nothing about the
// request changed except the claim that the items are wedges rather than blocks.

// ----------------------------------------------------------------- compressible
//
// `compression_ratio` is the fraction of its own height an item may lose when something
// rests on it -- 0.25 means it can give up a quarter. The mass above it is what decides
// how much it actually gives, so the occupied height of a compressible item is not a
// property of the item alone; it depends on what the solver put on top.
//
// `max_compression_pressure_kpa` is the other half of the same field. Past that pressure
// the item is not compressed further, it is crushed, and the load is refused instead.
//
// Note `must_be_on_floor` on the cushion. Without it the solver is free to put the brick
// underneath, nothing bears on the cushion, and the feature never engages -- which is the
// honest reason the rule is here and not an incidental detail of the example.

const cushion = (crushKpa) => ({
  id: 'cushion',
  quantity: 1,
  dimensions: { length: '100', width: '100', height: '100' },
  weight: { value: '2', unit: 'kg' },
  must_be_on_floor: true,
  shape_type: 'compressible',
  compression_ratio: 0.25,
  max_compression_pressure_kpa: crushKpa,
});

const brick = (kilograms) => ({
  id: 'brick',
  quantity: 1,
  dimensions: { length: '100', width: '100', height: '100' },
  weight: { value: String(kilograms), unit: 'kg' },
});

/** One crate, one cushion, one brick -- only the brick's mass changes. */
const load = (label, kilograms) => {
  const result = pack({
    ...MM,
    items: [cushion(100), brick(kilograms)],
    containers: crate('100', '100', '200'),
  });
  console.log(
    `  ${label.padEnd(22)} ${result.containers.length} container(s), ` +
    `unused volume ${result.score[3]} ppm`,
  );
};

// The crate is 100x100x200 and the two items are 100 mm cubes, so rigidly they fill it
// exactly and nothing is unused. At 102 kg the brick crosses 100 kPa over the cushion's
// 0.01 m^2 face: the stack is refused, the brick opens a second crate, and half of each
// crate is empty.
//
// At 101 kg this engine also opens two crates -- and the Python, PHP and Rust engines
// return one, with the cushion compressed. Both answers are valid: every item is placed,
// no rule is broken, and an independent validator accepts each. This one is simply worse,
// and it is recorded as such in the suite's quality budget rather than left to be
// discovered here.
//
// That is the guarantee, stated exactly. What the shared contract fixes is the request
// shape, the validity rules and the objective vector -- not which of several valid
// arrangements a given engine finds. An engine may return a worse-scoring valid packing;
// none may return an invalid one. If you need the best answer these fields can give,
// solve on the Rust or Python engine and treat the JavaScript fallback as the portable
// one.
console.log('\ncompressible -- a cushion that yields to the load above it');
load('brick 101 kg', 101);
load('brick 102 kg', 102);

// Both shapes are refused rather than approximated wherever an engine cannot honour them
// exactly -- a hull on a route, a hull under a configured clearance, a compressible item
// with `nesting_height`. A wrong answer that validates is worse than a refusal that does
// not, which is the whole reason these are opt-in.
