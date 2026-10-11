/**
 * The default minimum_support_ratio of 0 lets a placement rest on nothing, and says so.
 *
 * Mirrors `packvium-python/tests/test_unsupported_placements.py` and
 * `UnsupportedPlacementTest.php`. The warning is asserted whole because it is compared across
 * engines.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { packFallback } from '../fallback.js';

const FALLBACK_WARNING = 'JavaScript fallback is active; build the Rust addon for the native portfolio';
const warning = (count) => `unsupported_placements: ${count} placement(s) rest on nothing above the container floor; set configuration.minimum_support_ratio above 0 to require support`;

const cube = (id, quantity, height = '100') => ({
  id, quantity, weight: '500', dimensions: { length: '100', width: '100', height },
});
const fixed = (itemType, x, y, z) => ({
  item_type: itemType, container_type: 'crate', position: { x, y, z }, orientation: 'LWH',
});
// Two stacked bases, plus a slab in mid-air and a slab on an obstacle when floating.
const scene = ({ floating = true, configuration = {} } = {}) => ({
  items: [cube('base', 2), cube('loose', 4), ...(floating ? [cube('slab', 2, '50')] : [])],
  containers: [{
    id: 'crate', quantity: 1, inner_dimensions: { length: '400', width: '200', height: '400' },
    obstacles: [{ id: 'shelf', origin: { x: '200', y: '0', z: '0' },
      dimensions: { length: '100', width: '100', height: '100' } }],
  }],
  fixed_placements: [
    fixed('base', '0', '0', '0'), fixed('base', '0', '0', '100'),
    ...(floating ? [fixed('slab', '100', '100', '300'), fixed('slab', '200', '0', '100')] : []),
  ],
  configuration: {
    solver_profile: 'quality', alternatives: 3,
    effort_budget: { max_search_nodes: 20000 }, time_limit_ms: 60000, ...configuration,
  },
});
const unsupportedWarnings = (result) => result.warnings.filter((line) => line.startsWith('unsupported_placements:'));

test('a placement in mid-air and one on an obstacle are both counted, after the existing warning', () => {
  assert.deepEqual(packFallback(scene()).warnings, [FALLBACK_WARNING, warning(2)]);
});

test('every alternative carries its own warning', () => {
  const result = packFallback(scene());
  assert.ok(result.alternatives.length > 0);
  for (const alternative of result.alternatives) assert.deepEqual(unsupportedWarnings(alternative), [warning(2)]);
});

test('a fully supported packing has no warning', () => {
  assert.deepEqual(packFallback(scene({ floating: false })).warnings, [FALLBACK_WARNING]);
});

test('requiring support silences the warning', () => {
  const result = packFallback(scene({ floating: false, configuration: { minimum_support_ratio: 0.5 } }));
  assert.deepEqual(result.warnings, [FALLBACK_WARNING]);
});

test('a lattice answer is floor-up and never warns', () => {
  const result = packFallback({
    items: [cube('base', 8)],
    containers: [{ id: 'crate', inner_dimensions: { length: '200', width: '200', height: '200' } }],
    configuration: { require_placement_coordinates: false },
  });
  assert.ok(result.containers.some((container) => 'lattice_summary' in container));
  assert.deepEqual(result.warnings, [FALLBACK_WARNING]);
});
