import assert from 'node:assert/strict';
import test from 'node:test';

import { packFallback } from '../fallback.js';

/**
 * Exact-small's floors against `convex_hull` items.
 *
 * The score counts the solid a hull occupies, so the capacity, unused-volume and height
 * floors must too. Built from declared box volumes they pruned a feasible packing and left
 * the early exit unreachable; both cases are pinned by counted work, never by the clock.
 */

const LONG_ENOUGH_MS = 300_000;

const vertex = ([x, y, z]) => ({ x: String(x), y: String(y), z: String(z) });

const hull = (id, [length, width, height], corners) => ({
  id, quantity: 1,
  dimensions: { length: String(length), width: String(width), height: String(height) },
  shape_type: 'convex_hull', hull_vertices: corners.map(vertex),
});

const cuboid = (id, length, width, height) => ({
  id, quantity: 1,
  dimensions: { length: String(length), width: String(width), height: String(height) },
});

/** An octagonal-prism jar 80 x 80 x 100 mm: its solid is well short of its box. */
const octagonalJar = () => {
  const ring = [[23, 0], [57, 0], [80, 23], [80, 57], [57, 80], [23, 80], [0, 57], [0, 23]];
  return hull('jar3', [80, 80, 100], [0, 100].flatMap((z) => ring.map(([x, y]) => [x, y, z])));
};

const exactSmallOnly = (maxSearchNodes) => ({
  solvers: ['exact_small'], solver_profile: 'exact_small', time_limit_ms: LONG_ENOUGH_MS,
  // One ordering: these count one exact search's nodes.
  multi_start_orders: 1,
  effort_budget: {
    max_candidates_evaluated: 1_000_000, max_placement_attempts: 1_000_000,
    max_search_nodes: maxSearchNodes,
  },
});

test('exact-small seats two wedges whose boxes each fill the crate in one crate', () => {
  // Counted by box volume each wedge claimed the whole crate, so the capacity floor said
  // only one could ever be placed and the search opened a second crate.
  const result = packFallback({
    units: { length: 'mm' },
    configuration: exactSmallOnly(1_000),
    items: [
      hull('wedge-lower', [100, 100, 100],
        [[0, 0, 0], [100, 0, 0], [0, 100, 0], [0, 0, 100], [100, 0, 100], [0, 100, 100]]),
      hull('wedge-upper', [100, 100, 100],
        [[100, 100, 0], [100, 0, 0], [0, 100, 0], [100, 100, 100], [100, 0, 100], [0, 100, 100]]),
    ],
    containers: [{ id: 'crate', inner_dimensions: { length: '100', width: '100', height: '100' } }],
  });

  assert.equal(result.complete, true);
  assert.equal(result.containers.length, 1);
  assert.deepEqual(result.score, [0, 1, 0, 0, 1_000_000]);
});

test('exact-small reaches its floor on a mailer order with a jar inside a counted budget', () => {
  // The unused-volume floor summed the jar's box while the score counts its solid, so the
  // floor sat below every reachable score and the search walked 89 thousand nodes before
  // the fix. The first complete branch already meets the floor.
  const result = packFallback({
    units: { length: 'mm' },
    configuration: exactSmallOnly(1_000),
    items: [
      cuboid('phonecase0', 180, 100, 25), cuboid('socks1', 200, 100, 40),
      cuboid('tshirt2', 280, 200, 30), octagonalJar(), cuboid('mugbox4', 120, 100, 110),
    ],
    containers: [{ id: 'frame', quantity: 1, inner_dimensions: { length: '610', width: '480', height: '300' } }],
  });

  assert.equal(result.complete, true);
  assert.equal(result.algorithm.effort_limit_reached, false);
  assert.equal(result.algorithm.metrics.search_nodes_expanded, 6);
  assert.deepEqual(result.score, [0, 1, 0, 945_535, 333_333]);
});
