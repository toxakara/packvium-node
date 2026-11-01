import assert from 'node:assert/strict';
import test from 'node:test';

import { packFallback } from '../fallback.js';

const mm = (length, width = length, height = length) => ({
  length: String(length), width: String(width), height: String(height),
});
const request = (containers) => ({
  units: { length: 'mm' },
  configuration: { solver_profile: 'fast', solvers: ['extreme_points'], time_limit_ms: 300000,
    max_containers: 1, objective: 'shipping_cost', dimensional_weight_divisor: 5000,
    dimensional_weight_length_unit: 'cm', dimensional_weight_weight_unit: 'kg',
    effort_budget: { max_candidates_evaluated: 1000000, max_placement_attempts: 1000000,
      max_search_nodes: 1000000 } },
  items: [{ id: 'cube', dimensions: mm(10) }],
  containers,
});

test('shipping selection ranks gross billed weight before the purchase cost', () => {
  const result = packFallback(request([
    { id: 'heavy', inner_dimensions: mm(10), tare_weight: '1000', cost_minor: 0 },
    { id: 'light', inner_dimensions: mm(10), tare_weight: '1', cost_minor: 100 },
  ]));
  assert.equal(result.containers[0].container_type, 'light');
  assert.deepEqual(result.score, [0, 8000000, 1, 0, 1000000]);
});

test('shipping selection bills the outer dimensions of a rigid container', () => {
  const result = packFallback(request([
    { id: 'bulky', inner_dimensions: mm(10), outer_dimensions: mm(100), cost_minor: 0 },
    { id: 'small', inner_dimensions: mm(10), cost_minor: 100 },
  ]));
  assert.equal(result.containers[0].container_type, 'small');
  assert.deepEqual(result.score, [0, 1600000, 1, 0, 1000000]);
});

test('shipping selection bills a flat bag on its achieved dimensions', () => {
  const result = packFallback(request([
    { id: 'rigid', inner_dimensions: mm(20), cost_minor: 0 },
    { id: 'bag', inner_dimensions: mm(100), deformable_boundary: { kind: 'flat_bag' }, cost_minor: 100 },
  ]));
  assert.equal(result.containers[0].container_type, 'bag');
  assert.deepEqual(result.score, [0, 1600000, 1, 999000, 100000]);
});

test('shipping selection bills the fabricated box rather than its machine maximum', () => {
  const result = packFallback(request([
    { id: 'stock', inner_dimensions: mm(20), cost_minor: 0 },
    { id: 'machine', inner_dimensions: mm(100), cost_minor: 100,
      made_to_measure: { minimum: mm(10), increment: mm(10), outer_allowance: mm(1) } },
  ]));
  assert.equal(result.containers[0].container_type, 'machine');
  assert.deepEqual(result.score, [0, 2129600, 1, 0, 1000000]);
});

test('shipping selection keeps placing more items ahead of a lighter incomplete trial', () => {
  const data = request([
    { id: 'single', inner_dimensions: mm(10), tare_weight: '1' },
    { id: 'double', inner_dimensions: mm(20, 10, 10), tare_weight: '1000' },
  ]);
  data.items[0].quantity = 2;
  const result = packFallback(data);
  assert.equal(result.containers[0].container_type, 'double');
  assert.equal(result.complete, true);
});
