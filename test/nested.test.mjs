/**
 * Nested packing, items into cartons and cartons onto a pallet, with a beam over levels.
 *
 * Mirrors `packvium-python/tests/test_nested.py`, then holds the beam to the shared scene
 * `conformance/scene/nested-beam.json`, Python's `NestedPacker` answer on requests every engine
 * packs identically.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { pack, packNested } from '../index.js';
import { packNestedWith } from '../nested.js';

const MM = 16000;
const GRAM = 8000000;
const CONFIGURATION = {
  solver_profile: 'balanced', time_limit_ms: 300000,
  effort_budget: { max_candidates_evaluated: 1000000, max_placement_attempts: 1000000, max_search_nodes: 1000000 },
};

const sides = (length, width, height) => ({ length: String(length), width: String(width), height: String(height) });
const container = (id, length, width, height, extra = {}) => ({
  id, inner_dimensions: sides(length, width, height), max_payload: { value: '100', unit: 'kg' }, ...extra,
});
const cubes = (quantity, extra = {}) => [{ id: 'cube', quantity, dimensions: sides(100, 100, 100), ...extra }];
const level = (name, containers, items = []) => ({
  name, request: { units: { length: 'mm' }, items, containers, configuration: CONFIGURATION },
});
const cartonsThenPallet = (items, cartons, pallets) => [level('carton', cartons, items), level('pallet', pallets)];
const deadEnd = () => cartonsThenPallet(cubes(2),
  [container('long', 200, 100, 100), container('single', 100, 100, 100)], [container('tower', 100, 100, 200)]);
const eightCubes = (extra = {}) => cartonsThenPallet(cubes(8, extra),
  [container('carton', 200, 200, 100)], [container('pallet', 200, 200, 200)]);

/** Every request `packNestedWith` packs, in order, beside the answer. */
function recorded(options) {
  const requests = [];
  const answer = packNestedWith((request) => {
    requests.push(request);
    return pack(request);
  }, options);
  return { answer, requests };
}

const shape = ({ levels }) => levels.map(({ result }) => [result.complete, result.containers.map((c) => c.id), result.score]);

test('two levels are packed in order', () => {
  const { levels } = packNested({ levels: eightCubes() });
  assert.deepEqual(levels.map(({ name }) => name), ['carton', 'pallet']);
  assert.ok(levels.every(({ result }) => result.complete));
  assert.equal(levels[0].result.summary.container_count, 2);
  assert.equal(levels[1].result.summary.container_count, 1);
});

test('the second level packs the first level containers by their ids', () => {
  const { levels } = packNested({ levels: eightCubes() });
  const onPallet = new Set(levels[1].result.containers[0].placements.map((placement) => placement.item_type));
  assert.deepEqual(onPallet, new Set(['carton#1', 'carton#2']));
});

test('each packed container is handed up as one upright item of its gross weight', () => {
  const levels = cartonsThenPallet(cubes(8, { weight: { value: '1', unit: 'kg' } }),
    [container('carton', 200, 200, 100, { tare_weight: { value: '500', unit: 'g' } })],
    [container('pallet', 200, 200, 200, { max_payload: { value: '10', unit: 'kg' } })]);
  const { answer, requests } = recorded({ levels });
  assert.ok(answer.levels.every(({ result }) => result.complete));
  assert.deepEqual(requests[1].items[0], {
    id: 'carton#1', quantity: 1,
    dimensions: { length: { value: '200', unit: 'mm' }, width: { value: '200', unit: 'mm' }, height: { value: '100', unit: 'mm' } },
    weight: { value: '4500', unit: 'g' },
    keep_upright: true,
    metadata: { source_packed_container: 'carton#1' },
  });
  assert.equal(answer.levels[1].result.containers[0].payload_weight.ticks, 9000 * GRAM);
});

test('outer dimensions are what the next level sees', () => {
  const levels = cartonsThenPallet(cubes(2),
    [container('carton', 100, 100, 100, { outer_dimensions: sides(110, 110, 110) })], [container('pallet', 220, 110, 110)]);
  const { answer, requests } = recorded({ levels });
  assert.deepEqual(requests[1].items[0].dimensions.length, { value: '110', unit: 'mm' });
  assert.ok(answer.levels[1].result.complete);
});

test('a flat bag is handed up at its achieved package, not its declared size', () => {
  const levels = cartonsThenPallet(cubes(1),
    [container('mailer', 300, 300, 300, { deformable_boundary: { kind: 'flat_bag' } })], [container('pallet', 400, 400, 400)]);
  const { answer, requests } = recorded({ levels });
  const bag = answer.levels[0].result.containers[0];
  const handed = requests[1].items[0].dimensions;
  for (const side of ['length', 'width', 'height']) {
    assert.equal(Number(handed[side].value) * MM, bag.achieved_dimensions[side].ticks, side);
  }
  assert.notDeepEqual(bag.achieved_dimensions, bag.outer_dimensions);
});

test('a measure that is not whole millimetres or grams is carried to the exact tick', () => {
  const levels = cartonsThenPallet(cubes(1, { weight: { value: '1', unit: 'oz' } }),
    [container('carton', 4, 4, 4, { outer_dimensions: { length: '4.1', width: '4.1', height: '4.1' } })],
    [container('pallet', 10, 10, 10)]);
  levels[0].request.units.length = 'in';
  levels[0].request.items[0].dimensions = sides(3, 3, 3);
  levels[1].request.units.length = 'in';
  const { answer, requests } = recorded({ levels });
  const carton = answer.levels[0].result.containers[0];
  const placed = answer.levels[1].result.containers[0].placements[0];
  assert.equal(requests[1].items[0].dimensions.length.value, '104.14');
  assert.equal(requests[1].items[0].weight.value, '28.349523125');
  assert.equal(placed.dimensions.length.ticks, carton.outer_dimensions.length.ticks);
  assert.equal(answer.levels[1].result.containers[0].payload_weight.ticks, carton.gross_weight.ticks);
});

test('packing stops at the first level that could not finish', () => {
  const levels = cartonsThenPallet(cubes(4, { dimensions: sides(90, 90, 90) }),
    [container('carton', 100, 100, 100, { quantity: 1 })], [container('pallet', 1000, 1000, 1000)]);
  const { levels: packed } = packNested({ levels });
  assert.equal(packed.length, 1);
  assert.equal(packed[0].result.complete, false);
});

test('an incomplete level is followed by a next level that lists its own items', () => {
  const levels = cartonsThenPallet(cubes(4, { dimensions: sides(90, 90, 90) }),
    [container('carton', 100, 100, 100, { quantity: 1 })], [container('pallet', 1000, 1000, 1000)]);
  levels[1].request.items = cubes(1);
  const { levels: packed } = packNested({ levels, levelBeamWidth: 2 });
  assert.deepEqual(packed.map(({ result }) => result.complete), [false, true]);
});

test('a level may carry its own configuration', () => {
  const levels = eightCubes();
  levels[0].request.configuration = { solver_profile: 'fast', seed: 5 };
  levels[1].request.configuration = { solver_profile: 'quality', time_limit_ms: 1000, seed: 9 };
  const { levels: packed } = packNested({ levels });
  assert.deepEqual(packed.map(({ result }) => result.algorithm.seed), [5, 9]);
  assert.deepEqual(packed.map(({ result }) => result.algorithm.profile), ['fast', 'quality']);
});

test('a single level behaves like an ordinary pack', () => {
  const only = level('carton', [container('carton', 200, 200, 100)], cubes(4));
  const { levels } = packNested({ levels: [only] });
  assert.equal(levels.length, 1);
  assert.deepEqual(levels[0].result.containers, pack(only.request).containers);
});

test('a level beam width of one is the greedy chain', () => {
  assert.deepEqual(shape(packNested({ levels: deadEnd(), levelBeamWidth: 1 })), shape(packNested({ levels: deadEnd() })));
});

test('a wider beam finds the carton set that fits the pallet', () => {
  const greedy = packNested({ levels: deadEnd(), levelBeamWidth: 1 });
  const beam = packNested({ levels: deadEnd(), levelBeamWidth: 2 });
  assert.deepEqual(greedy.levels.map(({ result }) => result.complete), [true, false]);
  assert.deepEqual(beam.levels.map(({ result }) => result.complete), [true, true]);
  assert.deepEqual(beam.levels[0].result.containers.map((c) => c.container_type), ['single', 'single']);
});

test('a width above one also offers each container alone', () => {
  const { requests } = recorded({ levels: deadEnd(), levelBeamWidth: 2 });
  assert.deepEqual(requests.slice(0, 3).map((request) => request.containers.map((c) => c.id)),
    [['long', 'single'], ['long'], ['single']]);
});

test('single-container offers keep every fixed placement in its declared container', () => {
  const only = level('carton', [container('locked', 100, 100, 100), container('other', 100, 100, 100)], cubes(1));
  only.request.fixed_placements = [{
    item_type: 'cube', container_type: 'locked', container_instance: 1,
    position: { x: '0', y: '0', z: '0' }, orientation: 'LWH',
  }];
  const { answer, requests } = recorded({ levels: [only], levelBeamWidth: 2 });
  assert.deepEqual(requests.map((request) => request.containers.map((c) => c.id)),
    [['locked', 'other'], ['locked']]);
  assert.equal(answer.levels[0].result.complete, true);
  assert.equal(answer.levels[0].result.containers[0].id, 'locked#1');
  assert.equal(answer.levels[0].result.containers[0].placements[0].item_type, 'cube');
});

test('fixed placements in several types leave the whole-list offer available', () => {
  const only = level('carton', [container('first', 100, 100, 100), container('second', 100, 100, 100)], cubes(2));
  only.request.fixed_placements = ['first', 'second'].map((container_type) => ({
    item_type: 'cube', container_type, position: { x: '0', y: '0', z: '0' }, orientation: 'LWH',
  }));
  const { answer, requests } = recorded({ levels: [only], levelBeamWidth: 3 });
  assert.equal(requests.length, 1);
  assert.equal(answer.levels[0].result.complete, true);
  assert.deepEqual(answer.levels[0].result.containers.map((c) => c.id), ['first#1', 'second#1']);
});

test('a malformed fixed placement is still refused by the whole-list offer', () => {
  const only = level('carton', [container('carton', 100, 100, 100), container('other', 100, 100, 100)], cubes(1));
  only.request.fixed_placements = [{ item_type: 'cube', container_type: 'missing', orientation: 'LWH' }];
  assert.throws(() => packNested({ levels: [only], levelBeamWidth: 2 }), /unknown container type "missing"/);
});

test('upper-level locks discard an incompatible handoff while retaining its compatible sibling', () => {
  const levels = cartonsThenPallet(cubes(2),
    [container('long', 200, 100, 100), container('single', 100, 100, 100)],
    [container('pallet', 200, 100, 100)]);
  levels[1].request.fixed_placements = [{ item_type: 'single#1', container_type: 'pallet', orientation: 'LWH' }];
  const { levels: packed } = packNested({ levels, levelBeamWidth: 2 });
  assert.deepEqual(packed.map(({ result }) => result.complete), [true, true]);
  assert.deepEqual(packed[0].result.containers.map((c) => c.id), ['single#1', 'single#2']);
  assert.deepEqual(packed[1].result.containers[0].placements.map((p) => p.item_type), ['single#1', 'single#2']);
  assert.throws(() => packNested({ levels, levelBeamWidth: 1 }), /unknown item type "single#1"/);
});

test('upper-level locks absent from every handoff retain the original request failure', () => {
  const levels = deadEnd();
  levels[1].request.fixed_placements = [{ item_type: 'missing#1', container_type: 'tower', orientation: 'LWH' }];
  assert.throws(() => packNested({ levels, levelBeamWidth: 2 }), /unknown item type "missing#1"/);
});

test('a malformed upper-level lock still fails when another handoff contains its item', () => {
  const levels = deadEnd();
  levels[1].request.fixed_placements = [{ item_type: 'single#1', container_type: 'tower', orientation: 'invalid' }];
  assert.throws(() => packNested({ levels, levelBeamWidth: 2 }), /orientation must be one of/);
});

test('handoff filtering leaves malformed item types to ordinary request validation', () => {
  const levels = deadEnd();
  levels[1].request.fixed_placements = [{ item_type: 7, container_type: 'tower', orientation: 'LWH' }];
  assert.throws(() => packNested({ levels, levelBeamWidth: 2 }), /item_type is a non-empty string/);
});

test('a handoff cannot satisfy two locks on its single item instance', () => {
  const levels = deadEnd();
  const fixed = { item_type: 'single#1', container_type: 'tower', orientation: 'LWH' };
  levels[1].request.fixed_placements = [fixed, fixed];
  // The greedy handoff has no single#1 at all; retain its original failure when no sibling
  // can provide both locked instances, rather than throwing from an arbitrary later branch.
  assert.throws(() => packNested({ levels, levelBeamWidth: 2 }), /unknown item type "single#1"/);
});

test('handoffs that are the same items occupy one beam slot', () => {
  // Packing against every carton and against `long` alone both hand up one `long#1`; counting
  // that twice would fill a width of two and drop the chain that fits.
  const { levels } = packNested({ levels: deadEnd(), levelBeamWidth: 2 });
  assert.ok(levels.every(({ result }) => result.complete));
});

test('no levels is an empty answer at any width', () => {
  assert.deepEqual(packNested({ levels: [], levelBeamWidth: 3 }), { levels: [] });
});

for (const width of [0, -1, true, 1.5, '2', 2 ** 53, Number.NaN]) {
  test(`a level beam width of ${String(width)} is refused`, () => {
    assert.throws(() => packNested({ levels: [], levelBeamWidth: width }),
      { name: 'RangeError', message: 'level_beam_width must be a positive integer' });
  });
}

const SCENE = new URL('../../../../conformance/scene/nested-beam.json', import.meta.url);
const document = existsSync(SCENE) ? JSON.parse(readFileSync(SCENE, 'utf8')) : null;
const cases = document === null ? null : [...document.cases, ...document.fixed_cases];

/** A handed-up item is named after its packed container, `quad#2`; only the type is contract. */
const kind = (itemType) => itemType.split('#')[0];
const byJson = (left, right) => {
  const a = JSON.stringify(left);
  const b = JSON.stringify(right);
  return a < b ? -1 : a > b ? 1 : 0;
};

/** The generator's `projection()`: the contract's multiset view, instance numbers dropped. */
function projection({ name, result }) {
  return {
    name,
    complete: result.complete,
    score: result.score,
    containers: result.containers.map((c) => ({
      container_type: c.container_type,
      placements: c.placements.map((p) => [kind(p.item_type), ...['x', 'y', 'z'].map((axis) => p.position[axis].ticks), p.orientation]),
    })),
    unpacked: result.unpacked_items.map((unpacked) => kind(unpacked.item_type)),
  };
}

/** One order for both sides, so the comparison is of multisets and exactly as strict. */
function normalized(level) {
  const containers = level.containers
    .map((c) => ({ container_type: c.container_type, placements: [...c.placements].sort(byJson) }))
    .sort(byJson);
  return { ...level, containers, unpacked: [...level.unpacked].sort() };
}

test('the shared nested-beam scene is present and non-empty', (t) => {
  if (cases === null) {
    t.skip('the shared cross-language scene corpus is not part of this package');
    return;
  }
  assert.ok(cases.length > 0, 'an empty scene would let every case below pass without asserting anything');
});

for (const scene of cases ?? []) {
  test(`nested-beam scene: ${scene.name}`, () => {
    const { levels } = packNested({ levels: scene.levels, levelBeamWidth: scene.level_beam_width });
    assert.deepEqual(levels.map(projection).map(normalized), scene.expected.map(normalized));
  });
}
