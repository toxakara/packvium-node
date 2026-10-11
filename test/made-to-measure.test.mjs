/**
 * Made-to-measure containers, pinned to the worked numbers in
 * docs/MADE-TO-MEASURE-CONTAINERS.md. Mirrors `packvium-python/tests/test_made_to_measure.py`
 * and `MadeToMeasureTest.php`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { InvalidRequestError, UnsupportedFeatureError, packFallback } from '../fallback.js';
import { boxCost, fabricate, grid, icbrtCeil, perSquareMetre, solvingEnvelopes } from '../made-to-measure.js';

const MM = 16000;
const SQUARE_METRE = 16000000n * 16000000n;
const ticks = (...sides) => sides.map((side) => side * MM);
const mm = (length, width, height) => ({ length: String(length), width: String(width), height: String(height) });
const machine = (minimum = 60, increment = 25, extra = {}) => ({
  minimum: ticks(minimum, minimum, minimum), increment: ticks(increment, increment, increment),
  price: 0, tarePerSquareMetre: 0, allowance: [0, 0, 0], ...extra,
});
const cubes = (count, side = 100) => Array.from({ length: count }, () => ticks(side, side, side));

const request = (containerFields = {}, configuration = {}) => ({
  units: { length: 'mm' },
  configuration: { solver_profile: 'fast', minimum_support_ratio: 1, time_limit_ms: 300000,
    effort_budget: { max_search_nodes: 1000000 }, ...configuration },
  items: [{ id: 'cube', quantity: 8, weight: '100', dimensions: mm(100, 100, 100) }],
  containers: [{ id: 'machine', cost_minor: 40, inner_dimensions: mm(1510, 1510, 1510),
    made_to_measure: { minimum: mm(60, 60, 60), increment: mm(25, 25, 25), cost_per_square_metre_minor: 1000,
      outer_allowance: mm(3, 3, 3) }, ...containerFields }],
});

test('the grid rounds up onto the machine and never below its minimum', () => {
  assert.equal(grid(machine(), 0, 200 * MM), 210 * MM);
  assert.equal(grid(machine(), 0, 210 * MM), 210 * MM);
  assert.equal(grid(machine(), 0, 1), 60 * MM);
});

test('the split cost equals the direct ceiling and rounds a sliver up', () => {
  let state = 2702n;
  for (let index = 0; index < 100; index++) {
    state = (state * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
    const rate = state % (1n << 53n), area = (state * 977n) % (1n << 110n);
    assert.equal(perSquareMetre(rate, area), (rate * area + SQUARE_METRE - 1n) / SQUARE_METRE);
  }
  assert.equal(perSquareMetre(1, 1n), 1n);
  assert.equal(boxCost(1000, 40, ticks(210, 210, 210)), 305n);
});

test('the integer cube root is the least cube at or above the value', () => {
  for (const [value, root] of [[0n, 0n], [1n, 1n], [7n, 2n], [8n, 2n], [9n, 3n], [10n ** 21n, 10n ** 7n], [10n ** 21n + 1n, 10n ** 7n + 1n]]) {
    assert.equal(icbrtCeil(value), root);
  }
});

test('the worked rung lists match the contract', () => {
  assert.deepEqual(solvingEnvelopes(machine(), ticks(1510, 1510, 1510), cubes(8)),
    [ticks(260, 260, 260), ticks(310, 310, 310), ticks(410, 410, 410), ticks(1510, 1510, 1510)]);
  const pinned = { ...machine(), minimum: ticks(200, 100, 100), increment: ticks(70, 10, 10) };
  assert.deepEqual(solvingEnvelopes(pinned, ticks(1950, 100, 100), cubes(5)), [ticks(1950, 100, 100)]);
  assert.deepEqual(solvingEnvelopes(machine(50, 10), ticks(300, 300, 300), cubes(3)),
    [ticks(190, 190, 190), ticks(220, 220, 220), ticks(290, 290, 290), ticks(300, 300, 300)]);
  const [first] = solvingEnvelopes(machine(), ticks(1510, 1510, 1510), [ticks(1000, 50, 50), ticks(100, 100, 100)]);
  assert.ok(first[0] >= 1000 * MM && first[1] < 1000 * MM && first[2] < 1000 * MM);
  const mixed = [ticks(300, 20, 40), ticks(100, 100, 100), ticks(50, 60, 70)];
  assert.deepEqual(solvingEnvelopes(machine(), ticks(1510, 1510, 1510), mixed),
    solvingEnvelopes(machine(), ticks(1510, 1510, 1510), [...mixed].reverse()));
});

test('a box is never cut past the machine', () => {
  assert.throws(() => fabricate(machine(), ticks(100, 100, 100), ticks(110, 10, 10), 0, 0), /exceeds the machine/);
});

test('the worked order is cut to a 210 mm box with board tare, not an 800 mm row', () => {
  const data = request();
  data.containers[0].made_to_measure.tare_per_square_metre = '500';
  const result = packFallback(data), packed = result.containers[0];
  assert.deepEqual([packed.inner_dimensions.length.value, packed.outer_dimensions.height.value,
    packed.achieved_dimensions.width.value], ['210', '213', '200']);
  assert.equal(packed.made_to_measure.cost_minor, 305);
  assert.equal(packed.made_to_measure.tare_weight.value, '132.3');
  assert.equal(packed.gross_weight.value, '932.3');
  assert.equal(result.score[2], 305);
});

test('the round key reads the fabricated price in the greedy and the plan beam', () => {
  for (const configuration of [{}, { solver_profile: 'quality', container_plan_beam_width: 4 },
    { objective: 'lowest_landed_cost', dimensional_weight_divisor: 5000 }, { objective: 'maximum_volume' },
    { solver_profile: 'exact_small', solvers: ['exact_small'] }]) {
    const data = request({}, configuration);
    const rate = { weight_brackets_g: [100000], prices_minor: [100] };
    if (configuration.objective === 'lowest_landed_cost') data.containers[0].rate_table = rate;
    data.containers.push({ id: 'stock', cost_minor: 300, inner_dimensions: mm(210, 210, 210),
      ...(configuration.objective === 'lowest_landed_cost' ? { rate_table: rate } : {}) });
    if (configuration.solvers) data.items[0].quantity = 2;
    const packed = packFallback(data).containers;
    assert.equal(packed.length, 1);
  }
  assert.equal(packFallback({ ...request(), containers: [...request().containers,
    { id: 'stock', cost_minor: 300, inner_dimensions: mm(210, 210, 210) }] }).containers[0].container_type, 'stock');
});

test('the compact lattice stands down and a later round gets its own compact rungs', () => {
  const compact = packFallback(request({}, { require_placement_coordinates: false })).containers[0];
  assert.equal(compact.lattice_summary, undefined);
  assert.equal(compact.placements.length, 8);
  const data = request({ inner_dimensions: mm(300, 300, 300),
    made_to_measure: { minimum: mm(50, 50, 50), increment: mm(10, 10, 10), cost_per_square_metre_minor: 1000 } });
  data.items[0].quantity = 30;
  assert.deepEqual(packFallback(data).containers.map((c) => c.made_to_measure.cost_minor), [580, 200]);
});

test('a counted limit reached mid-chain keeps the best rung so far', () => {
  const data = request({}, { effort_budget: { max_search_nodes: 1 } });
  data.items[0].quantity = 2;
  const result = packFallback(data);
  assert.equal(result.containers.length, 1);
  assert.equal(result.containers[0].placements.length, 1);
});

test('a load no rung can hold is reported unpacked', () => {
  const data = request({ quantity: 1, max_items: 2 });
  const result = packFallback(data);
  assert.equal(result.containers[0].placements.length, 2);
  assert.equal(result.unpacked_items.length, 6);
});

test('each refused combination is named', () => {
  const cases = {
    'container.made_to_measure+axles': { axles: [{ position: '0' }, { position: '1510' }] },
    'container.made_to_measure+obstacles': { obstacles: [{ id: 'post', dimensions: mm(10, 10, 10) }] },
    'container.made_to_measure+void_fill_reserve_ratio': { void_fill_reserve_ratio: 0.5 },
  };
  for (const [name, fields] of Object.entries(cases)) {
    assert.throws(() => packFallback(request(fields)), (error) => error instanceof UnsupportedFeatureError && error.fields.includes(name));
  }
  const data = request();
  data.fixed_placements = [{ item_type: 'cube', container_type: 'machine', orientation: 'LWH' }];
  assert.throws(() => packFallback(data), (error) => error.fields.includes('fixed_placements+container.made_to_measure'));
  packFallback(request({ obstacles: [], void_fill_reserve_ratio: 0 }));
});

test('each request error names its rule', () => {
  const cases = [
    [{ extra: 1 }, 'not_allowed', '/containers/0/made_to_measure/extra', 'is not a known field'],
    [{ minimum: mm(60, 0, 60) }, 'invalid_value', '/containers/0/made_to_measure/minimum/width', 'must be positive'],
    [{ increment: mm(25, 25, 0) }, 'invalid_value', '/containers/0/made_to_measure/increment/height', 'must be positive'],
    [{ minimum: mm(1600, 60, 60) }, 'invalid_value', '/containers/0/made_to_measure/minimum/length', 'exceeds inner_dimensions'],
    [{ increment: mm(25, 30, 25) }, 'invalid_value', '/containers/0/made_to_measure/increment/width',
      'does not divide inner_dimensions minus minimum'],
    [{ cost_per_square_metre_minor: Number.MAX_SAFE_INTEGER }, 'invalid_value',
      '/containers/0/made_to_measure/cost_per_square_metre_minor', 'prices the largest box above 9007199254740991'],
  ];
  for (const [fields, reason, field, detail] of cases) {
    const data = request();
    Object.assign(data.containers[0].made_to_measure, fields);
    assert.throws(() => packFallback(data), (error) => error instanceof InvalidRequestError
      && error.reason === reason && error.field === field && error.detail === detail);
  }
  assert.throws(() => packFallback(request({ outer_dimensions: mm(1600, 1600, 1600) })),
    (error) => error.field === '/containers/0/outer_dimensions' && error.detail === 'cannot be combined with made_to_measure');
});
