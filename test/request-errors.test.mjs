import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FixedPlacementError, InvalidRequestError, UnsupportedFeatureError, packFallback,
} from '../fallback.js';
import * as root from '../index.js';

/**
 * Structured request errors (`packvium.request_errors`): one type, a closed reason and the JSON
 * Pointer of the bad value. `conformance/request_errors/run.py` holds every case of the shared
 * table to Python's answer; these tests hold the type itself and one case per reason and scope.
 */

const base = () => ({
  items: [{ id: 'cube', quantity: 2, weight: '1000', dimensions: { length: '100', width: '100', height: '100' } }],
  containers: [{ id: 'box', quantity: 2, inner_dimensions: { length: '200', width: '100', height: '200' } }],
  configuration: { solver_profile: 'fast' },
});

function refusalOf(edit) {
  const request = base();
  edit(request);
  try {
    packFallback(request);
  } catch (error) {
    return error;
  }
  return assert.fail('the request was accepted');
}

function assertRefused(edit, reason, field, detail) {
  const error = refusalOf(edit);
  assert.ok(error instanceof InvalidRequestError, `${error.name}: ${error.message}`);
  assert.deepEqual(
    { code: error.code, reason: error.reason, field: error.field, detail: error.detail, message: error.message },
    { code: 'invalid_request', reason, field, detail, message: `invalid_request: ${field}: ${detail}` },
  );
}

test('the error is a RangeError with a code, reason, field and detail, exported from the root', () => {
  const error = new InvalidRequestError('below_minimum', '/items/0/quantity', 'must be at least 1');
  assert.ok(error instanceof RangeError);
  assert.equal(error.name, 'InvalidRequestError');
  assert.equal(error.message, 'invalid_request: /items/0/quantity: must be at least 1');
  assert.equal(new InvalidRequestError('wrong_type', '', 'must be an object').message, 'invalid_request: must be an object');
  assert.equal(root.InvalidRequestError, InvalidRequestError);
  assert.equal(root.FixedPlacementError, FixedPlacementError);
});

test('a fixed-placement refusal is a request error that keeps its own code and message', () => {
  const error = new FixedPlacementError('fixed_placements is a list', 'malformed', '/fixed_placements');
  assert.ok(error instanceof InvalidRequestError);
  assert.deepEqual([error.name, error.code, error.reason, error.field, error.message],
    ['FixedPlacementError', 'invalid_fixed_placement', 'malformed', '/fixed_placements',
      'invalid_fixed_placement: fixed_placements is a list']);
  const holding = new FixedPlacementError('outside_container: cube#1');
  assert.deepEqual([holding.reason, holding.field], ['cannot_hold', '/fixed_placements']);
});

test('a request that is not an object is refused as a whole', () => {
  for (const request of [[base()], null, 'request']) {
    assert.throws(() => packFallback(request), { name: 'InvalidRequestError', reason: 'wrong_type', field: '',
      message: 'invalid_request: must be an object' });
  }
});

const CASES = [
  ['a missing list', (r) => { delete r.items; }, 'missing_field', '/items', 'is required'],
  ['a list that is not one', (r) => { r.containers = { box: r.containers[0] }; }, 'wrong_type', '/containers', 'must be a list'],
  ['an entry that is not an object', (r) => { r.items.push('slab'); }, 'wrong_type', '/items/1', 'must be an object'],
  ['a missing id', (r) => { r.items[0].id = null; }, 'missing_field', '/items/0/id', 'is required'],
  ['a numeric id', (r) => { r.containers[0].id = 7; }, 'wrong_type', '/containers/0/id', 'must be a string'],
  ['a later repeated id', (r) => { r.items.push({ ...r.items[0] }); }, 'duplicate_id', '/items/1/id', 'repeats the id "cube"'],
  ['a repeated container id', (r) => { r.containers.push({ ...r.containers[0] }); }, 'duplicate_id', '/containers/1/id',
    'repeats the id "box"'],
  ['a text quantity', (r) => { r.items[0].quantity = '2'; }, 'wrong_type', '/items/0/quantity', 'must be an integer'],
  ['a fractional quantity', (r) => { r.items[0].quantity = 1.5; }, 'wrong_type', '/items/0/quantity', 'must be an integer'],
  ['a whole number past 2^53 - 1', (r) => { r.items[0].stop_index = 2 ** 53; }, 'above_maximum', '/items/0/stop_index',
    'must be at most 9007199254740991'],
  ['a whole number far below the floor', (r) => { r.items[0].quantity = -(2 ** 60); }, 'below_minimum', '/items/0/quantity',
    'must be at least 1'],
  ['a ratio above one', (r) => { r.items[0].minimum_support_ratio = 1.5; }, 'above_maximum', '/items/0/minimum_support_ratio',
    'must be at most 1'],
  ['a boolean ratio', (r) => { r.configuration.minimum_support_ratio = true; }, 'wrong_type',
    '/configuration/minimum_support_ratio', 'must be a number'],
  ['a negative unbounded ratio', (r) => { r.items[0].compression_ratio = -0.5; }, 'below_minimum', '/items/0/compression_ratio',
    'must be at least 0'],
  ['a missing side', (r) => { delete r.items[0].dimensions.width; }, 'missing_field', '/items/0/dimensions/width', 'is required'],
  ['dimensions that are not an object', (r) => { r.items[0].dimensions = 'big'; }, 'wrong_type', '/items/0/dimensions',
    'must be an object'],
  ['a boolean measure', (r) => { r.items[0].dimensions.length = true; }, 'wrong_type', '/items/0/dimensions/length',
    'must be a measure'],
  ['a fractional number measure', (r) => { r.items[0].weight = 10.5; }, 'wrong_type', '/items/0/weight', 'must be a measure'],
  ['an unparsable measure', (r) => { r.items[0].nesting_height = 'ten'; }, 'wrong_type', '/items/0/nesting_height',
    'must be a measure'],
  ['a measure object without a value', (r) => { r.items[0].max_top_load = { unit: 'kg' }; }, 'wrong_type',
    '/items/0/max_top_load', 'must be a measure'],
  ['an unknown measure unit', (r) => { r.containers[0].max_payload = { value: '1', unit: 'stone' }; }, 'invalid_unit',
    '/containers/0/max_payload', 'has an unknown unit "stone"'],
  ['a null measure unit', (r) => { r.containers[0].tare_weight = { value: '1', unit: null }; }, 'invalid_unit',
    '/containers/0/tare_weight', 'has an unknown unit null'],
  ['a negative measure', (r) => { r.containers[0].outer_dimensions = { length: '210', width: '-1', height: '210' }; },
    'negative_measure', '/containers/0/outer_dimensions/width', 'cannot be negative'],
  ['an unknown request unit', (r) => { r.units = { length: 'furlong' }; }, 'invalid_unit', '/units/length',
    'has an unknown unit "furlong"'],
  ['units that are not an object', (r) => { r.units = 'mm'; }, 'wrong_type', '/units', 'must be an object'],
  ['an unknown profile', (r) => { r.configuration.solver_profile = 'fastest'; }, 'not_allowed', '/configuration/solver_profile',
    'must be one of ["fast","balanced","quality","exact_small"]'],
  ['a configuration that is not an object', (r) => { r.configuration = [1]; }, 'wrong_type', '/configuration',
    'must be an object'],
  ['an effort budget that is not an object', (r) => { r.configuration.effort_budget = 5; }, 'wrong_type',
    '/configuration/effort_budget', 'must be an object'],
  ['an effort limit of zero', (r) => { r.configuration.effort_budget = { max_restarts: 0 }; }, 'below_minimum',
    '/configuration/effort_budget/max_restarts', 'must be at least 1'],
  ['an escaped tag limit', (r) => { r.containers[0].tag_limits = { 'a/b~c': 0 }; }, 'below_minimum',
    '/containers/0/tag_limits/a~1b~0c', 'must be at least 1'],
  ['a bracket list that is not one', (r) => { r.containers[0].rate_table = { weight_brackets_g: 1000, prices_minor: [5] }; },
    'wrong_type', '/containers/0/rate_table/weight_brackets_g', 'must be a list'],
  ['a negative minimum charge', (r) => { r.containers[0].rate_table = { minimum_charge_minor: -1 }; }, 'below_minimum',
    '/containers/0/rate_table/minimum_charge_minor', 'must be at least 0'],
  ['obstacles that are not a list', (r) => { r.containers[0].obstacles = {}; }, 'wrong_type', '/containers/0/obstacles',
    'must be a list'],
  ['an obstacle origin that is not an object', (r) => {
    r.containers[0].obstacles = [{ id: 'p', origin: 5, dimensions: { length: '1', width: '1', height: '1' } }];
  }, 'wrong_type', '/containers/0/obstacles/0/origin', 'must be an object'],
  ['an obstacle without dimensions', (r) => { r.containers[0].obstacles = [{ id: 'p' }]; }, 'missing_field',
    '/containers/0/obstacles/0/dimensions', 'is required'],
];

for (const [name, edit, reason, field, detail] of CASES) {
  test(`a malformed request is refused with its rule and pointer: ${name}`, () => assertRefused(edit, reason, field, detail));
}

test('the first violation wins: configuration before items, items before containers', () => {
  assertRefused((r) => { r.items[0].quantity = 0; r.configuration.max_containers = 0; }, 'below_minimum',
    '/configuration/max_containers', 'must be at least 1');
  assertRefused((r) => { r.containers[0].quantity = 0; r.items[0].quantity = 0; }, 'below_minimum',
    '/items/0/quantity', 'must be at least 1');
});

test('null optional fields are absent, and a valid request is admitted', () => {
  const request = base();
  Object.assign(request, { units: { length: null } });
  Object.assign(request.items[0], { weight: null, stop_index: null, max_top_load: null });
  Object.assign(request.containers[0], {
    obstacles: [{ id: 'p', origin: null, dimensions: { length: '1', width: '1', height: '1' } }],
    rate_table: null, tag_limits: null,
  });
  request.configuration.effort_budget = null;
  assert.equal(packFallback(request).status, 'feasible');
  assert.equal(packFallback({ ...base(), units: null }).status, 'feasible');
});

test('an error the rule table does not name still reaches the caller as a request error', () => {
  assertRefusedWith((r) => { r.configuration.objective = 'cheapest'; }, 'invalid_request: unknown objective "cheapest"');
  assertRefusedWith((r) => { r.items[0].nesting_height = '100'; },
    "invalid_request: nesting_height must be at least zero and strictly less than the item's own height");
});

function assertRefusedWith(edit, message) {
  const error = refusalOf(edit);
  assert.ok(error instanceof InvalidRequestError, `${error.name}: ${error.message}`);
  assert.deepEqual([error.reason, error.field, error.message], ['invalid_value', '', message]);
}

test('an error that carries its own code is not relabelled', () => {
  const direction = refusalOf((r) => { r.containers[0].access_directions = ['+w']; });
  assert.equal(direction.code, 'invalid_direction');
  assert.ok(!(direction instanceof InvalidRequestError));
  const unsupported = refusalOf((r) => { r.containers[0].pallet_overhang_limit = '10'; });
  assert.ok(unsupported instanceof UnsupportedFeatureError);
});

test('an unsupported field is refused ahead of a malformed shape, without crashing on it', () => {
  const error = refusalOf((r) => { r.items = { cube: r.items[0] }; r.containers.push(null, { id: 'b', pallet_overhang_limit: 1 }); });
  assert.ok(error instanceof UnsupportedFeatureError, `${error.name}: ${error.message}`);
  assertRefused((r) => { r.containers[0].obstacles = [null]; }, 'wrong_type', '/containers/0/obstacles/0', 'must be an object');
});

test('a refusal from the solve itself is not dressed up as the caller\'s mistake', () => {
  const request = base();
  request.items[0].weight = '6000';
  request.containers[0].rate_table = { weight_brackets_g: [1000], prices_minor: [500] };
  Object.assign(request.configuration, { objective: 'lowest_landed_cost', dimensional_weight_divisor: 5000 });
  const error = (() => { try { packFallback(request); } catch (caught) { return caught; } return null; })();
  assert.ok(error instanceof RangeError && /no published price/.test(error.message), String(error));
  assert.ok(!(error instanceof InvalidRequestError));
});

test('the native backend gets the same InvalidRequestError, and only well-formed requests reach it', () => {
  const calls = [];
  const binding = { packJson: (input) => { calls.push(input); return '{"native":true}'; } };
  const bad = base();
  bad.items[0].quantity = 0;
  assert.throws(() => root.packJsonWith(binding, JSON.stringify(bad)), (error) =>
    error instanceof InvalidRequestError && error.field === '/items/0/quantity');
  assert.equal(calls.length, 0);
  assert.equal(root.packJsonWith(binding, JSON.stringify(base())), '{"native":true}');
  assert.equal(calls.length, 1);
});
