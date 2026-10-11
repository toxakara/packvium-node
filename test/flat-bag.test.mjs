/**
 * Flat bags, admitted by the girth rule a + c <= L and b + c <= W.
 *
 * Mirrors `packvium-python/tests/test_flat_bag.py` on the oracle's fixed cases; the request
 * error texts are asserted whole because they are compared across engines.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { FixedPlacementError, InvalidRequestError, packFallback, rebalanceWeight } from '../fallback.js';
import { validate } from './validate.mjs';

const BAG = { deformable_boundary: { kind: 'flat_bag' } };
const MM = 16000;

const books = (quantity, extra = {}) => ({
  id: 'book', quantity, weight: '300 g', allowed_rotations: ['LWH'],
  dimensions: { length: '200', width: '100', height: '20' }, ...extra,
});
const mailer = (length = '240', width = '140', extra = {}) => ({
  id: 'mailer', inner_dimensions: { length, width, height: '100' }, ...BAG, ...extra,
});
const request = (items, containers, configuration = {}) => ({
  items, containers,
  configuration: { solver_profile: 'fast', time_limit_ms: 60000, effort_budget: { max_search_nodes: 100000 }, ...configuration },
});
const extentMm = (container) => ['length', 'width', 'height']
  .map((side) => container.achieved_dimensions[side].ticks / MM);

function refusal(fields) {
  try {
    packFallback(request([books(1)], [{ id: 'mailer', inner_dimensions: { length: '300', width: '200', height: '100' }, ...fields }]));
  } catch (error) {
    return error;
  }
  return assert.fail('the request was accepted');
}

test('a malformed bag is refused with its pointer, reason and text', () => {
  const cases = [
    [{ deformable_boundary: 'flat_bag' }, '/deformable_boundary', 'wrong_type', 'must be an object'],
    [{ deformable_boundary: {} }, '/deformable_boundary/kind', 'missing_field', 'is required'],
    [{ deformable_boundary: { kind: 'pouch' } }, '/deformable_boundary/kind', 'not_allowed', 'must be one of ["flat_bag"]'],
    [{ deformable_boundary: { kind: 'flat_bag', seam: 1 } }, '/deformable_boundary/seam', 'not_allowed', 'is not a known field'],
    [{ ...BAG, made_to_measure: {} }, '/made_to_measure', 'not_allowed', 'cannot be combined with deformable_boundary'],
    [{ ...BAG, obstacles: [{ id: 'o', dimensions: { length: '1', width: '1', height: '1' } }] }, '/obstacles', 'not_allowed',
      'cannot be combined with deformable_boundary'],
    [{ ...BAG, void_fill_reserve_ratio: 0.5 }, '/void_fill_reserve_ratio', 'not_allowed', 'cannot be combined with deformable_boundary'],
  ];
  for (const [fields, field, reason, detail] of cases) {
    const error = refusal(fields);
    assert.ok(error instanceof InvalidRequestError, error.message);
    assert.deepEqual([error.field, error.reason, error.detail], [`/containers/0${field}`, reason, detail]);
  }
  const inert = packFallback(request([books(1)], [mailer('240', '140', { obstacles: [], void_fill_reserve_ratio: 0 })]));
  assert.equal(inert.containers.length, 1);
});

test('girth, not the frame, decides how high a bag stacks', () => {
  const req = request([books(3)], [mailer('240', '140', { quantity: 1 })]);
  const result = packFallback(req);
  assert.deepEqual(result.containers.map(extentMm), [[200, 100, 40]]);
  assert.equal(result.unpacked_items.length, 1);
  assert.deepEqual(validate(req, result), []);
  const opened = packFallback(request([books(3)], [mailer()]));
  assert.deepEqual(opened.containers.map(extentMm), [[200, 100, 40], [200, 100, 20]]);
  const compact = packFallback(request([books(3)], [mailer()], { require_placement_coordinates: false }));
  assert.equal(compact.containers.length, 2);
});

test('an item no rotation admits is proven unplaceable', () => {
  const carton = { id: 'carton', dimensions: { length: '250', width: '150', height: '80' } };
  const result = packFallback(request([carton], [mailer('300', '300')]));
  assert.equal(result.unpacked_items[0].reason, 'no_compatible_container_dimensions');
  const restricted = packFallback(request([{ ...carton, allowed_rotations: ['LHW'] }], [mailer('330', '300')]));
  assert.equal(restricted.unpacked_items[0].reason, 'rotation_restricted');
});

test('the block search stands down for a bag', () => {
  const result = packFallback(request([books(3)], [mailer()], { solver_profile: 'quality' }));
  assert.deepEqual(result.containers.map(extentMm), [[200, 100, 40], [200, 100, 20]]);
});

test('a bag is billed on its achieved package', () => {
  const rate = { weight_brackets_g: [500, 1000, 2000], prices_minor: [400, 700, 1100] };
  const carton = { id: 'carton', inner_dimensions: { length: '300', width: '200', height: '150' }, rate_table: rate };
  for (const [objective, expected] of [['lowest_landed_cost', 400], ['shipping_cost', 300 * 8_000_000]]) {
    for (const solver_profile of ['fast', 'exact_small', 'quality']) {
      const req = request([books(1)], [carton, mailer('300', '250', { rate_table: rate })], {
        objective, solver_profile, dimensional_weight_divisor: 5000,
        dimensional_weight_length_unit: 'cm', dimensional_weight_weight_unit: 'kg',
      });
      const result = packFallback(req);
      assert.equal(result.containers[0].container_type, 'mailer', `${objective} ${solver_profile}`);
      assert.equal(result.score[1], expected, `${objective} ${solver_profile}`);
    }
  }
});

test('a fixed set past its girth cannot hold', () => {
  const fixed = [0, 20, 40].map((z) => ({
    item_type: 'book', container_type: 'mailer', orientation: 'LWH', position: { x: '0', y: '0', z: String(z) },
  }));
  assert.throws(() => packFallback({ ...request([books(3)], [mailer()]), fixed_placements: fixed }), (error) => {
    assert.ok(error instanceof FixedPlacementError);
    assert.equal(error.message, 'invalid_fixed_placement: bag_girth_exceeded: mailer#1');
    return true;
  });
});

test('a weight rebalance never moves an item past a bag\'s girth', () => {
  const heavy = { id: 'brick', quantity: 2, weight: '5000 g', allowed_rotations: ['LWH'],
    dimensions: { length: '200', width: '100', height: '20' } };
  const box = { id: 'box', quantity: 1, cost_minor: 0, inner_dimensions: { length: '200', width: '100', height: '200' } };
  const req = request([heavy, books(2)], [box, mailer('240', '140', { quantity: 1, cost_minor: 1 })]);
  const result = packFallback(req);
  const balanced = rebalanceWeight(req, result);
  for (const container of balanced.containers.filter((c) => c.container_type === 'mailer')) {
    const [a, b, c] = extentMm(container);
    assert.ok(a + c <= 240 && b + c <= 140, JSON.stringify(container.achieved_dimensions));
  }
});
