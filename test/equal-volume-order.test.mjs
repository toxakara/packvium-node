import assert from 'node:assert/strict';
import test from 'node:test';

import { packFallback } from '../fallback.js';

/**
 * Equal-volume ties and the `quality` layer start.
 *
 * Cartons and drums have the same volume and the same longest edge, and neither may carry
 * anything. Only the drums, the heavier of the two, leave room for every carton: they
 * cannot stand on the pallets, the cartons can. Pinned by counted work, never by the clock.
 */

const cube = (id, quantity, height, weight, extra) => ({
  id, quantity, weight,
  dimensions: { length: '100', width: '100', height: String(height) },
  ...extra,
});

const scene = (solverProfile, names = { carton: 'carton', drum: 'drum' }) => ({
  units: { length: 'mm' },
  configuration: {
    solver_profile: solverProfile, time_limit_ms: 300_000, minimum_support_ratio: 1,
    effort_budget: {
      max_candidates_evaluated: 1_000_000, max_placement_attempts: 1_000_000,
      max_search_nodes: 1_000_000,
    },
  },
  items: [
    cube('pallet', 2, 110, '40', { stacking_group: 'A', accepts_stacking_groups: ['A', 'B'] }),
    cube(names.carton, 2, 100, '10', { stacking_group: 'B', stackable: false }),
    cube(names.drum, 2, 100, '20', { stacking_group: 'C', stackable: false }),
  ],
  containers: [
    { id: 'bay', quantity: 1, inner_dimensions: { length: '320', width: '100', height: '210' } },
  ],
});

test('an equal-volume tie goes to the heavier item, not the earlier id', () => {
  // Renamed so that the carton sorts after the drum: the answer must not move.
  for (const names of [{ carton: 'carton', drum: 'drum' }, { carton: 'zcarton', drum: 'drum' }]) {
    const result = packFallback(scene('balanced', names));
    assert.equal(result.summary.packed_item_count, 5, JSON.stringify(names));
  }
});

test('quality packs the tie as well as balanced does', () => {
  const quality = packFallback(scene('quality'));
  assert.equal(quality.summary.packed_item_count, 5);
  assert.deepEqual(quality.score, packFallback(scene('balanced')).score);
});

test('the quality layer start keeps its own base-area order', () => {
  const pinned = scene('quality');
  pinned.configuration.solvers = ['layer'];
  const result = packFallback(pinned);
  assert.equal(result.algorithm.solver, 'layer:javascript_fallback');
  assert.equal(result.summary.packed_item_count, 5);
});
