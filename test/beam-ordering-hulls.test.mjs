import assert from 'node:assert/strict';
import test from 'node:test';

import { packFallback } from '../fallback.js';

/**
 * The `quality` beam's ordering bound against `convex_hull` items.
 *
 * The bound compares the future items' volumes with the occupied free space, and a hull
 * occupies its own solid. Counted by declared box, every wedge claimed a whole cube cell,
 * so a branch keeping room for wedge pairs looked unable to place them and lost its place
 * in the beam. Pinned by counted work, never by the clock.
 */

const vertex = ([x, y, z]) => ({ x: String(x), y: String(y), z: String(z) });

const wedge = (id, quantity, upper) => {
  const base = upper ? [[100, 100], [100, 0], [0, 100]] : [[0, 0], [100, 0], [0, 100]];
  return {
    id, quantity, weight: '1 kg',
    dimensions: { length: '100', width: '100', height: '100' },
    shape_type: 'convex_hull',
    hull_vertices: [0, 100].flatMap((z) => base.map(([x, y]) => vertex([x, y, z]))),
  };
};

const cuboid = (id, quantity, length, width, height) => ({
  id, quantity, weight: '500 g',
  dimensions: { length: String(length), width: String(width), height: String(height) },
});

test('the quality beam keeps room for wedge pairs whose boxes overflow the crate', () => {
  // Six cube cells. Four wedge pairs fill four of them exactly, so ten of the thirteen
  // items fit; ranked by box volume the beam settled for nine.
  const result = packFallback({
    units: { length: 'mm' },
    configuration: {
      solver_profile: 'quality', time_limit_ms: 600_000, max_containers: 1,
      effort_budget: {
        max_candidates_evaluated: 10_000_000, max_placement_attempts: 10_000_000,
        max_search_nodes: 10_000_000,
      },
    },
    items: [
      wedge('lower', 4, false), wedge('upper', 4, true),
      cuboid('cube', 3, 100, 100, 100), cuboid('slab', 2, 200, 100, 50),
    ],
    containers: [{
      id: 'crate', quantity: 1,
      inner_dimensions: { length: '300', width: '200', height: '100' },
    }],
  });

  assert.equal(result.termination.any_start_truncated, false);
  assert.deepEqual(result.score, [3, 1, 0, 0, 1_000_000]);
});
