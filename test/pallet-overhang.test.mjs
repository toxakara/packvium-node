/**
 * Pallet overhang: the solving frame, deck-only floor support, the deck-first trial,
 * achieved and billed sizes, the refusals and the validator's rules. Mirrors the five
 * pallet-overhang conformance fixtures and the Python reference.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { FixedPlacementError, InvalidRequestError, UnsupportedFeatureError, packFallback } from '../fallback.js';
import { packNestedWith } from '../nested.js';
import { centringOffset } from '../pallet-overhang.js';
import { validateDocuments } from '../result-validation/index.js';

const MM = 16000;
const mm = (length, width, height) => ({ length: String(length), width: String(width), height: String(height) });
const crate = { id: 'crate', quantity: 1, weight: '10 kg', dimensions: mm(1250, 850, 400), allowed_rotations: ['LWH'] };
const cartons = (quantity) => ({ id: 'carton', quantity, weight: '10 kg', dimensions: mm(400, 400, 300) });

function request(items, container = {}, configuration = {}) {
  return {
    units: { length: 'mm' },
    configuration: { solver_profile: 'balanced', time_limit_ms: 300000,
      effort_budget: { max_search_nodes: 1000000 }, ...configuration },
    items,
    containers: [{ id: 'pallet', inner_dimensions: mm(1200, 800, 1000), max_payload: '1000 kg',
      pallet_overhang_limit: { length: '50', width: '50' }, ...container }],
  };
}

const ticksOf = (block) => [block.length.ticks, block.width.ticks, block.height.ticks];
const at = (placement) => [placement.position.x.ticks / MM, placement.position.y.ticks / MM, placement.position.z.ticks / MM];
const refusal = (req) => { try { packFallback(req); } catch (error) { return error; } return null; };
const issueCodes = (req, result) => validateDocuments(req, result).issues.map((found) => found.code);

test('a load the deck cannot hold overhangs it, seated with the least overhang, on the deck alone', () => {
  const req = request([crate]);
  const result = packFallback(req);
  const [container] = result.containers;
  assert.equal(result.complete, true);
  assert.deepEqual(ticksOf(container.inner_dimensions), [1200 * MM, 800 * MM, 1000 * MM]);
  assert.deepEqual(ticksOf(container.outer_dimensions), [1200 * MM, 800 * MM, 1000 * MM]);
  assert.deepEqual(ticksOf(container.achieved_dimensions), [1250 * MM, 850 * MM, 400 * MM]);
  // Centred on the deck: 25 mm past each edge of the 50 mm allowance.
  assert.deepEqual(at(container.placements[0]), [25, 25, 0]);
  // The deck bears 1200 x 800 of the 1250 x 850 base.
  assert.equal(container.placements[0].support_ratio, '0.903529');
  assert.deepEqual(validateDocuments(req, result).issues, []);
});

test('a load the deck holds stays on the deck: the frame is tried only when it places more', () => {
  const req = request([cartons(6)]);
  const [container] = packFallback(req).containers;
  assert.equal(container.placements.length, 6);
  for (const placement of container.placements) {
    const [x, y] = at(placement);
    assert.ok(x >= 50 && x + 400 <= 1250 && y >= 50 && y + 400 <= 850, JSON.stringify(at(placement)));
    assert.equal(placement.support_ratio, '1.000000');
  }
  assert.deepEqual(ticksOf(container.achieved_dimensions), [1200 * MM, 800 * MM, 300 * MM]);
  assert.equal(container.centre_of_mass_offset_ppm, 0);
});

test('a zero limit forbids overhang and still reports the achieved size', () => {
  const req = request([crate, { id: 'carton', quantity: 2, weight: '5 kg', dimensions: mm(400, 300, 200) }],
    { pallet_overhang_limit: { length: '0', width: '0' } });
  const result = packFallback(req);
  assert.deepEqual(result.unpacked_items.map((item) => item.reason), ['no_compatible_container_dimensions']);
  assert.deepEqual(ticksOf(result.containers[0].achieved_dimensions), [1200 * MM, 800 * MM, 200 * MM]);
});

test('only the deck bears weight: a crate the deck carries below the minimum ratio is left out', () => {
  const req = request([crate, { id: 'carton', quantity: 2, weight: '5 kg', dimensions: mm(400, 300, 200) }], {},
    { minimum_support_ratio: 0.95 });
  const result = packFallback(req);
  assert.deepEqual(result.unpacked_items.map((item) => [item.item_type, item.reason]), [['crate', 'insufficient_support']]);
  assert.deepEqual(validateDocuments(req, result).issues, []);
});

test('a fixed placement off the deck is refused by the deck support rule', () => {
  const fixed = (ratio) => ({
    ...request([{ id: 'box', quantity: 1, weight: '1 kg', dimensions: mm(100, 100, 100) }],
      { pallet_overhang_limit: { length: '60', width: '0' } }, { minimum_support_ratio: ratio }),
    fixed_placements: [{ item_type: 'box', container_type: 'pallet', orientation: 'LWH', position: { x: '0', y: '0', z: '0' } }],
  });
  // 40 of the 100 mm rest on the deck, which starts 60 mm in.
  const short = refusal(fixed(0.5));
  assert.ok(short instanceof FixedPlacementError);
  assert.match(short.message, /^invalid_fixed_placement: insufficient_support: box#1: /);
  const tipped = refusal(fixed(0.3));
  assert.ok(tipped instanceof FixedPlacementError);
  assert.match(tipped.message, /^invalid_fixed_placement: centre_of_gravity_unsupported: box#1: .* centroid outside/);
  const placed = packFallback(fixed(0));
  assert.equal(placed.containers[0].placements[0].support_ratio, '0.400000');
});

test('billed size is the declared footprint grown by the overhang used, at the declared height', () => {
  const shipping = { objective: 'shipping_cost', dimensional_weight_divisor: 5000,
    dimensional_weight_length_unit: 'cm', dimensional_weight_weight_unit: 'kg' };
  const kg = 8000000000;
  // 125 x 85 x 115 cm / 5000 = 244.375 kg, over the 1210 x 810 outer size.
  const outerRequest = request([crate], { outer_dimensions: mm(1210, 810, 1150) }, shipping);
  const withOuter = packFallback(outerRequest);
  assert.equal(withOuter.score[1], 244.375 * kg);
  assert.deepEqual(validateDocuments(outerRequest, withOuter).issues, []);
  assert.deepEqual(ticksOf(withOuter.containers[0].outer_dimensions), [1210 * MM, 810 * MM, 1150 * MM]);
  // Without an outer size the base is the declared inner one: 125 x 85 x 100 cm.
  const innerRequest = request([crate], {}, shipping);
  const withoutOuter = packFallback(innerRequest);
  assert.equal(withoutOuter.score[1], 212.5 * kg);
  assert.deepEqual(validateDocuments(innerRequest, withoutOuter).issues, []);
});

test('a nested level hands up a pallet at its billed size', () => {
  const pack = (req) => packFallback(req);
  const outcome = packNestedWith(pack, { levels: [
    { name: 'pallet', request: request([crate], { outer_dimensions: mm(1210, 810, 1150) }) },
    { name: 'truck', request: { ...request([], { id: 'truck', inner_dimensions: mm(5000, 2400, 2400) }),
      containers: [{ id: 'truck', inner_dimensions: mm(5000, 2400, 2400) }] } },
  ] });
  const [handed] = outcome.levels[1].result.containers[0].placements;
  assert.deepEqual(ticksOf(handed.dimensions), [1250 * MM, 850 * MM, 1150 * MM]);
});

test('the seat is flush with the deck when the load fits it, else centred with the odd tick past the far edge', () => {
  const deck = { x: 50, y: 50, length: 1200, width: 800 };
  assert.deepEqual(centringOffset(deck, []), [0, 0]);
  assert.deepEqual(centringOffset(deck, [{ x: 0, y: 0, ed: [400, 400, 1] }]), [50, 50]);
  assert.deepEqual(centringOffset(deck, [{ x: 0, y: 0, ed: [1251, 801, 1] }]), [25, 50]);
});

test('each combination with no defined meaning is refused by name, sorted', () => {
  const error = refusal({
    ...request([{ ...crate, stop_index: 1 }], { access_directions: ['+x'], axles: [{ position: '0' }, { position: '100' }],
      made_to_measure: { minimum: mm(1, 1, 1), increment: mm(1, 1, 1) }, obstacles: [{ dimensions: mm(1, 1, 1) }],
      void_fill_reserve_ratio: 0.1 }),
  });
  assert.ok(error instanceof UnsupportedFeatureError);
  // The made-to-measure container's own combinations are named beside these.
  assert.deepEqual(error.fields.filter((name) => name.startsWith('container.pallet')), ['container.pallet_overhang_limit+access_directions', 'container.pallet_overhang_limit+axles',
    'container.pallet_overhang_limit+item.stop_index', 'container.pallet_overhang_limit+made_to_measure',
    'container.pallet_overhang_limit+obstacles', 'container.pallet_overhang_limit+void_fill_reserve_ratio']);
  // An empty list, a zero reserve and a null stop change nothing.
  const quiet = packFallback(request([{ ...crate, stop_index: null }], { access_directions: [], obstacles: [], void_fill_reserve_ratio: 0 }));
  assert.equal(quiet.complete, true);
});

test('a malformed limit is a request error naming the field', () => {
  const cases = [
    [{ pallet_overhang_limit: '50' }, 'wrong_type', '/containers/0/pallet_overhang_limit', 'must be an object'],
    [{ pallet_overhang_limit: { length: '1', width: '1', depth: '1', axis: '1' } }, 'not_allowed',
      '/containers/0/pallet_overhang_limit/axis', 'is not a known field'],
    [{ pallet_overhang_limit: { width: '1' } }, 'missing_field', '/containers/0/pallet_overhang_limit/length', 'is required'],
    [{ pallet_overhang_limit: { length: '1' } }, 'missing_field', '/containers/0/pallet_overhang_limit/width', 'is required'],
    [{ pallet_overhang_limit: { length: '-1', width: '1' } }, 'negative_measure', '/containers/0/pallet_overhang_limit/length', 'cannot be negative'],
    [{ pallet_overhang_limit: { length: '1', width: { value: '1', unit: 'furlong' } } }, 'invalid_unit',
      '/containers/0/pallet_overhang_limit/width', 'has an unknown unit "furlong"'],
    [{ inner_dimensions: { length: '9007199254740991 ticks', width: '1 ticks', height: '1 ticks' },
      pallet_overhang_limit: { length: '1 ticks', width: '0' } }, 'above_maximum',
      '/containers/0/pallet_overhang_limit/length', 'must be at most 9007199254740991 ticks'],
    [{ inner_dimensions: { length: '10000000000 ticks', width: '10000000000 ticks', height: '10000000000 ticks' },
      pallet_overhang_limit: { length: '0', width: '1 ticks' } }, 'above_maximum',
      '/containers/0/pallet_overhang_limit', 'must enclose at most 10^30 cubic ticks'],
    [{ deformable_boundary: { kind: 'flat_bag' } }, 'not_allowed', '/containers/0/pallet_overhang_limit',
      'cannot be combined with deformable_boundary'],
  ];
  for (const [fields, reason, field, detail] of cases) {
    const error = refusal(request([crate], fields));
    assert.ok(error instanceof InvalidRequestError, `${field}: ${error}`);
    assert.deepEqual([error.reason, error.field, error.detail ?? error.message.split(': ').slice(2).join(': ')], [reason, field, detail]);
  }
});

test('the validator holds a pallet to its deck and its achieved size', () => {
  const req = request([{ id: 'box', quantity: 1, weight: '1 kg', dimensions: mm(100, 100, 100) }],
    { pallet_overhang_limit: { length: '60', width: '0' } }, { minimum_support_ratio: 0.3 });
  const result = packFallback(req);
  assert.deepEqual(validateDocuments(req, result).issues, []);
  const moved = (x, achieved) => {
    const copy = JSON.parse(JSON.stringify(result));
    const [container] = copy.containers;
    container.placements[0].position.x = { ticks: x * MM, value: String(x), unit: 'mm' };
    container.placements[0].support_ratio = '1.000000';
    if (achieved === undefined) delete container.achieved_dimensions;
    else container.achieved_dimensions.length = { ticks: achieved * MM, value: String(achieved), unit: 'mm' };
    return copy;
  };
  // 40 mm of 100 on the deck clears 0.3 but leaves the centroid off it; 10 mm clears nothing.
  assert.ok(issueCodes(req, moved(0, 1260)).includes('centre_of_gravity_unsupported'));
  assert.ok(issueCodes(req, moved(50, 1200)).every((code) => code !== 'centre_of_gravity_unsupported'));
  const strict = { ...req, configuration: { ...req.configuration, minimum_support_ratio: 0.5 } };
  assert.ok(issueCodes(strict, moved(0, 1260)).includes('insufficient_support'));
  assert.ok(issueCodes(req, moved(0)).includes('achieved_dimensions_mismatch'));
  assert.ok(issueCodes(req, moved(0, 1200)).includes('achieved_dimensions_mismatch'));
});
