import assert from 'node:assert/strict';
import test from 'node:test';

import { __additionalContainerBoundForTests as additionalContainerBound } from '../fallback.js';

/**
 * The container-plan bound against `convex_hull` items.
 *
 * Two wedges that fill one crate between them have boxes worth two crates. Counted by box,
 * the bound said a second crate was unavoidable and ranked the plan as if it already held it.
 */

const wedge = (upper) => {
  const base = upper ? [[100, 100], [100, 0], [0, 100]] : [[0, 0], [100, 0], [0, 100]];
  return {
    d: [100, 100, 100], w: 1, nesting: null, rots: ['LWH'], shapeType: 'convex_hull',
    hullVertices: [0, 100].flatMap((z) => base.map(([x, y]) => [x, y, z])),
  };
};
const crate = { id: 'crate', d: [100, 100, 100], max: null };

test('a wedge pair needs one more crate, not two', () => {
  const plan = { remaining: [wedge(false), wedge(true)], inventory: new Map([['crate', 2]]) };
  assert.equal(additionalContainerBound(plan, [crate]), 1);
});

test('a cuboid still counts its whole box', () => {
  const cube = { d: [100, 100, 100], w: 1, nesting: null, rots: ['LWH'], shapeType: 'rigid_cuboid' };
  const plan = { remaining: [cube, cube], inventory: new Map([['crate', 2]]) };
  assert.equal(additionalContainerBound(plan, [crate]), 2);
});
