import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  Deadline, SequenceReplayError, UNSUPPORTED_FIELDS, UnsupportedFeatureError, aggregateTermination,
  explainUnpackedItem, explanationForUnpackedItem, packFallback, rebalanceWeight,
  verifyLoadingPrefixBusinessRules,
} from '../fallback.js';
import { objective as recomputeObjective, validate } from './validate.mjs';

/**
 * The JavaScript fallback, exercised directly.
 *
 * It is a deliberately simple greedy solver — it is what runs when the Rust addon is
 * not built — but "simple" is not licence to report a rule it did not enforce. These
 * tests assert the physical rules it claims to honour, and that the numbers it reports
 * describe the packing it actually produced.
 */

const MM = 16_000;
const mm = (length, width, height) => ({
  length: String(length), width: String(width), height: String(height),
});

const request = (items, containers, rest = {}) => ({
  units: { length: 'mm' }, items, containers, ...rest,
});

const cube = (id, size = 100, rest = {}) => ({ id, dimensions: mm(size, size, size), ...rest });
const box = (id, length = 200, width = 200, height = 200, rest = {}) => ({
  id, inner_dimensions: mm(length, width, height), ...rest,
});

const placements = (result) => result.containers.flatMap((container) => container.placements);
const at = (placement) => [placement.position.x.ticks, placement.position.y.ticks, placement.position.z.ticks];
// A cross-language fixture kept in the native workspace tree; a published copy of this
// package does not carry it.
const rebalanceFixtureUrl = new URL('../../../../conformance/scene/rebalance-fixtures.json', import.meta.url);
const sharedRebalanceCase = existsSync(rebalanceFixtureUrl)
  ? JSON.parse(readFileSync(rebalanceFixtureUrl)).cases[0]
  : null;
const nestedTopLoadFixtureUrl = new URL(
  '../../conformance/shared/fixtures/regression-grid-cumulative-top-load.json',
  import.meta.url,
);
const sharedNestedTopLoadRequest = JSON.parse(readFileSync(nestedTopLoadFixtureUrl));

test('explanations are deterministic and localization-ready', () => {
  const item = {
    item_id: 'crate#1',
    reason: 'payload_exceeded',
    details: ['limit=1kg'],
    proof: { level: 'proven', observations: [] },
  };
  const descriptor = explanationForUnpackedItem(item);
  assert.deepEqual(descriptor.arguments, {
    item_id: 'crate#1', evidence_level: 'proven', details: 'limit=1kg',
  });
  assert.equal(descriptor.message_key, 'packvium.unpacked.payload_exceeded');
  assert.equal(
    explainUnpackedItem(item),
    'crate#1: Proven: exceeds the maximum payload of every offered container (limit=1kg)',
  );
});

test('catalog versions are copied unchanged and ambiguous duplicates are rejected', () => {
  const references = [
    { catalog_id: 'items', version: 7, effective_at: 10, resolved_at: 20 },
    { catalog_id: 'cartons', version: 3, effective_at: 11, resolved_at: 20 },
  ];
  const payload = request([cube('a', 50)], [box('c')], { catalog_versions_used: references });
  assert.deepEqual(packFallback(payload).catalog_versions_used, references);
  payload.catalog_versions_used.push({ ...references[0] });
  assert.throws(() => packFallback(payload), /ambiguous duplicate/);
});

test('weight rebalancing improves spread without changing exact item accounting', (t) => {
  if (sharedRebalanceCase === null) {
    t.skip('the shared cross-language scene fixture is not part of this package');
    return;
  }
  const payload = request(
    [
      cube('heavy', 10, { weight: '500', priority: 2 }),
      cube('light', 10, { weight: '100', priority: 1 }),
      cube('alone', 10, { weight: '100' }),
    ],
    [box('box', 30, 10, 10, { quantity: 2, max_items: 2 })],
  );
  const original = packSound(payload);
  const balanced = rebalanceWeight(payload, original);
  assert.deepEqual(balanced.moves, [sharedRebalanceCase.expected_move]);
  assert.deepEqual(
    balanced.containers.map(container => container.payload_weight.ticks),
    [500 * 8_000_000, 200 * 8_000_000],
  );
  const before = original.containers.flatMap(container => container.placements.map(p => p.item_id)).sort();
  const after = balanced.containers.flatMap(container => container.placements.map(p => p.item_id)).sort();
  assert.deepEqual(after, before);
  assert.deepEqual(
    balanced.containers.map(container => container.placements.map(placement => placement.item_id)),
    sharedRebalanceCase.expected_container_item_ids,
  );
  assert.deepEqual(validate(payload, { ...original, containers: balanced.containers }), []);
});

test('randomized weight rebalancing never loses an item or widens payload spread', () => {
  let seed = 0x5eed;
  for (let trial = 0; trial < 32; trial++) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    const light = 1 + seed % 100;
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    const alone = 1 + seed % 100;
    const payload = request(
      [
        cube('heavy', 10, { weight: String(300 + light + alone), priority: 2 }),
        cube('light', 10, { weight: String(light), priority: 1 }),
        cube('alone', 10, { weight: String(alone) }),
      ],
      [box('box', 30, 10, 10, { quantity: 2, max_items: 2 })],
    );
    const original = packSound(payload);
    const balanced = rebalanceWeight(payload, original, { maxMoves: 8 });
    const before = original.containers.map(container => container.payload_weight.ticks);
    const after = balanced.containers.map(container => container.payload_weight.ticks);
    assert.ok(Math.max(...after) - Math.min(...after) <= Math.max(...before) - Math.min(...before));
    assert.deepEqual(
      balanced.containers.flatMap(container => container.placements.map(p => p.item_id)).sort(),
      ['alone#1', 'heavy#1', 'light#1'],
    );
    assert.deepEqual(validate(payload, { ...original, containers: balanced.containers }), []);
  }
});

function packSound(payload) {
  const result = packFallback(payload);
  assert.deepEqual(validate(payload, result), [], 'the fallback produced an unsound packing');
  return result;
}

test('public objective and container eligibility are implemented', () => {
  const result = packFallback(request(
    [cube('a', 50, { eligible_container_tags: ['cold'] })],
    [box('c', 100, 100, 100, { tags: ['ambient'] })],
    { configuration: { objective: 'lowest_cost' } },
  ));
  assert.equal(result.objective, 'lowest_cost');
  assert.equal(result.complete, false);
  assert.equal(result.unpacked_items[0].reason, 'no_eligible_container');
});

test('explicit solver selection is reported honestly', () => {
  const selected = packFallback(request(
    [cube('a', 50)],
    [box('c')],
    { configuration: { solvers: ['extreme_points'] } },
  ));
  assert.equal(selected.algorithm.solver, 'extreme_points:javascript_fallback');
  const ordered = packFallback(request(
    [cube('a', 50), cube('b', 40)],
    [box('c')],
    { configuration: { solvers: ['grid', 'layer', 'extreme_points'] } },
  ));
  assert.deepEqual(
    ordered.termination.starts.map(start => start.id),
    [
      'grid:javascript_fallback',
      'layer:javascript_fallback',
      'extreme_points:javascript_fallback',
    ],
  );
  assert.equal(ordered.termination.starts.filter(start => start.selected).length, 1);
  assert.throws(
    () => packFallback(request([cube('a', 50)], [box('c')], {
      configuration: { solvers: ['unknown'] },
    })),
    /unknown solver/,
  );
});

test('malformed public constraints fail admission instead of being ignored', () => {
  assert.throws(
    () => packFallback(request(
      [cube('a', 50, { max_stacked_items: 0 })],
      [box('c')],
    )),
    /max_stacked_items/,
  );
  assert.throws(
    () => packFallback(request(
      [cube('a', 50)],
      [box('c', 200, 200, 200, { tag_limits: { fragile: 0 } })],
    )),
    /tag_limits/,
  );
});

test('an unrouted item cannot bury routed cargo in a seeded restart', () => {
  const payload = request(
    [cube('routed', 10, { stop_index: 0 }), cube('unrouted', 10)],
    [box('box', 10, 10, 20, { quantity: 1 })],
    { configuration: { time_limit_ms: 60_000 } },
  );

  // Seeded start 4 visits the routed item first. The old JS-only exemption for a
  // candidate without stop_index then put the unrouted item above it. All languages
  // define an absent stop as Infinity: it rides the whole route and may block routed
  // cargo from below, but it may never be placed above that cargo.
  const result = packFallback(payload, Date.now, null, 4);

  assert.deepEqual(validate(payload, result), []);
  assert.deepEqual(placements(result).map(placement => placement.item_type), ['routed']);
  assert.deepEqual(result.unpacked_items.map(item => item.item_type), ['unrouted']);
});

test('axle reactions use gross load and include centred tare', () => {
  const result = packFallback(request(
    [cube('a', 10)],
    [box('c', 20, 20, 20, {
      tare_weight: '100',
      axles: [
        { position: '5', max_load: '50' },
        { position: '15', max_load: '50' },
      ],
    })],
  ));
  const reaction = result.containers[0].axle_reactions;
  assert.equal(reaction.basis, 'gross');
  assert.equal(reaction.front_numerator, reaction.rear_numerator);
});

test('nesting height fits an extra layer and removes double-counted volume', () => {
  const result = packFallback(request(
    [cube('a', 10, { quantity: 3, nesting_height: '2', allowed_rotations: ['LWH'] })],
    [box('c', 10, 10, 26)],
  ));
  assert.equal(result.summary.packed_item_count, 3);
  assert.equal(result.containers[0].used_volume_ticks3, '10649600000000000');
});

test('general grid propagates top load through adjacent nested items', () => {
  // Nesting disables the compact lattice path. Each 50 mm item advances only 25 mm,
  // so a third kilogram would put 2 kg above the bottom item's 1.5 kg limit.
  const result = packSound(request(
    [cube('nested', 50, {
      quantity: 4, nesting_height: '25', weight: '1 kg', max_top_load: '1.5 kg',
      allowed_rotations: ['LWH'],
    })],
    [box('cell', 50, 50, 125)],
    { configuration: { solvers: ['grid'], max_containers: 1, time_limit_ms: 60_000 } },
  ));

  assert.equal(result.algorithm.solver, 'grid:javascript_fallback');
  assert.equal(result.complete, false);
  assert.equal(result.summary.packed_item_count, 2);
  assert.equal(result.summary.unpacked_item_count, 2);
  assert.deepEqual(placements(result).map(placement => placement.position.z.ticks), [0, 25 * MM]);
  assert.deepEqual(placements(result).map(placement => placement.top_load.ticks), [8_000_000_000, 0]);
});

test('shared nested lattice honours support ratio, single contact, and cumulative load', () => {
  const result = packSound(sharedNestedTopLoadRequest);

  assert.equal(result.complete, true);
  assert.equal(result.summary.packed_item_count, 6);
  assert.equal(result.summary.container_count, 2);
  for (const container of result.containers) {
    assert.deepEqual(container.placements.map(placement => placement.position.z.ticks), [0, 25 * MM, 50 * MM]);
    assert.deepEqual(container.placements.map(placement => placement.support_ratio), ['1.000000', '1.000000', '1.000000']);
    assert.deepEqual(container.placements.map(placement => placement.top_load.ticks), [16_000_000_000, 8_000_000_000, 0]);
  }

  const rebalanced = rebalanceWeight(sharedNestedTopLoadRequest, result, { maxMoves: 0 });
  for (const container of rebalanced.containers) {
    assert.deepEqual(container.placements.map(placement => placement.support_ratio), ['1.000000', '1.000000', '1.000000']);
    assert.deepEqual(container.placements.map(placement => placement.top_load.ticks), [16_000_000_000, 8_000_000_000, 0]);
  }
});

test('nested load graph keeps only the adjacent predecessor in a three-layer column', () => {
  const result = packSound(request(
    [cube('nested', 10, {
      quantity: 3, nesting_height: '5', weight: { value: '100', unit: 'ticks' },
      minimum_support_ratio: 1, ground_contact_rule: 'single', allowed_rotations: ['LWH'],
    })],
    [box('cell', 10, 10, 20)],
    { configuration: { solvers: ['grid'], time_limit_ms: 60_000 } },
  ));

  assert.deepEqual(placements(result).map(placement => placement.position.z.ticks), [0, 5 * MM, 10 * MM]);
  assert.deepEqual(placements(result).map(placement => placement.top_load.ticks), [200, 100, 0]);
  assert.deepEqual(placements(result).map(placement => placement.support_ratio), ['1.000000', '1.000000', '1.000000']);

  const dimensions = { length: 10, width: 10, height: 10 };
  const nested = (z, extra = {}) => ({
    item_type: 'nested', origin: { x: 0, y: 0, z }, dimensions,
    nesting_height: 5, weight: 100, ground_contact_rule: 'single', ...extra,
  });
  assert.throws(
    () => verifyLoadingPrefixBusinessRules(
      [nested(0), nested(5, { max_top_load: 75 }), nested(10)],
      [0, 1, 2],
      {},
    ),
    error => error instanceof SequenceReplayError
      && error.index === 2 && error.step === 2 && error.reason === 'top_load_exceeded',
  );
  assert.throws(
    () => verifyLoadingPrefixBusinessRules(
      [nested(0, { max_stacked_items: 1 }), nested(5), nested(10)],
      [0, 1, 2],
      {},
    ),
    error => error instanceof SequenceReplayError
      && error.index === 2 && error.step === 2 && error.reason === 'stacked_item_limit_exceeded',
  );
  assert.doesNotThrow(() => verifyLoadingPrefixBusinessRules(
    [nested(0), nested(5, { ground_contact_rule: 'covered' })],
    [0, 1],
    {},
  ));
  assert.throws(
    () => verifyLoadingPrefixBusinessRules(
      [nested(0), nested(5, { ground_contact_rule: 'multiple' })],
      [0, 1],
      {},
    ),
    error => error instanceof SequenceReplayError
      && error.index === 1 && error.step === 1 && error.reason === 'ground_contact_violation',
  );
});

test('nesting height accepts zero and rejects negative or full-height depths', () => {
  assert.doesNotThrow(() => packFallback(request(
    [cube('a', 10, { nesting_height: '0' })],
    [box('c', 10)],
  )));
  for (const nesting_height of ['-1', '10']) {
    assert.throws(
      () => packFallback(request(
        [cube('a', 10, { nesting_height })],
        [box('c', 10)],
      )),
      /nesting_height/,
    );
  }
});

test('every box of a compound obstacle is enforced', () => {
  const result = packFallback(request(
    [{ id: 'a', dimensions: mm(10, 20, 20), allowed_rotations: ['LWH'] }],
    [box('c', 20, 20, 20, {
      obstacles: [{
        id: 'o', dimensions: mm(1, 20, 20),
        additional_boxes: [{ origin: { x: '11' }, dimensions: mm(9, 20, 20) }],
      }],
    })],
  ));
  assert.equal(result.containers[0].placements[0].position.x.value, '1');
});

test('effort budget stops at the exact counted boundary without claiming a wall-clock limit', () => {
  const result = packFallback(request(
    [cube('a', 10, { quantity: 20 })],
    [box('c', 100, 100, 100)],
    { configuration: { time_limit_ms: 60_000, effort_budget: { max_search_nodes: 5 } } },
  ));
  assert.equal(result.summary.packed_item_count, 5);
  assert.equal(result.algorithm.metrics.search_nodes_expanded, 5);
  assert.equal(result.algorithm.time_limit_reached, false);
  assert.equal(result.termination.code, 'effort_limit');
  assert.ok(result.unpacked_items.every((item) => item.reason === 'effort_limit'));
});

// ------------------------------------------------------------------------- units

test('millimetres convert to exact ticks', () => {
  const result = packFallback(request([cube('a', 50)], [box('c')]));
  assert.equal(result.containers[0].inner_dimensions.length.ticks, 200 * MM);
});

test('inches are exact rather than approximated', () => {
  const result = packFallback({
    units: { length: 'in' }, items: [cube('a', 1)], containers: [box('c', 10, 10, 10)],
  });
  assert.equal(result.containers[0].inner_dimensions.length.ticks, 10 * 406_400);
});

test('a unit suffix inside the value is honoured', () => {
  const result = packFallback(request(
    [{ id: 'a', dimensions: { length: '1 in', width: '10', height: '10' } }], [box('c')]));
  assert.equal(placements(result)[0].dimensions.length.ticks, 406_400);
});

test('fractions and mixed fractions parse exactly', () => {
  const result = packFallback({
    units: { length: 'in' },
    items: [{ id: 'a', dimensions: { length: '1/2', width: '12 3/8', height: '1' } }],
    containers: [box('c', 20, 20, 20)],
  });
  // Compared as a set of edges: the solver is free to rotate, and which axis a given
  // measurement ends up on is its business.
  const [placement] = placements(result);
  const edges = [placement.dimensions.length, placement.dimensions.width, placement.dimensions.height]
    .map((measure) => measure.ticks).sort((a, b) => a - b);
  assert.deepEqual(edges, [203_200, 406_400, 5_029_200]);
});

test('a rendered length rounds ties to even, matching Python and PHP', () => {
  // 799998 ticks in inches used to render as a truncated '1.96849901' here (plain
  // float division); it must now agree with the other three engines' '1.96849902'.
  const result = packFallback(request(
    [cube('a', 5)],
    [box('c', '799998 ticks', 5_000_000, 5_000_000)],
    { output: { length_unit: 'in' } },
  ));
  assert.equal(result.containers[0].inner_dimensions.length.value, '1.96849902');
});

test('output units are chosen independently of the input', () => {
  const result = packFallback(request(
    [cube('a', 50, { weight: '1 kg' })], [box('c')], { output: { length_unit: 'in', weight_unit: 'kg' } }));
  assert.equal(result.containers[0].inner_dimensions.length.unit, 'in');
  assert.equal(result.containers[0].payload_weight.ticks, 8_000_000_000);
});

// --------------------------------------------------------------------- geometry

test('an exactly divisible container is filled', () => {
  const result = packSound(request([cube('cube', 100, { quantity: 8 })], [box('box')]));
  assert.equal(result.complete, true);
  assert.equal(result.summary.packed_item_count, 8);
  assert.equal(result.containers.length, 1);
});

test('rotation is used when the upright orientation will not fit', () => {
  const result = packSound(request(
    [{ id: 'plank', dimensions: mm(120, 40, 60) }], [box('c', 60, 120, 40)]));
  assert.equal(result.complete, true);
});

test('keep_upright forbids the rotation that would have helped', () => {
  const result = packFallback(request(
    [{ id: 'plank', dimensions: mm(120, 40, 60), keep_upright: true }], [box('c', 60, 120, 40)]));
  assert.equal(result.complete, false);
});

test('an explicit rotation list is respected', () => {
  const result = packFallback(request(
    [{ id: 'a', dimensions: mm(120, 40, 60), allowed_rotations: ['LWH'] }], [box('c', 60, 120, 40)]));
  assert.equal(result.complete, false);
});

test('an item larger than every container is left out', () => {
  const result = packFallback(request([cube('slab', 200)], [box('c', 100, 100, 100)]));
  assert.equal(result.complete, false);
  assert.equal(result.containers.length, 0);
  assert.equal(result.unpacked_items[0].reason, 'no_compatible_container_dimensions');
  assert.deepEqual(result.unpacked_items[0].proof, {
    level: 'proven',
    observations: [{
      code: 'no_compatible_container_dimensions',
      count: 1,
      details: [],
    }],
  });
});

test('obstacles are worked around', () => {
  const payload = request([cube('a', 40, { quantity: 2 })], [box('c', 100, 100, 100, {
    obstacles: [{ id: 'post', origin: { x: '0', y: '0', z: '0' }, dimensions: mm(50, 50, 100) }],
  })]);
  const result = packSound(payload);
  assert.equal(result.complete, true);
  for (const placement of placements(result)) {
    const [x, y, z] = at(placement);
    const inside = x < 50 * MM && y < 50 * MM && z < 100 * MM;
    assert.equal(inside, false, 'a placement landed inside the obstacle');
  }
});

// ---------------------------------------------------------------------- physics

test('nothing is stacked on a non-stackable item', () => {
  const result = packSound(request(
    [cube('n', 40, { quantity: 8, stackable: false })], [box('c', 100, 100, 100, { quantity: 4 })]));
  for (const placement of placements(result)) assert.equal(placement.position.z.ticks, 0);
});

test('a non-stackable item is not slid underneath another', () => {
  // Stacking is a relation, not a direction: rejecting only the downward case lets a
  // solver reach the same forbidden arrangement by placing the two in the other order.
  // Compared within a container — two boxes at the same height in different cartons
  // are not stacked on anything.
  const result = packSound(request([
    { ...cube('tall', 40), quantity: 2 },
    { ...cube('flat', 40), stackable: false },
  ], [box('c', 40, 40, 120)]));

  for (const container of result.containers) {
    for (const lower of container.placements) {
      if (lower.item_type !== 'flat') continue;
      const top = lower.position.z.ticks + lower.dimensions.height.ticks;
      const resting = container.placements.filter((upper) => upper.position.z.ticks === top);
      assert.deepEqual(resting.map((p) => p.item_id), [], 'something came to rest on a non-stackable item');
    }
  }
});

test('floor-only items never leave the floor', () => {
  const result = packSound(request(
    [cube('f', 40, { quantity: 8, must_be_on_floor: true })], [box('c', 100, 100, 100, { quantity: 4 })]));
  for (const placement of placements(result)) assert.equal(placement.position.z.ticks, 0);
});

test('a required support ratio is enforced and reported', () => {
  const payload = request(
    [cube('a', 60, { quantity: 4 })], [box('c', 121, 121, 400)],
    { configuration: { minimum_support_ratio: 0.75 } });
  const result = packSound(payload);
  for (const placement of placements(result)) {
    if (placement.position.z.ticks > 0) {
      assert.ok(Number(placement.support_ratio) >= 0.75, `support ${placement.support_ratio}`);
    }
  }
});

test('the reported support ratio is one on the floor', () => {
  const result = packSound(request([cube('a', 50)], [box('c')]));
  assert.equal(placements(result)[0].support_ratio, '1.000000');
});

test('a bearing limit is honoured against the cumulative stack', () => {
  // The base carries everything above it, not just its immediate neighbour.
  const payload = request([
    { id: 'base', dimensions: mm(100, 100, 50), weight: '1 kg', max_top_load: '2500 g' },
    { id: 'light', dimensions: mm(100, 100, 50), quantity: 4, weight: '1 kg' },
  ], [box('c', 100, 100, 400, { quantity: 3 })]);
  const result = packSound(payload);

  for (const placement of placements(result)) {
    if (placement.item_type === 'base') {
      assert.ok(placement.top_load.ticks <= 2500 * 8_000_000,
        `base is carrying ${placement.top_load.ticks} ticks`);
    }
  }
});

test('the reported top load is cumulative, not just the neighbour above', () => {
  const payload = request([
    { id: 'base', dimensions: mm(100, 100, 50), weight: '1 kg' },
    { id: 'upper', dimensions: mm(100, 100, 50), quantity: 2, weight: '1 kg' },
  ], [box('c', 100, 100, 150)]);
  const result = packSound(payload);
  assert.equal(result.complete, true);

  const bottom = placements(result).reduce(
    (lowest, placement) => (placement.position.z.ticks < lowest.position.z.ticks ? placement : lowest));
  assert.equal(bottom.top_load.ticks, 2 * 8_000_000_000);
});

test('top-load shares use exact integer multiplication at the safe-number boundary', () => {
  const upperWeight = 8_803_232_044;
  const leftArea = 1_000_822_035_611;
  const rightArea = 1_000_568_209_726;
  const totalArea = leftArea + rightArea;
  const exactLeftShare = Number(BigInt(upperWeight) * BigInt(leftArea) / BigInt(totalArea));
  const exactRightShare = upperWeight - exactLeftShare;
  const tickDimensions = (length, height = 1) => ({
    length: String(length), width: '1', height: String(height),
  });
  const payload = (leftLimit) => ({
    units: { length: 'ticks' },
    output: { length_unit: 'ticks', weight_unit: 'ticks' },
    configuration: { max_containers: 1, time_limit_ms: 60_000 },
    items: [
      {
        id: 'left', priority: 3, must_be_on_floor: true,
        dimensions: tickDimensions(leftArea), allowed_rotations: ['LWH'],
        max_top_load: `${leftLimit} ticks`,
      },
      {
        id: 'right', priority: 2, must_be_on_floor: true,
        dimensions: tickDimensions(rightArea), allowed_rotations: ['LWH'],
      },
      {
        id: 'upper', priority: 1, weight: `${upperWeight} ticks`,
        dimensions: tickDimensions(totalArea), allowed_rotations: ['LWH'],
      },
    ],
    containers: [{ id: 'box', quantity: 1, inner_dimensions: tickDimensions(totalArea, 2) }],
  });

  const exactBoundary = packSound(payload(exactLeftShare));
  assert.equal(exactBoundary.complete, true);
  const loads = Object.fromEntries(
    placements(exactBoundary).map(placement => [placement.item_type, placement.top_load.ticks]),
  );
  assert.deepEqual(loads, { left: exactLeftShare, right: exactRightShare, upper: 0 });
  assert.equal(typeof loads.left, 'number');
  assert.doesNotThrow(() => JSON.stringify(exactBoundary));

  const belowBoundary = packFallback(payload(exactLeftShare - 1));
  assert.equal(belowBoundary.complete, false);
  assert.deepEqual(belowBoundary.unpacked_items.map(item => item.item_type), ['upper']);
});

test('cumulative top load stays exact beyond the safe-number boundary', () => {
  const boundary = Number.MAX_SAFE_INTEGER + 1;
  const payload = (limit) => request(
    [
      cube('bottom', 10, {
        priority: 3, must_be_on_floor: true,
        ...(limit == null ? {} : { max_top_load: `${limit} ticks` }),
      }),
      cube('middle', 10, { priority: 2, weight: `${boundary} ticks` }),
      cube('top', 10, { priority: 1, weight: '1 ticks' }),
    ],
    [box('column', 10, 10, 30)],
    {
      output: { weight_unit: 'ticks' },
      configuration: { solvers: ['extreme_points'], max_containers: 1, time_limit_ms: 60_000 },
    },
  );

  // The third item makes the exact load 2^53 + 1. Rounding that load to Number before
  // the comparison used to make it equal the 2^53 limit and admit an invalid stack.
  const rejected = packFallback(payload(boundary));
  assert.equal(rejected.complete, false);
  assert.equal(rejected.summary.packed_item_count, 2);
  assert.deepEqual(rejected.unpacked_items.map(item => item.item_type), ['top']);

  // `ticks` remains a Number for schema compatibility, but the rendered value comes
  // from the exact BigInt at that one explicit JSON boundary.
  const reported = packFallback(payload(null));
  const bottom = placements(reported).find(placement => placement.item_type === 'bottom');
  assert.equal(bottom.top_load.ticks, boundary);
  assert.equal(bottom.top_load.value, '9007199254740993');
  assert.doesNotThrow(() => JSON.stringify(reported));
});

test('incompatible items are separated', () => {
  const payload = request([
    { ...cube('food', 40), tags: ['food'] },
    { ...cube('bleach', 40), incompatible_tags: ['food'] },
  ], [box('c', 100, 100, 100, { quantity: 2 })]);
  const result = packSound(payload);
  assert.equal(result.complete, true);
  assert.equal(result.containers.length, 2);
});

// ----------------------------------------------------------------- capacities

test('a payload ceiling splits the order across containers', () => {
  const payload = request(
    [cube('a', 50, { quantity: 2, weight: '1 kg' })], [box('c', 200, 200, 200, { max_payload: '1500 g' })]);
  const result = packSound(payload);
  assert.equal(result.complete, true);
  assert.equal(result.containers.length, 2);
});

test('container stock is never exceeded', () => {
  const payload = request([cube('a', 90, { quantity: 4 })], [box('c', 100, 100, 100, { quantity: 2 })]);
  const result = packSound(payload);
  assert.ok(result.containers.length <= 2);
  assert.equal(result.unpacked_items.length, 2);
});

test('a high-priority item leads the ordering', () => {
  // Priority is a preference, not a guarantee: a container that can only hold one of
  // the two items should hold the high-priority one, even though it is far smaller.
  const result = packSound(request(
    [cube('big', 100), cube('small', 10, { priority: 5 })],
    [box('box', 100, 100, 100, { quantity: 1 })],
  ));
  assert.deepEqual(placements(result).map((p) => p.item_id), ['small#1']);
});

test('the cheaper container is preferred when both would do', () => {
  const result = packSound(request([cube('a', 50)], [
    box('dear', 100, 100, 100, { cost_minor: 900 }),
    box('cheap', 100, 100, 100, { cost_minor: 100 }),
  ]));
  assert.equal(result.containers[0].container_type, 'cheap');
});

test('a container that holds every remaining item is preferred over a cheaper one that holds one', () => {
  const result = packSound(request([cube('cube', 40, { quantity: 10 })], [
    box('small', 40, 40, 40),
    box('large', 200, 200, 200),
  ]));
  assert.equal(result.summary.container_count, 1);
  assert.equal(result.containers[0].container_type, 'large');
});

// -------------------------------------------------------------------- grouping

test('a group travels in one container', () => {
  const payload = request([
    cube('kit', 60, { quantity: 2, group: 'kit' }),
    cube('loose', 20, { quantity: 4 }),
  ], [box('c', 130, 130, 130, { quantity: 3 })]);
  const result = packSound(payload);
  assert.equal(result.complete, true);
});

test('an impossible group does not strand unrelated items', () => {
  // A group that cannot fit must be rejected as a whole and leave the rest of the
  // order untouched.
  const payload = request([
    cube('kit', 80, { quantity: 2, group: 'kit' }),
    cube('loose', 20, { quantity: 4 }),
  ], [box('c', 100, 100, 100)]);
  const result = packSound(payload);

  assert.equal(result.summary.packed_item_count, 4);
  assert.deepEqual(result.unpacked_items.map((entry) => entry.reason),
    ['group_cannot_fit_together', 'group_cannot_fit_together']);
});

// ------------------------------------------------------------------- clearance

test('clearance keeps a gap between neighbours', () => {
  const payload = request(
    [cube('a', 40, { quantity: 4 })], [box('c', 200, 200, 200)], { configuration: { clearance: '2' } });
  const result = packSound(payload);

  const boxes = placements(result).map((placement) => ({ at: at(placement), size: [40 * MM, 40 * MM, 40 * MM] }));
  for (let index = 0; index < boxes.length; index++) {
    for (const other of boxes.slice(index + 1)) {
      const gaps = [0, 1, 2].map((axis) => Math.max(
        other.at[axis] - (boxes[index].at[axis] + boxes[index].size[axis]),
        boxes[index].at[axis] - (other.at[axis] + other.size[axis])));
      assert.ok(Math.max(...gaps) >= 4 * MM, 'two placements are closer than twice the clearance');
    }
  }
});

test('clearance is measured from the container walls too', () => {
  const payload = request([cube('a', 40)], [box('c', 100, 100, 100)], { configuration: { clearance: '2' } });
  const [placement] = placements(packSound(payload));
  assert.deepEqual(at(placement), [2 * MM, 2 * MM, 2 * MM]);
});

// ------------------------------------------------------------------- reporting

function checkBudgetClock() {
  let reads = 0;
  return () => reads++;
}

test('an injected clock expires before the first placement without sleeping', () => {
  const result = packFallback(request(
    [cube('a', 20, { quantity: 8 })], [box('c')],
    { configuration: { time_limit_ms: 1 } },
  ), checkBudgetClock());
  assert.equal(result.algorithm.time_limit_reached, true);
  assert.equal(result.summary.packed_item_count, 0);
  assert.equal(result.summary.unpacked_item_count, 8);
});

// Two item types on purpose: "mid-search" is a property of a search, and one
// item type routes to the closed-form lattice path, which has no middle to be
// interrupted in -- it emits a whole batch or none. Pinning the path here keeps this
// test asserting what its name says, instead of asserting it only by accident of which
// solver the fixture happened to reach.
test('an injected clock expires mid-search without sleeping', () => {
  const result = packFallback(request(
    [cube('a', 20, { quantity: 7 }), cube('b', 15, { quantity: 1 })], [box('c')],
    { configuration: { time_limit_ms: 8 } },
  ), checkBudgetClock());
  assert.equal(result.algorithm.time_limit_reached, true);
  assert.ok(result.summary.packed_item_count > 0 && result.summary.packed_item_count < 8);
  assert.equal(result.summary.packed_item_count + result.summary.unpacked_item_count, 8);
});

test('Deadline accepts an injected monotonic clock', () => {
  const deadline = new Deadline(3, checkBudgetClock());
  assert.equal(deadline.expired(), false);
  assert.equal(deadline.expired(), false);
  assert.equal(deadline.expired(), true);
});

// Two item types on purpose: `collision_checks > 0` below is a claim about a
// *searching* solve. The closed-form lattice path performs no collision or support check
// at all -- that is the whole reason it is closed-form, and it has always reported zero
// for any caller setting `require_placement_coordinates: false`. One item type routes
// there, so this fixture would otherwise be asserting search behaviour of a path that
// does not search. The lattice path's own counters are asserted separately below.
test('algorithm metrics are structured and mirror legacy counters', () => {
  const result = packFallback(request(
    [cube('a', 40, { quantity: 3 }), cube('b', 30, { quantity: 1 })],
    [box('c', 100, 100, 100)],
  ));
  const { metrics } = result.algorithm;
  const fields = [
    'candidate_points_considered',
    'orientations_considered',
    'feasible_candidates',
    'collision_checks',
    'support_checks',
    'space_partitions',
    'search_nodes_expanded',
  ];
  assert.ok(fields.every((field) => Number.isSafeInteger(metrics[field]) && metrics[field] >= 0));
  assert.equal(metrics.orientations_considered, result.algorithm.placements_attempted);
  assert.equal(metrics.feasible_candidates, result.algorithm.candidates_evaluated);
  assert.ok(metrics.candidate_points_considered > 0);
  assert.ok(metrics.collision_checks > 0);
  assert.ok(metrics.support_checks > 0);
  assert.ok(metrics.search_nodes_expanded > 0);
});

test('a finished winner is distinct from a truncated loser', () => {
  const termination = aggregateTermination([
    {
      id: 'winner', started: true, completed: true, truncated: false,
      selected: true, global_deadline_reached: false,
    },
    {
      id: 'loser', started: true, completed: false, truncated: true,
      selected: false, global_deadline_reached: false,
    },
  ]);
  assert.equal(termination.code, 'complete');
  assert.equal(termination.any_start_truncated, true);
  assert.equal(termination.all_required_starts_completed, false);
  assert.equal(termination.winning_start_truncated, false);
  assert.equal(termination.global_deadline_reached, false);
});

test('a truncated winner affects the returned answer', () => {
  const termination = aggregateTermination([
    {
      id: 'winner', started: true, completed: false, truncated: true,
      selected: true, global_deadline_reached: false,
    },
    {
      id: 'loser', started: true, completed: true, truncated: false,
      selected: false, global_deadline_reached: false,
    },
  ]);
  assert.equal(termination.code, 'time_limit');
  assert.equal(termination.any_start_truncated, true);
  assert.equal(termination.all_required_starts_completed, false);
  assert.equal(termination.winning_start_truncated, true);
  assert.equal(termination.global_deadline_reached, false);
});

test('a normal pack reports verifiable per-start termination', () => {
  const termination = packFallback(request([cube('a', 50)], [box('c')])).termination;
  assert.equal(termination.starts.filter((start) => start.selected).length, 1);
  assert.equal(termination.any_start_truncated, termination.starts.some((start) => start.truncated));
  assert.equal(
    termination.all_required_starts_completed,
    termination.starts.every((start) => start.completed),
  );
  assert.equal(
    termination.winning_start_truncated,
    termination.starts.find((start) => start.selected).truncated,
  );
  assert.equal(
    termination.global_deadline_reached,
    termination.starts.some((start) => start.global_deadline_reached),
  );
});

test('the same request produces the same answer', () => {
  // With an adequate deadline and no randomness, reproducibility is total —
  // including the search-effort counters.
  const payload = request([cube('a', 40, { quantity: 6 })], [box('c', 150, 150, 150, { quantity: 2 })]);
  assert.deepEqual(packFallback(payload), packFallback(payload));
});

test('coordinate compaction keeps a 10,000-item lattice at constant result size', () => {
  const payload = request(
    [cube('cube', 10, { quantity: 10_000, allowed_rotations: ['LWH'] })],
    [box('box', 1_000, 1_000, 10)],
    { configuration: { solver_profile: 'fast', require_placement_coordinates: false } },
  );
  const started = Date.now();
  const result = packFallback(payload);
  const elapsed = Date.now() - started;
  assert.equal(result.complete, true);
  assert.equal(result.summary.packed_item_count, 10_000);
  assert.equal(result.containers[0].placements.length, 0);
  assert.deepEqual(
    {
      item_type: result.containers[0].lattice_summary.item_type,
      orientation: result.containers[0].lattice_summary.orientation,
      nx: result.containers[0].lattice_summary.nx,
      ny: result.containers[0].lattice_summary.ny,
      layers_used: result.containers[0].lattice_summary.layers_used,
      count: result.containers[0].lattice_summary.count,
    },
    { item_type: 'cube', orientation: 'LWH', nx: 100, ny: 100, layers_used: 1, count: 10_000 },
  );
  assert.ok(elapsed < 5_000, `quantity-compression fast path took ${elapsed}ms`);
});

test('coordinate compaction is opt-in and the default result shape is unchanged', () => {
  const payload = request([cube('cube', 10, { quantity: 8 })], [box('box', 20, 20, 20)]);
  const implicit = packFallback(payload);
  const explicit = packFallback({
    ...payload,
    configuration: { require_placement_coordinates: true },
  });
  assert.deepEqual(implicit, explicit);
  assert.equal(implicit.containers[0].placements.length, 8);
  assert.equal('lattice_summary' in implicit.containers[0], false);
});

test('compact lattice rejects the same malformed item as the general path', () => {
  const payload = request(
    [cube('a', 10, { value: -1 })],
    [box('c')],
    { configuration: { require_placement_coordinates: false } },
  );
  assert.throws(() => packFallback(payload), /value must be a non-negative safe integer/);
});

test('compact lattice stops at the exact effort boundary', () => {
  for (const field of ['max_search_nodes', 'max_candidates_evaluated', 'max_placement_attempts']) {
    const result = packFallback(request(
      [cube('a', 10, { quantity: 20 })],
      [box('c', 100, 100, 100)],
      { configuration: {
        require_placement_coordinates: false,
        effort_budget: { [field]: 5 },
      } },
    ));
    assert.equal(result.summary.packed_item_count, 5, field);
    assert.equal(result.algorithm.metrics[field === 'max_search_nodes'
      ? 'search_nodes_expanded'
      : field === 'max_candidates_evaluated' ? 'feasible_candidates' : 'orientations_considered'], 5);
    assert.equal(result.algorithm.effort_limit_reached, true);
    assert.equal(result.termination.code, 'effort_limit');
    assert.ok(result.unpacked_items.every((item) => item.reason === 'effort_limit'));
  }
});

test('compact lattice honours an injected clock before and between batches', () => {
  const payload = request(
    [cube('a', 100, { quantity: 3 })],
    [box('c', 100, 100, 100, { quantity: 3 })],
    { configuration: { require_placement_coordinates: false, time_limit_ms: 1 } },
  );
  const before = packFallback(payload, checkBudgetClock());
  assert.equal(before.summary.packed_item_count, 0);
  assert.equal(before.algorithm.time_limit_reached, true);
  assert.ok(before.unpacked_items.every((item) => item.reason === 'time_limit'));

  const between = packFallback({
    ...payload,
    configuration: { ...payload.configuration, time_limit_ms: 2 },
  }, checkBudgetClock());
  assert.equal(between.summary.packed_item_count, 1);
  assert.equal(between.summary.unpacked_item_count, 2);
  assert.equal(between.algorithm.time_limit_reached, true);
  assert.equal(between.termination.code, 'time_limit');
});

test('compact lattice reports structured metrics that mirror legacy counters', () => {
  const result = packFallback(request(
    [cube('a', 10, { quantity: 3 })],
    [box('c')],
    { configuration: { require_placement_coordinates: false } },
  ));
  const { metrics } = result.algorithm;
  for (const field of [
    'candidate_points_considered', 'orientations_considered', 'feasible_candidates',
    'collision_checks', 'support_checks', 'space_partitions', 'search_nodes_expanded',
  ]) assert.ok(Number.isSafeInteger(metrics[field]) && metrics[field] >= 0, field);
  assert.equal(metrics.orientations_considered, result.algorithm.placements_attempted);
  assert.equal(metrics.feasible_candidates, result.algorithm.candidates_evaluated);
  assert.equal(metrics.search_nodes_expanded, 3);
});

test('the result announces that the native addon is not in use', () => {
  const result = packFallback(request([cube('a', 50)], [box('c')]));
  assert.ok(result.warnings.some((warning) => warning.includes('fallback')));
  assert.equal(result.algorithm.solver, 'javascript_fallback');
});

test('a deadline is reported together with time-limit unpacked reasons', () => {
  const result = packFallback(request(
    [cube('a', 10, { quantity: 20_000 }), cube('oversized', 200)],
    [box('c', 100, 100, 100, { quantity: 100 })],
    { configuration: { time_limit_ms: 1 } },
  ));
  assert.equal(result.algorithm.time_limit_reached, true);
  assert.equal(result.status, 'time_limit');
  assert.ok(result.unpacked_items.length > 0);
  const oversized = result.unpacked_items.find((item) => item.item_type === 'oversized');
  assert.equal(oversized.reason, 'no_compatible_container_dimensions');
  assert.equal(oversized.proof.level, 'proven');
  const interrupted = result.unpacked_items.filter((item) => item.item_type === 'a');
  assert.ok(interrupted.every((item) => item.reason === 'time_limit'));
  assert.ok(interrupted.every((item) => item.proof.level === 'unknown_due_to_limit'));
  assert.ok(result.unpacked_items.every(
    (item) => item.proof.observations.some((observation) => observation.code === item.reason),
  ));
});

test('an empty container is never reported', () => {
  const result = packSound(request([cube('a', 10)], [box('c', 100, 100, 100, { quantity: 5 })]));
  assert.equal(result.containers.length, 1);
});

test('a pinned exact_small solver rejects an instance over its configured limit', () => {
  assert.throws(
    () => packFallback(request(
      [cube('a', 10, { quantity: 8 })],
      [box('c')],
      { configuration: { solvers: ['exact_small'], exact_item_limit: 7 } },
    )),
    /exact-small item limit exceeded/,
  );
});

test('the volume totals are exact big integers, not doubles', () => {
  // A cubic-tick volume is far past the range where a double is exact, so it is
  // serialized as a decimal string.
  const result = packFallback(request([cube('a', 100)], [box('c')]));
  assert.equal(typeof result.containers[0].used_volume_ticks3, 'string');
  assert.equal(result.containers[0].used_volume_ticks3, String(BigInt(100 * MM) ** 3n));
});

// docs/OBJECTIVE.md and docs/SERIALIZATION.md promise `objective` (result-level) and
// `void_fill_reserve_ticks3` (per-container) on every result; the fallback silently
// omitted both until the differential harness compared its output against Python/PHP
// directly and caught the implementation-specific drift.
test('the default objective and zero void-fill reserve are present', () => {
  const result = packFallback(request([cube('a', 100)], [box('c')]));
  assert.equal(result.objective, 'default');
  assert.equal(result.containers[0].void_fill_reserve_ticks3, '0');
});

// --------------------------------------------------------- maximum value

test('maximum_value leaves the least valuable item behind, not merely a scored one', () => {
  // This assertion used to check only that score[1] matched whatever the engine had
  // left unpacked, which passes for a correct and an arbitrarily bad choice alike --
  // and it did pass while the engine was leaving the item worth 1000 behind to carry
  // one worth 1. Reporting the objective is not searching for it: the documented
  // implementation-defined tie-break covers equally scoring solutions, and
  // [1, 1, ...] against [1, 1000, ...] is not a tie. Assert the choice.
  for (const [first, second] of [[1000, 1], [1, 1000]]) {
    const result = packFallback(request(
      [cube('gold', 50, { value: first }), cube('cheap', 50, { value: second })],
      [box('c', 50, 50, 50, { quantity: 1 })],
      { configuration: { objective: 'maximum_value' } },
    ));
    const packed = result.containers.flatMap((c) => c.placements.map((p) => p.item_type));
    // Tracks the declared value, not the declaration order: swapping the values
    // swaps which item is carried.
    assert.deepEqual(packed, [first > second ? 'gold' : 'cheap']);
    assert.equal(result.score[1], Math.min(first, second));
  }
});

test('maximum_value scores the total value of whatever is left unpacked', () => {
  const result = packFallback(request(
    [cube('a', 50, { value: 30 }), cube('b', 50, { value: 7 })],
    [box('c', 50, 50, 50, { quantity: 1 })],
    { configuration: { objective: 'maximum_value' } },
  ));
  const unpackedValue = result.unpacked_items.reduce((sum, u) => sum + (u.item_type === 'a' ? 30 : 7), 0);
  assert.equal(result.score[1], unpackedValue);
  assert.equal(result.summary.unpacked_item_count, 1);
});

// ---------------------------------------------------- landed cost
//
// A 200mm cube container against a `cm`/`kg` divisor of 8000 has a dimensional weight
// of exactly 1000 g, which is what makes the arithmetic below checkable by hand:
// (200 mm)^3 = 8000 cm^3, and 8000 / 8000 = 1 kg. Every expected charge here is derived
// from the published tariff, never copied back from the engine.

const landed = (rateTable, itemWeight, divisor = 8000) => request(
  [cube('a', 100, { weight: itemWeight })],
  [box('c', 200, 200, 200, { cost_minor: 0, rate_table: rateTable })],
  {
    configuration: {
      objective: 'lowest_landed_cost',
      dimensional_weight_divisor: divisor,
      dimensional_weight_length_unit: 'cm',
      dimensional_weight_weight_unit: 'kg',
    },
  },
);

test('lowest_landed_cost prices the billed weight through the tariff', () => {
  // Billed = max(gross 200 g, dimensional 1000 g) = 1000 g, which clears the 500 g
  // bracket and lands in the 1500 g one at 1200 minor units. The 100-permille fuel
  // surcharge adds ceil(1200 * 100 / 1000) = 120.
  const req = landed(
    { weight_brackets_g: [500, 1500], prices_minor: [700, 1200], fuel_surcharge_permille: 100 },
    '200 g',
  );
  const result = packFallback(req);
  assert.equal(result.objective, 'lowest_landed_cost');
  assert.equal(result.score[1], 1320);
  // The validator prices it again from the reported result with arithmetic that shares
  // no code with the solver. Agreement here is the whole point of the second copy.
  assert.deepEqual(recomputeObjective(req, result), result.score);
});

test('a minimum charge floors a shipment the bracket would price below it', () => {
  // The 1500 g bracket asks 100; the tariff's floor of 900 wins. Without the floor this
  // scores 100, so the assertion distinguishes an implemented minimum from an ignored one.
  const result = packFallback(landed(
    { weight_brackets_g: [1500], prices_minor: [100], minimum_charge_minor: 900 },
    '200 g',
  ));
  assert.equal(result.score[1], 900);
});

test('a bracket step makes two different billed weights cost exactly the same', () => {
  // This is the reason the objective exists. With the divisor raised so gross weight
  // decides, 600 g and 900 g are 300 g apart -- `shipping_cost` ranks them apart -- yet
  // both sit in the same bracket and cost the same money, so `lowest_landed_cost` is
  // rightly indifferent. An implementation that merely re-scaled billable weight into
  // currency could not produce this.
  const charges = ['600 g', '900 g'].map((weight) => packFallback(landed(
    { weight_brackets_g: [500, 1500], prices_minor: [700, 1200] }, weight, 80_000,
  )).score[1]);
  assert.deepEqual(charges, [1200, 1200]);
  const billable = ['600 g', '900 g'].map((weight) => packFallback(request(
    [cube('a', 100, { weight })],
    [box('c', 200, 200, 200, { cost_minor: 0 })],
    {
      configuration: {
        objective: 'shipping_cost',
        dimensional_weight_divisor: 80_000,
        dimensional_weight_length_unit: 'cm',
        dimensional_weight_weight_unit: 'kg',
      },
    },
  )).score[1]);
  assert.notDeepEqual(billable[0], billable[1]);
});

test('a weight the tariff does not price ranks worst, never free', () => {
  // Billed 1000 g against a ladder that stops at 500 g. Scoring an unpriceable container
  // as 0 would make this objective actively prefer the packing the caller cannot ship.
  const result = packFallback(landed({ weight_brackets_g: [500], prices_minor: [700] }, '200 g'));
  assert.equal(result.score[1], Number.MAX_SAFE_INTEGER);
});

test('the compact lattice path no longer commits to an unpriceable container (quality profile)', () => {
  // Found by adversarial review: the compact lattice path scored `lowest_landed_cost`
  // with the same billed-weight proxy the general path uses, but never stood down for
  // it the way it already does for a registered policy rule -- so it could commit to
  // one container with nothing to correct that choice once made. ``'s
  // homogeneous-block quality search, unlike the compact path or the default
  // `balanced` general search, prices every candidate container exactly rather than by
  // proxy, so it is the one shape that already gets this right; this pins that it stays
  // right now that the compact path is excluded rather than silently overriding it.
  //  tracks the residual gap: the default `balanced` profile's own general search
  // uses the same proxy as the excluded compact path and can still choose wrong on a
  // larger request, which needs the quality search's exact per-candidate pricing wired
  // into the default path rather than a fast-path exclusion to close.
  const req = request(
    [cube('dense', 100, { weight: '500 g' })],
    [
      box('small_unpriceable', 150, 150, 150, { rate_table: { weight_brackets_g: [1], prices_minor: [900] } }),
      box('big_priced', 300, 300, 300, { rate_table: { weight_brackets_g: [20000], prices_minor: [1500] } }),
    ],
    {
      configuration: {
        objective: 'lowest_landed_cost',
        solver_profile: 'quality',
        dimensional_weight_divisor: 5000,
        dimensional_weight_length_unit: 'cm',
        dimensional_weight_weight_unit: 'kg',
      },
    },
  );
  const result = packFallback(req);
  assert.equal(result.containers[0].container_type, 'big_priced');
  assert.equal(result.score[1], 1500);
});

test('lowest_landed_cost refuses a request it cannot price', () => {
  // A missing rate card is a static property of the request, so it is caught before any
  // solving rather than scored around: rating some containers and not others would rank
  // a priced packing against an unpriced one as though the unpriced were free.
  assert.throws(() => packFallback(request(
    [cube('a', 100)],
    [box('c', 200, 200, 200)],
    { configuration: { objective: 'lowest_landed_cost', dimensional_weight_divisor: 8000 } },
  )), /requires a rate_table on every container/);
  // Both objectives price the same billed weight, so both need the divisor. There is no
  // library-chosen default: a wrong guess would silently misprice every shipment.
  assert.throws(() => packFallback(request(
    [cube('a', 100)],
    [box('c', 200, 200, 200, { rate_table: { weight_brackets_g: [1500], prices_minor: [100] } })],
    { configuration: { objective: 'lowest_landed_cost' } },
  )), /requires configuration\.dimensional_weight_divisor/);
});

// ---------------------------------------------------- staged rollout

test('the guard refuses exactly the fields the unsupported lists name', () => {
  // A field this engine has not implemented is rejected rather than ignored: an engine
  // that reads a request it does not fully understand and answers confidently is
  // indistinguishable, from the outside, from one that honoured every field. The lists
  // are empty while this engine is current with the shared schema, and this test is what
  // holds a future staging to the same guard rather than to a hand-written throw.
  assert.deepEqual(Object.keys(UNSUPPORTED_FIELDS).sort(),
    ['configuration', 'container', 'item', 'obstacle', 'request']);
  const named = Object.values(UNSUPPORTED_FIELDS).flat();
  assert.deepEqual(named, [], `staged fields still unimplemented: ${named.join(', ')}`);
  const carrying = {
    request: (field) => ({ [field]: {} }),
    configuration: (field) => ({ configuration: { [field]: {} } }),
  };
  for (const [scope, fields] of Object.entries(UNSUPPORTED_FIELDS)) {
    const build = carrying[scope];
    if (build === undefined) continue;
    for (const field of fields) {
      let error;
      assert.throws(() => packFallback(request(
        [cube('a')], [box('c')], build(field),
      )), (thrown) => { error = thrown; return thrown instanceof UnsupportedFeatureError });
      assert.equal(error.code, 'unsupported_feature');
      assert.ok(error.fields.includes(scope === 'request' ? field : `${scope}.${field}`));
    }
  }
});

test('a policy rule set is honoured rather than refused', () => {
  // The staged rollout that began with this engine refusing the block is closed:
  // segregation opens a second container here, and a request that packed both items
  // together would be indistinguishable from one that ignored the rule.
  const withRule = (rules) => request(
    [cube('a', 100, { tags: ['hazmat'] }), cube('b', 100, { tags: ['food'] })],
    [box('c', 300, 300, 300, { quantity: 2 })],
    { policy: { as_of: 1754870400000, rules } },
  );
  assert.equal(packFallback(withRule([])).summary.container_count, 1);
  assert.equal(packFallback(withRule([{
    id: 'hazmat-food-segregation',
    version: 1,
    effective_at: 0,
    priority: 100,
    separate_tags: { tag: 'hazmat', from_tag: 'food' },
  }])).summary.container_count, 2);
});

test('a malformed tariff is rejected rather than silently mispricing', () => {
  const cases = [
    [{ weight_brackets_g: [1500, 500], prices_minor: [100, 200] }, /strictly ascending/],
    [{ weight_brackets_g: [500, 1500], prices_minor: [100] }, /same length/],
    [{ weight_brackets_g: [], prices_minor: [] }, /non-empty/],
    [{ weight_brackets_g: [0], prices_minor: [100] }, /positive safe integers/],
    [{ weight_brackets_g: [500], prices_minor: [-1] }, /non-negative safe integers/],
    [{ weight_brackets_g: [500], prices_minor: [100], fuel_surcharge_permille: -1 }, /fuel_surcharge_permille/],
  ];
  for (const [table, expected] of cases) {
    assert.throws(() => packFallback(landed(table, '200 g')), expected);
  }
});

test('a request that omits value reproduces the default result byte-for-byte', () => {
  const containers = [box('c', 120, 40, 40)];
  const withoutValue = packFallback(request([cube('a', 40, { quantity: 3 })], containers));
  const withValue = packFallback(request([cube('a', 40, { quantity: 3, value: 7 })], containers));
  assert.deepEqual(withoutValue.score, withValue.score);
  assert.deepEqual(
    withoutValue.containers.map((c) => c.placements.map((p) => [p.position, p.orientation])),
    withValue.containers.map((c) => c.placements.map((p) => [p.position, p.orientation])),
  );
});

test('a negative value fails admission instead of being ignored', () => {
  assert.throws(
    () => packFallback(request([cube('a', 10, { value: -1 })], [box('c')])),
    /value must be a non-negative safe integer/,
  );
});

// The closed-form lattice path, asserted directly rather than exempted. The two
// tests above pin the *searching* path deliberately; these pin this one, so neither is
// covered only by accident of which solver a fixture happens to reach.

test('the lattice path reports no collision or support work, because it does none', () => {
  const result = packFallback(request(
    [cube('a', 40, { quantity: 3 })], [box('c', 100, 100, 100)],
    { configuration: { require_placement_coordinates: false } },
  ));
  const { metrics } = result.algorithm;

  // Zero is the correct answer, not a missing one: a regular lattice is disjoint by
  // construction, so there is no pair to test and no supporter to look up. Reporting a
  // non-zero count here would describe work that never happened.
  assert.equal(metrics.collision_checks, 0);
  assert.equal(metrics.support_checks, 0);

  // Everything a caller can still compare across paths must be present and coherent.
  const fields = [
    'candidate_points_considered', 'orientations_considered', 'feasible_candidates',
    'collision_checks', 'support_checks', 'space_partitions', 'search_nodes_expanded',
  ];
  assert.ok(fields.every((field) => Number.isSafeInteger(metrics[field]) && metrics[field] >= 0));
  assert.equal(metrics.orientations_considered, result.algorithm.placements_attempted);
  assert.equal(metrics.feasible_candidates, result.algorithm.candidates_evaluated);
  assert.ok(metrics.search_nodes_expanded > 0);
});

test('the lattice path honours an already-expired injected clock', () => {
  // Same idiom as `checkBudgetClock`: the clock advances one tick per read, so the
  // deadline is already behind us by the time the path asks. A constant clock never
  // expires -- `Deadline` measures elapsed time from its own first read.
  const result = packFallback(request(
    [cube('a', 20, { quantity: 8 })], [box('c')],
    { configuration: { time_limit_ms: 1, require_placement_coordinates: false } },
  ), checkBudgetClock());

  // No partial answer is asserted, and that is the point: this path emits a whole batch
  // or none, so "packed three of eight" is a shape it cannot produce and a test
  // demanding it would be demanding an invented number.
  assert.equal(result.algorithm.time_limit_reached, true);
  assert.equal(result.summary.packed_item_count, 0);
  assert.equal(result.summary.unpacked_item_count, 8);
  assert.equal(result.unpacked_items[0].reason, 'time_limit');
});

test('the lattice path picks the container the objective rewards, not the roomiest', () => {
  const result = packFallback(request(
    [cube('a', 50, { quantity: 4 })],
    [box('roomy', 400, 400, 400), box('snug', 100, 100, 100)],
    { configuration: { require_placement_coordinates: false } },
  ));

  // Both hold all four. Ranking by raw capacity would open `roomy` and leave it almost
  // empty; the objective's unused-volume key says otherwise. This is the defect that
  // scored 500000 against Python's 23437 on regression-many-container-types.
  assert.equal(result.containers.length, 1);
  assert.equal(result.containers[0].container_type, 'snug');
  assert.equal(result.summary.unpacked_item_count, 0);
});

// ------------------------------------------------- exact-small and restarts

const bar = (id, length) => ({ id, dimensions: mm(length, 1, 1) });

test('exact_small searches rather than relabelling the greedy pass', () => {
  // A one-dimensional bin of length 10. Greedy takes the six and strands both fives;
  // an exhaustive search takes the two fives and fills the bin exactly. Before this
  // task the fallback answered `a-six` alone and still called itself `exact_small`.
  const result = packFallback(request(
    [bar('a-six', 6), bar('b-five', 5), bar('c-five', 5)],
    [{ id: 'bin', quantity: 1, inner_dimensions: mm(10, 1, 1) }],
    { configuration: { solvers: ['exact_small'], max_containers: 1 } },
  ));

  assert.deepEqual(
    placements(result).map((placement) => placement.item_type).sort(),
    ['b-five', 'c-five'],
  );
  assert.equal(result.summary.unpacked_item_count, 1);
});

test('exact_small evaluates later containers against the requested objective', () => {
  const payload = request(
    [cube('cube', 10, { quantity: 4, allowed_rotations: ['LWH'] })],
    [
      box('a-tall', 10, 10, 40, { quantity: 1, cost_minor: 0 }),
      box('b-flat', 20, 20, 10, { quantity: 1, cost_minor: 100 }),
    ],
    { configuration: {
      solvers: ['exact_small'], objective: 'open_dimension_height',
      max_containers: 1, time_limit_ms: 60_000,
    } },
  );
  const result = packFallback(payload);

  assert.equal(result.complete, true);
  assert.equal(result.containers[0].container_type, 'b-flat');
  assert.deepEqual(result.score, [0, 10 * MM, 1, 100, 0]);

  // Root plus four placements consumes this exact deterministic prefix. The complete
  // first-container incumbent survives when the shared effort budget prevents the
  // objective-improving second container from being searched.
  const limited = packFallback({
    ...payload,
    configuration: {
      ...payload.configuration,
      effort_budget: {
        max_candidates_evaluated: 1_000_000,
        max_placement_attempts: 1_000_000,
        max_search_nodes: 5,
      },
    },
  });
  assert.equal(limited.complete, true);
  assert.equal(limited.containers[0].container_type, 'a-tall');
  assert.equal(limited.algorithm.metrics.search_nodes_expanded, 5);
  assert.equal(limited.algorithm.effort_limit_reached, true);
});

test('exact_small searches equal-count branches for a better objective tie-break', () => {
  const payload = request(
    [
      { id: 'i0', dimensions: mm(1, 6, 3), allowed_rotations: ['LWH'] },
      { id: 'i1', dimensions: mm(6, 3, 2), allowed_rotations: ['LWH'] },
      { id: 'i2', dimensions: mm(1, 6, 3), allowed_rotations: ['LWH'] },
      { id: 'i3', dimensions: mm(2, 3, 4), allowed_rotations: ['LWH'] },
    ],
    [box('bin', 8, 8, 8, { quantity: 1 })],
    { configuration: {
      solvers: ['exact_small'], objective: 'open_dimension_height',
      max_containers: 1, time_limit_ms: 60_000,
    } },
  );
  const result = packSound(payload);
  const repeated = packFallback(payload);

  assert.equal(result.complete, true);
  assert.deepEqual(result.score, [0, 4 * MM, 1, 0, 812_500]);
  assert.deepEqual(
    repeated.containers[0].placements.map(placement => [placement.item_id, at(placement), placement.orientation]),
    result.containers[0].placements.map(placement => [placement.item_id, at(placement), placement.orientation]),
  );
});

test('exact_small stops at an admissible complete objective floor', () => {
  const payload = request(
    [cube('cube', 45, { quantity: 8, allowed_rotations: ['LWH'] })],
    [box('bin', 90, 90, 90, { quantity: 1 })],
    { configuration: {
      solvers: ['exact_small'], solver_profile: 'exact_small', exact_item_limit: 8,
      max_containers: 1,
      time_limit_ms: 60_000,
      effort_budget: {
        max_candidates_evaluated: 1_000_000,
        max_placement_attempts: 1_000_000,
        max_search_nodes: 1_000_000,
      },
    } },
  );

  const result = packFallback(payload);

  assert.equal(result.complete, true);
  assert.deepEqual(result.score, [0, 1, 0, 0, 1_000_000]);
  assert.equal(result.algorithm.metrics.search_nodes_expanded, 9);
  assert.equal(result.algorithm.time_limit_reached, false);
  assert.equal(result.algorithm.effort_limit_reached, false);
});

test('exact_small keeps its payload-tightened height floor admissible', () => {
  const result = packFallback(request(
    [
      { id: 'large-tall', dimensions: mm(10, 10, 8), weight: '1' },
      { id: 'small-short', dimensions: mm(1, 1, 1), weight: '1' },
    ],
    [box('bin', 10, 10, 10, { max_payload: '1' })],
    { configuration: {
      solvers: ['exact_small'], objective: 'open_dimension_height', max_containers: 1,
    } },
  ));

  // The volume pass says both items fit, but payload permits only one. The lower bound
  // must recompute its smallest-volume prefix after that tighter count; otherwise it
  // overstates the unavoidable height and incorrectly prunes the short-item branch.
  assert.deepEqual(placements(result).map(placement => placement.item_type), ['small-short']);
  assert.deepEqual(result.score, [1, MM, 1, 0, 999_000]);
});

test('exact_small never claims global optimality', () => {
  // The search is exact only for the discrete candidate model and the item count, which
  // is exactly what the three reference engines report too.
  const result = packFallback(request(
    [bar('a-six', 6), bar('b-five', 5), bar('c-five', 5)],
    [{ id: 'bin', quantity: 1, inner_dimensions: mm(10, 1, 1) }],
    { configuration: { solvers: ['exact_small'], max_containers: 1 } },
  ));
  assert.equal(result.optimality.code, 'best_found');
});

test('every requested restart runs and is recorded', () => {
  // `multi_start_orders` used to be accepted and never read: eight restarts produced one
  // run, one start record and no extra work.
  const build = (starts) => packFallback(request(
    [cube('a', 30, { quantity: 3 }), cube('b', 25, { quantity: 4 }), cube('c', 20, { quantity: 5 })],
    [box('box', 60, 50, 40, { quantity: 3 })],
    { configuration: { multi_start_orders: starts, seed: 42 } },
  ));

  const one = build(1);
  const eight = build(8);
  assert.equal(one.termination.starts.length, 1);
  assert.equal(eight.termination.starts.length, 8);
  assert.ok(
    eight.algorithm.metrics.search_nodes_expanded > one.algorithm.metrics.search_nodes_expanded,
    'eight restarts must cost more search than one',
  );
  assert.equal(eight.termination.starts.filter((start) => start.selected).length, 1);
});

test('explicit solvers retain every nested restart record and honour max_restarts', () => {
  // The first cartesian-portfolio implementation executed every run, but the outer
  // solver loop collapsed each solver's restarts to one synthetic record. It also
  // ignored max_restarts, unlike Python, PHP and Rust. Four is a total portfolio cap:
  // three exact-small orders followed by the first extreme-point order.
  const result = packFallback(request(
    [cube('a', 30), cube('b', 25), cube('c', 20)],
    [box('box', 60, 50, 40, { quantity: 2 })],
    { configuration: {
      solvers: ['exact_small', 'extreme_points'],
      multi_start_orders: 3,
      effort_budget: { max_restarts: 4 },
      time_limit_ms: 60_000,
    } },
  ));

  assert.deepEqual(
    result.termination.starts.map((start) => start.id),
    [
      'exact_small:javascript_fallback',
      'exact_small:javascript_fallback:seeded_1',
      'exact_small:javascript_fallback:seeded_2',
      'extreme_points:javascript_fallback',
    ],
  );
  assert.equal(result.termination.starts.every((start) => start.started), true);
  const selected = result.termination.starts.filter((start) => start.selected);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, result.algorithm.solver);
});

test('all restarts share one absolute deadline and preserve unstarted records', () => {
  let tick = -1;
  const result = packFallback(request(
    [cube('a', 30), cube('b', 25)],
    [box('box', 60, 50, 40)],
    { configuration: { multi_start_orders: 3, time_limit_ms: 1 } },
  ), () => ++tick);

  assert.equal(result.termination.starts.length, 3);
  assert.equal(result.termination.starts.filter((start) => start.started).length, 1);
  assert.equal(result.termination.starts.filter((start) => !start.started).length, 2);
  assert.equal(result.termination.global_deadline_reached, true);
  assert.equal(result.termination.code, 'time_limit');
});

test('restart orderings are a pure function of the seed', () => {
  const build = (seed) => packFallback(request(
    [cube('a', 30, { quantity: 3 }), cube('b', 25, { quantity: 4 }), cube('c', 20, { quantity: 5 })],
    [box('box', 60, 50, 40, { quantity: 3 })],
    { configuration: { multi_start_orders: 6, seed } },
  ));
  assert.deepEqual(build(7).score, build(7).score);
  assert.deepEqual(placements(build(7)).map(at), placements(build(7)).map(at));
});

test('a single start reproduces the no-restart result exactly', () => {
  // Start 0 is the unshuffled ordering, so adding restarts can only ever improve on it.
  const items = [cube('a', 30, { quantity: 3 }), cube('b', 25, { quantity: 4 })];
  const containers = [box('box', 60, 50, 40, { quantity: 3 })];
  const without = packFallback(request(items, containers));
  const withOne = packFallback(request(items, containers, { configuration: { multi_start_orders: 1 } }));
  assert.deepEqual(placements(withOne).map(at), placements(without).map(at));
});

test('a nonsensical restart count is refused at admission', () => {
  assert.throws(
    () => packFallback(request([cube('a')], [box('b')], { configuration: { multi_start_orders: 0 } })),
    /multi_start_orders/,
  );
});

test('more counted homogeneous-block effort cannot worsen the objective', () => {
  const build = (containerPlanNodeLimit) => request(
    [
      cube('large', 100, { quantity: 8 }),
      { id: 'small', quantity: 20, dimensions: mm(60, 50, 40) },
    ],
    [box('box', 300, 200, 200, { quantity: 1 })],
    { configuration: {
      solver_profile: 'quality', solvers: ['homogeneous_blocks'],
      multi_start_orders: 1, time_limit_ms: 5_000,
      container_plan_beam_width: 16,
      container_plan_node_limit: containerPlanNodeLimit,
    } },
  );
  const lowRequest = build(1); const highRequest = build(100_000);
  const low = packFallback(lowRequest); const high = packFallback(highRequest);
  assert.equal(compareScores(high.score, low.score) <= 0, true);
  assert.deepEqual(validate(highRequest, high), []);
});

test('homogeneous-block search falls back for placement-distinguishing rules', () => {
  const payload = request(
    [cube('fragile', 100, { quantity: 2, stackable: false })],
    [box('box', 100, 100, 200, { quantity: 1 })],
    { configuration: {
      solver_profile: 'quality', solvers: ['homogeneous_blocks'],
      multi_start_orders: 1, time_limit_ms: 5_000,
    } },
  );
  const result = packFallback(payload);
  assert.equal(result.summary.packed_item_count, 1);
  assert.match(result.algorithm.solver, /^homogeneous_blocks:/);
  assert.deepEqual(validate(payload, result), []);
});

function compareScores(left, right) {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}
