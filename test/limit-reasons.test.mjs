import assert from 'node:assert/strict';
import test from 'node:test';

import { explainReason, packFallback } from '../fallback.js';

/**
 * One reason code per container, axle and stop limit, and: a
 * restart budget that changes the plan. Mirrors packvium-python/tests/test_limit_reasons.py;
 * the reason scenes are pinned across all four engines in conformance/unpacked-reasons/.
 */

const grams = (value) => ({ value, unit: 'g' });
const cube = (id, quantity, side = '10', fields = {}) => ({
  id, quantity, dimensions: { length: side, width: side, height: side }, ...fields,
});
const box = (length, width, height, fields = {}) => ({
  id: 'box', inner_dimensions: { length, width, height }, ...fields,
});
const axles = (front, rear) => [
  { position: '0', max_load: grams(front) }, { position: '100', max_load: grams(rear) },
];
const solve = (items, containers, configuration = {}) => packFallback({
  units: { length: 'mm' },
  configuration: { solver_profile: 'fast', time_limit_ms: 300_000, ...configuration },
  items, containers,
});
const reasons = (result) => result.unpacked_items
  .map((item) => [item.reason, item.proof.level]).sort();
const INVENTORY = [['container_inventory_exhausted', 'inferred']];

test('a limit a fresh container would lift is the inventory', () => {
  const cases = {
    quantity: [[cube('cube', 2)], [box('10', '10', '10', { quantity: 1 })], {}],
    max_containers: [[cube('cube', 2)], [box('10', '10', '10')], { max_containers: 1 }],
    max_items: [[cube('cube', 2)], [box('20', '20', '20', { quantity: 1, max_items: 1 })], {}],
    max_payload: [[cube('cube', 2, '10', { weight: grams('600') })],
      [box('20', '20', '20', { quantity: 1, max_payload: grams('1000') })], {}],
    tag_limits: [[cube('hazmat', 2, '10', { tags: ['hazmat'] })],
      [box('20', '20', '20', { quantity: 1, tag_limits: { hazmat: 1 } })], {}],
    stop_access: [[cube('early', 1, '100', { stop_index: 0 }),
      cube('late', 1, '100', { stop_index: 1, stackable: false })],
    [box('100', '100', '200', { quantity: 1, access_directions: ['+z'] })], {}],
    axle_share: [[cube('payload', 2, '10', { weight: grams('500'), allowed_rotations: ['LWH'] })],
      [box('100', '10', '10', { quantity: 1, axles: axles('600', '350') })], {}],
  };
  for (const [name, [items, containers, configuration]] of Object.entries(cases)) {
    assert.deepEqual(reasons(solve(items, containers, configuration)), INVENTORY, name);
  }
  assert.deepEqual(reasons(solve([cube('cube', 2)], [box('20', '20', '20', { max_items: 1 })])), []);
});

test('an axle that refuses the item alone is named', () => {
  for (const [length, front, rear] of [['10', '400', '400'], ['100', '400', '700']]) {
    const item = { id: 'load', quantity: 1, weight: grams('1000'), allowed_rotations: ['LWH'],
      dimensions: { length, width: '10', height: '10' } };
    const vehicle = box('100', '10', '10', { axles: axles(front, rear) });
    assert.deepEqual(reasons(solve([item], [vehicle])), [['axle_overloaded', 'inferred']], length);
  }
  const item = cube('load', 2, '10', { weight: grams('1000'), allowed_rotations: ['LWH'] });
  const crate = { ...box('10', '10', '10', { quantity: 1 }), id: 'crate' };
  assert.deepEqual(reasons(solve([item], [box('100', '10', '10', { axles: axles('400', '400') }), crate])),
    INVENTORY);
  assert.match(explainReason('axle_overloaded'), /axle/);
});

test('a single restart packs worse than the full portfolio', () => {
  // The shared conformance scene feature-effort-restarts-first-start-loses.
  const unpacked = (restarts) => solve(
    [{ id: 'panel', quantity: 4, dimensions: { length: '20', width: '25', height: '50' } },
      { id: 'crate', quantity: 4, dimensions: { length: '60', width: '40', height: '40' } }],
    [box('50', '100', '60', { quantity: 1 })],
    { solver_profile: 'balanced', effort_budget: {
      max_candidates_evaluated: 1_000_000, max_placement_attempts: 1_000_000,
      max_search_nodes: 1_000_000, ...(restarts == null ? {} : { max_restarts: restarts }) } },
  ).unpacked_items.length;
  assert.equal(unpacked(1), 4);
  assert.equal(unpacked(null), 3);
});

test('an item no container tags admit is proven unplaceable', () => {
  const result = solve([cube('cold-item', 1, '10', { eligible_container_tags: ['cold'] }), cube('dry-item', 1)],
    [box('20', '20', '20', { tags: ['dry'] })]);
  assert.deepEqual(reasons(result), [['no_eligible_container', 'proven']]);
  assert.equal(result.summary.packed_item_count, 1);
});
