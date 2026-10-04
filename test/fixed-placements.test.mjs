/**
 * Fixed placements: items already in a known place before the solve (docs/PLAN-REVISIONS.md).
 *
 * Mirrors `packvium-python/tests/test_fixed_placements.py` and `FixedPlacementTest.php`. The
 * refusal texts are asserted whole, not by fragment, because they are compared across engines.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { FixedPlacementError, InvalidRequestError, UNSUPPORTED_FIELDS, packFallback, rebalanceWeight } from '../fallback.js';
import { validate } from './validate.mjs';

const FALLBACK_WARNING = 'JavaScript fallback is active; build the Rust addon for the native portfolio';

const cube = (quantity, weight = '1000', extra = {}) => ({
  id: 'cube', quantity, weight, dimensions: { length: '100', width: '100', height: '100' }, ...extra,
});
const box = (quantity = 3, extra = {}) => ({
  id: 'box', quantity, inner_dimensions: { length: '200', width: '100', height: '200' }, ...extra,
});
const fixed = (x = '0', y = '0', z = '0', instance = 1, extra = {}) => ({
  item_type: 'cube', container_type: 'box', container_instance: instance,
  position: { x, y, z }, orientation: 'LWH', ...extra,
});

function request({ items, containers, placements, configuration } = {}) {
  const data = { items: items ?? [cube(5)], containers: containers ?? [box()],
    fixed_placements: placements ?? [fixed('100')] };
  if (configuration !== undefined) data.configuration = configuration;
  return data;
}

const fixedRows = (result) => result.containers.flatMap((container) => container.placements
  .filter((placement) => placement.fixed)
  .map((placement) => [container.id, placement.item_id, placement.position.x.value,
    placement.position.y.value, placement.position.z.value]));
const placedCount = (result) => result.containers.reduce((total, container) => total + container.placements.length, 0);

// The refusal's message; its reason and field are asserted here, since a caller branches on them.
function refusal(data, reason = 'cannot_hold', field = '/fixed_placements') {
  try {
    packFallback(data);
  } catch (error) {
    assert.ok(error instanceof FixedPlacementError, `${error.name}: ${error.message}`);
    assert.ok(error instanceof InvalidRequestError, 'a fixed-placement refusal is a request error');
    assert.equal(error.code, 'invalid_fixed_placement');
    assert.deepEqual([error.reason, error.field], [reason, field]);
    return error.message;
  }
  assert.fail('the request was accepted');
}

test('fixed_placements is no longer refused as unsupported', () => {
  assert.deepEqual(UNSUPPORTED_FIELDS.request, []);
});

for (const profile of ['fast', 'balanced', 'quality', 'exact_small']) {
  test(`a fixed item is reported where the request put it (${profile})`, () => {
    const data = request({ configuration: { solver_profile: profile } });
    const result = packFallback(data);
    assert.ok(['feasible', 'optimal'].includes(result.status), result.status);
    assert.deepEqual(fixedRows(result), [['box#1', 'cube#1', '100', '0', '0']]);
    assert.equal(placedCount(result), 5);
    assert.deepEqual(validate(data, result), []);
  });
}

test('only fixed placements carry the flag, and the key is absent otherwise', () => {
  const result = packFallback(request());
  const all = result.containers.flatMap((container) => container.placements);
  assert.equal(all.filter((placement) => placement.fixed === true).length, 1);
  assert.equal(all.filter((placement) => !('fixed' in placement)).length, 4);
});

test('a request without fixed placements answers byte for byte as before', () => {
  const data = request();
  delete data.fixed_placements;
  const empty = { ...data, fixed_placements: [] };
  assert.equal(JSON.stringify(packFallback(empty)), JSON.stringify(packFallback(data)));
  assert.ok(!JSON.stringify(packFallback(data)).includes('"fixed"'));
});

test('fixed items take the first instances of their type in listed order', () => {
  const result = packFallback(request({ placements: [fixed('100'), fixed('0')] }));
  assert.deepEqual(fixedRows(result), [['box#1', 'cube#1', '100', '0', '0'], ['box#1', 'cube#2', '0', '0', '0']]);
});

test('fixed containers open first and free ones are numbered after them', () => {
  const result = packFallback(request({ items: [cube(9)], placements: [fixed(), fixed('0', '0', '0', 2)] }));
  const ids = result.containers.map((container) => container.id);
  assert.deepEqual(ids.slice(0, 2), ['box#1', 'box#2']);
  assert.deepEqual(ids.slice(2), ['box#3']);
});

test('containers are numbered per type, fixed ones first', () => {
  const slab = { id: 'slab', quantity: 2, weight: '500', dimensions: { length: '200', width: '100', height: '50' } };
  const big = { id: 'big', quantity: 2, inner_dimensions: { length: '300', width: '200', height: '200' } };
  const data = request({ items: [cube(5), slab], containers: [box(), big],
    placements: [fixed('100'), fixed('0', '0', '0', 2), { ...fixed(), item_type: 'slab', container_type: 'big' }] });
  const result = packFallback(data);
  assert.deepEqual(result.containers.map((container) => container.id), ['box#1', 'box#2', 'big#1']);
  assert.deepEqual(validate(data, result), []);
});

test('a fixed container is kept when no free item fits in it', () => {
  const tray = { id: 'tray', quantity: 1, inner_dimensions: { length: '100', width: '100', height: '100' } };
  const result = packFallback(request({ items: [cube(3)], containers: [tray, box()],
    placements: [{ ...fixed(), container_type: 'tray' }] }));
  assert.equal(result.containers[0].id, 'tray#1');
  assert.deepEqual(result.containers[0].placements.map((placement) => placement.item_id), ['cube#1']);
});

test('a fixed container survives a search that runs out of effort', () => {
  const result = packFallback(request({ items: [cube(40)], containers: [box(20)],
    placements: [fixed(), fixed('0', '0', '0', 2)], configuration: { effort_budget: { max_search_nodes: 1 } } }));
  assert.deepEqual(new Set(fixedRows(result).map((row) => row[0])), new Set(['box#1', 'box#2']));
  assert.deepEqual(result.warnings, [FALLBACK_WARNING]);
});

test('a fixed container survives an already expired deadline with its fixed items alone', () => {
  let now = 0;
  const clock = () => { now += 5000; return now; };
  const result = packFallback(request({ items: [cube(6)], placements: [fixed(), fixed('0', '0', '0', 2)] }), clock);
  assert.deepEqual(result.containers.map((container) => container.placements.length), [1, 1]);
  assert.deepEqual(fixedRows(result).map((row) => row[0]), ['box#1', 'box#2']);
  assert.equal(result.algorithm.time_limit_reached, true);
});

test('a free item resting on a fixed one loads it', () => {
  const data = request({ items: [cube(2)], containers: [box(1)], placements: [fixed()],
    configuration: { solvers: ['extreme_points'] } });
  data.containers[0].inner_dimensions.length = '100';
  const [container] = packFallback(data).containers;
  const byId = Object.fromEntries(container.placements.map((placement) => [placement.item_id, placement]));
  assert.equal(byId['cube#2'].position.z.value, '100');
  assert.equal(byId['cube#1'].top_load.value, '1000');
});

test('a fixed item reports the support its fellow fixed items give it', () => {
  const data = request({ items: [cube(3)], containers: [box(1)], placements: [fixed('0', '0', '100')] });
  const [placement] = packFallback(data).containers[0].placements.filter((entry) => entry.fixed);
  assert.equal(placement.support_ratio, '0.000000');
});

test('fixed weight counts against payload', () => {
  const result = packFallback(request({ items: [cube(3)], containers: [box(2, { max_payload: '1000' })],
    placements: [fixed()] }));
  assert.deepEqual(result.containers.map((container) => container.placements.length), [1, 1]);
  assert.ok(['cube#2', 'cube#3'].includes(result.unpacked_items.map((item) => item.item_id).join()));
});

for (const solver of ['grid', 'homogeneous_blocks', 'maximal_spaces', 'layer']) {
  test(`every solver packs around fixed items (${solver})`, () => {
    const data = request({ configuration: { solvers: [solver] } });
    const result = packFallback(data);
    assert.deepEqual(fixedRows(result), [['box#1', 'cube#1', '100', '0', '0']]);
    assert.deepEqual(result.warnings, [FALLBACK_WARNING]);
    assert.equal(placedCount(result), 5);
    assert.deepEqual(validate(data, result), []);
  });
}

test('the compact lattice stands down for a request with fixed items, as it does for obstacles', () => {
  // Python and PHP keep the lattice on the containers without fixed items; this engine's
  // lattice is a whole-request path, so every container is searched instead.
  const configuration = { solver_profile: 'fast', require_placement_coordinates: false };
  const data = request({ items: [cube(12)], containers: [box(4)], configuration });
  const result = packFallback(data);
  assert.equal(result.containers[0].placements[0].fixed, true);
  assert.ok(result.containers.every((container) => !('lattice_summary' in container)));
  assert.equal(result.summary.packed_item_count, 12);
  assert.deepEqual(validate(data, result), []);
  delete data.fixed_placements;
  assert.ok(packFallback(data).containers.some((container) => 'lattice_summary' in container));
});

test('every start of a multi-start portfolio keeps the fixed items', () => {
  const single = packFallback(request({ items: [cube(6)] }));
  const multi = packFallback(request({ items: [cube(6)], configuration: { multi_start_orders: 3 } }));
  assert.deepEqual(fixedRows(multi), fixedRows(single));
});

const REFUSALS = [
  ['collision', (d) => d.fixed_placements.push(fixed('100')), 'collision: cube#1 with cube#2'],
  ['unknown item', (d) => { d.fixed_placements[0].item_type = 'crate'; }, 'unknown item type "crate"'],
  ['unknown container', (d) => { d.fixed_placements[0].container_type = 'crate'; }, 'unknown container type "crate"'],
  ['instance gap', (d) => { d.fixed_placements[0].container_instance = 2; }, 'box instances [2] are not numbered 1..1'],
  ['instance gaps', (d) => { d.fixed_placements[0].container_instance = 2; d.fixed_placements.push(fixed('0', '0', '0', 3)); },
    'box instances [2,3] are not numbered 1..2'],
  ['outside', (d) => { d.fixed_placements[0].position.x = '150'; }, 'outside_container: cube#1'],
  ['too many', (d) => { d.items[0].quantity = 1; d.fixed_placements.push(fixed()); }, '2 cube fixed, 1 requested'],
  ['rotation', (d) => { d.items[0].keep_upright = true; d.fixed_placements[0].orientation = 'HWL'; },
    'cube may not be placed in orientation HWL'],
  ['obstacle', (d) => { d.containers[0].obstacles = [{ id: 'pillar', origin: { x: '150' },
    dimensions: { length: '10', width: '10', height: '10' } }]; }, 'obstacle_collision: cube#1'],
  ['payload', (d) => { d.containers[0].max_payload = '500'; }, 'payload_exceeded: box#1'],
  ['clearance', (d) => { d.configuration = { clearance: '1' }; }, 'outside_container: cube#1'],
  ['support', (d) => { d.configuration = { minimum_support_ratio: 1 }; d.fixed_placements[0].position.z = '50'; },
    'insufficient_support: cube#1: 0/2560000000000 < 1.000000'],
  ['container quantity', (d) => { d.containers[0].quantity = 1; d.fixed_placements.push(fixed('0', '0', '0', 2)); },
    '2 box named, 1 available'],
  ['max_containers', (d) => { d.configuration = { max_containers: 1 }; d.fixed_placements.push(fixed('0', '0', '0', 2)); },
    '2 containers hold fixed items, max_containers is 1'],
];

for (const [name, mutate, detail] of REFUSALS) {
  test(`a fixed set that cannot hold is refused before search: ${name}`, () => {
    const data = request();
    mutate(data);
    assert.equal(refusal(data), `invalid_fixed_placement: ${detail}`);
  });
}

// The schema's shape, checked before anything is parsed: nothing is coerced, defaulted to the
// origin or ignored. The request has one item type, so a field the checks let through would be
// answered by the closed-form lattice path as if no item were fixed.
const entry = () => ({ item_type: 'cube', container_type: 'box', position: { x: '100' }, orientation: 'LWH' });
const SHAPES = [
  ['not a list', 'x', 'fixed_placements is a list', '/fixed_placements'],
  ['an object', { 0: entry() }, 'fixed_placements is a list', '/fixed_placements'],
  ['an entry that is not an object', [5], 'fixed_placements[0] is an object', '/fixed_placements/0'],
  ['an unknown key', [{ ...entry(), note: 'strapped', ab: 1 }], 'fixed_placements[0] cannot carry ["ab","note"]', '/fixed_placements/0'],
  ['a missing key', [{ item_type: 'cube' }], 'fixed_placements[0] needs ["container_type","orientation"]', '/fixed_placements/0'],
  ['an empty item type', [{ ...entry(), item_type: '' }], 'fixed_placements[0].item_type is a non-empty string', '/fixed_placements/0/item_type'],
  ['a numeric container type', [{ ...entry(), container_type: 5 }], 'fixed_placements[0].container_type is a non-empty string', '/fixed_placements/0/container_type'],
  ['an unknown orientation', [{ ...entry(), orientation: 'XYZ' }], 'fixed_placements[0].orientation is one of the six codes', '/fixed_placements/0/orientation'],
  ['an orientation in a list', [{ ...entry(), orientation: ['LWH'] }], 'fixed_placements[0].orientation is one of the six codes', '/fixed_placements/0/orientation'],
  ['a text instance', [{ ...entry(), container_instance: '1' }], 'fixed_placements[0].container_instance counts from 1', '/fixed_placements/0/container_instance'],
  ['a boolean instance', [{ ...entry(), container_instance: true }], 'fixed_placements[0].container_instance counts from 1', '/fixed_placements/0/container_instance'],
  ['a fractional instance', [{ ...entry(), container_instance: 1.5 }], 'fixed_placements[0].container_instance counts from 1', '/fixed_placements/0/container_instance'],
  ['a null instance', [{ ...entry(), container_instance: null }], 'fixed_placements[0].container_instance counts from 1', '/fixed_placements/0/container_instance'],
  ['an instance beyond 2^53 - 1', [{ ...entry(), container_instance: 2 ** 53 }], 'fixed_placements[0].container_instance counts from 1', '/fixed_placements/0/container_instance'],
  ['a position list', [{ ...entry(), position: ['100', '0', '0'] }], 'fixed_placements[0].position is a point object', '/fixed_placements/0/position'],
  ['a null position', [{ ...entry(), position: null }], 'fixed_placements[0].position is a point object', '/fixed_placements/0/position'],
  ['an extra axis', [{ ...entry(), position: { x: '100', w: '5' } }], 'fixed_placements[0].position cannot carry ["w"]', '/fixed_placements/0/position'],
  ['a boolean axis', [{ ...entry(), position: { x: true } }], 'fixed_placements[0].position.x is a measure', '/fixed_placements/0/position/x'],
  ['a null axis', [{ ...entry(), position: { y: null } }], 'fixed_placements[0].position.y is a measure', '/fixed_placements/0/position/y'],
  ['a list axis', [{ ...entry(), position: { z: [0] } }], 'fixed_placements[0].position.z is a measure', '/fixed_placements/0/position/z'],
  ['an unparsable coordinate', [{ ...entry(), position: { x: 'ten' } }], 'fixed_placements[0].position.x is a measure',
    '/fixed_placements/0/position/x'],
  ['an unknown coordinate unit', [{ ...entry(), position: { y: { value: '1', unit: 'furlong' } } }],
    'fixed_placements[0].position.y is a measure', '/fixed_placements/0/position/y'],
  ['a negative coordinate', [{ ...entry(), position: { x: '100', z: '-1' } }], 'fixed_placements[0].position.z cannot be negative',
    '/fixed_placements/0/position/z'],
  ['a later entry', [entry(), { ...entry(), orientation: 'lwh' }], 'fixed_placements[1].orientation is one of the six codes', '/fixed_placements/1/orientation'],
];

for (const [name, placements, detail, field] of SHAPES) {
  test(`fixed placements that are not the schema's shape are refused: ${name}`, () => {
    const data = request({ items: [cube(3)], containers: [box(2)] });
    data.fixed_placements = placements;
    assert.equal(refusal(data, 'malformed', field), `invalid_fixed_placement: ${detail}`);
  });
}

test('a null or empty fixed_placements is no fixed placements', () => {
  for (const placements of [null, []]) {
    const data = request({ items: [cube(3)], containers: [box(2)] });
    data.fixed_placements = placements;
    const result = packFallback(data);
    assert.equal(placedCount(result), 3);
    assert.deepEqual(fixedRows(result), []);
  }
});

test('an absent instance and position are the first container and the origin', () => {
  const data = request({ items: [cube(3)], containers: [box(2)] });
  data.fixed_placements = [{ item_type: 'cube', container_type: 'box', orientation: 'LWH' }];
  assert.deepEqual(fixedRows(packFallback(data)), [['box#1', 'cube#1', '0', '0', '0']]);
});

// Every other rule of the ordinary validator, with the text Python reports for it.
const item = (id, extra = {}) => ({ id, quantity: 3, weight: '1000',
  dimensions: { length: '100', width: '100', height: '100' }, ...extra });
const wide = { length: '200', width: '100', height: '100' };
const at = (type, x = '0', z = '0', instance = 1) => ({ ...fixed(x, '0', z, instance), item_type: type });
const room = (extra = {}) => ({ id: 'box', quantity: 3, inner_dimensions: { length: '300', width: '100', height: '300' }, ...extra });
const RULES = [
  ['floor', [item('a'), item('b', { must_be_on_floor: true })], room(), [at('a'), at('b', '0', '100')], 'must_be_on_floor: b#1: '],
  ['eligibility', [item('a', { eligible_container_tags: ['cold'] })], room({ tags: ['dry'] }), [at('a')], 'container_ineligible: a#1'],
  ['compatibility', [item('a', { tags: ['food'] }), item('b', { incompatible_tags: ['food'] })], room(),
    [at('a'), at('b', '100')], 'incompatible_items: a#1: a is incompatible with b'],
  ['tag limit', [item('a', { tags: ['hazmat'] })], room({ tag_limits: { hazmat: 1 } }), [at('a'), at('a', '100')],
    'tag_count_exceeded: a#1: hazmat: limit 1, would be 2'],
  ['non-stackable', [item('a', { stackable: false }), item('b')], room(), [at('a'), at('b', '0', '100')], 'non_stackable: a#1: a'],
  ['top load', [item('a', { max_top_load: '500' }), item('b')], room(), [at('a'), at('b', '0', '100')], 'top_load_exceeded: box#1: a#1'],
  ['stacked limit', [item('a', { max_stacked_items: 1 })], room(), [at('a'), at('a', '0', '100'), at('a', '0', '200')],
    'stacked_item_limit_exceeded: box#1: a#1'],
  // Two 1 kg cubes on a 0.01 m² base load the lower one at 200 kg/m².
  ['stack density', [item('a')], room({ max_stack_density: '150000' }), [at('a'), at('a', '0', '100')],
    'stack_density_exceeded: box#1: a#1'],
  ['single contact', [item('a'), item('b', { ground_contact_rule: 'single', dimensions: wide })], room(),
    [at('a'), at('a', '100'), at('b', '0', '100')], 'ground_contact_violation: b#1: single: rests on 2 item(s)'],
  ['covered contact', [item('a'), item('b', { ground_contact_rule: 'covered', dimensions: wide })], room(),
    [at('a'), at('b', '0', '100')], 'ground_contact_violation: b#1: covered: 1 supporter(s), not all four corners touched'],
  ['route', [item('a', { stop_index: 1 }), item('b', { stop_index: 2 })],
    { id: 'box', quantity: 3, inner_dimensions: { length: '100', width: '100', height: '200' } },
    [at('a'), at('b', '0', '100')], 'unloading_order_violation: box#1: stop 1 cannot be fully unloaded (a#1 still blocked)'],
  ['max items', [item('a')], room({ max_items: 1 }), [at('a'), at('a', '100')], 'max_items_exceeded: box#1'],
  ['group', [item('a', { group: 'g' })], room(), [at('a'), at('a', '0', '0', 2)], 'group_split: g: box#1, box#2'],
  ['axle', [item('a', { weight: '5000' })], room({ axles: [{ position: '0', max_load: '1000' }, { position: '300', max_load: '100000' }] }),
    [at('a')], 'axle_overloaded: box#1: front'],
];

for (const [name, items, container, placements, detail] of RULES) {
  test(`the fixed set is held to the ordinary rules: ${name}`, () => {
    assert.equal(refusal({ items, containers: [container], fixed_placements: placements }),
      `invalid_fixed_placement: ${detail}`);
  });
}

// The rules above each refuse; the same rules must also let a lawful set through, or a check
// that always refuses would pass the table.
const LAWFUL = [
  ['tags within their limit', [item('a', { tags: ['food'] }), item('b', { incompatible_tags: ['chem'] })],
    room({ tag_limits: { food: 2 } }), [at('a'), at('b', '100')]],
  ['a route that unloads in stop order', [item('a', { stop_index: 2 }), item('b', { stop_index: 1 })],
    { id: 'box', quantity: 3, inner_dimensions: { length: '100', width: '100', height: '200' } },
    [at('a'), at('b', '0', '100')]],
  ['a stack under its density limit', [item('a')], room({ max_stack_density: '250000' }),
    [at('a'), at('a', '0', '100')]],
];

for (const [name, items, container, placements] of LAWFUL) {
  test(`a fixed set that keeps the rules is accepted: ${name}`, () => {
    const data = { items, containers: [container], fixed_placements: placements };
    const result = packFallback(data);
    assert.equal(result.status, 'feasible');
    assert.equal(fixedRows(result).length, placements.length);
    assert.deepEqual(validate(data, result), []);
  });
}

test('the validator catches a moved fixed item', () => {
  const packed = packFallback(request());
  const moved = request({ placements: [fixed('0')] });
  assert.deepEqual(new Set(validate(moved, packed)), new Set(['fixed_placement_moved', 'unexpected_fixed_placement']));
});

test('the validator catches a missing fixed container', () => {
  const data = request();
  delete data.fixed_placements;
  const packed = packFallback(data);
  assert.ok(validate(request({ placements: [fixed('0', '0', '0', 3)] }), packed).includes('fixed_container_missing'));
});

test('rebalancing never moves a fixed item', () => {
  const data = request({ items: [cube(5, '5000')], containers: [box(2)],
    placements: [fixed(), fixed('100'), fixed('0', '0', '100'), fixed('0', '0', '0', 2)] });
  const packed = packFallback(data);
  assert.equal(packed.containers.length, 2);
  const rebalanced = rebalanceWeight(data, packed);
  const fixedIds = new Set(['cube#1', 'cube#2', 'cube#3', 'cube#4']);
  assert.ok(rebalanced.moves.every((move) => !fixedIds.has(move.item_id)));
  assert.deepEqual(validate(data, { ...packed, containers: rebalanced.containers }), []);
});
