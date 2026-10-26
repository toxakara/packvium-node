/**
 * The JavaScript port's copy of the optimality bound, held to the oracle's numbers on the
 * shared scene, and the four checks it feeds, each broken once.
 *
 * The corpus test holds the port to the reference's verdict on every pair the cover keeps; this
 * pins the formulas on every case and refusal edge of `conformance/scene/objective-bounds.json`,
 * volumes carried as decimal strings and read as `BigInt`, never through a `Number`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { lowerBound } from '../result-validation/bound.js';
import { validateWith } from '../index.js';

const SCENE = new URL('../../../../conformance/scene/objective-bounds.json', import.meta.url);

const integer = (value) => BigInt(value);
const optional = (value) => (value === null ? null : BigInt(value));
const runs = (instances, field) => instances.map((instance) => [integer(instance[field]), 1n])
  .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));

function sceneBound(scenario) {
  const containers = scenario.containers.map((container) => ({
    innerVolume: integer(container.inner),
    baseArea: integer(container.base_area),
    height: integer(container.height),
    usable: integer(container.usable),
    costMinor: integer(container.cost_minor),
    payload: optional(container.payload),
    maxItems: optional(container.max_items),
    quantity: optional(container.quantity),
  }));
  const shrinks = scenario.instances.some((instance) => instance.shrinks);
  return lowerBound(runs(scenario.instances, 'volume'), runs(scenario.instances, 'weight'), shrinks, containers);
}

if (!fs.existsSync(SCENE)) {
  test('the shared scene is not part of this package', { skip: true }, () => {});
} else {
  test('the validator bound matches every case and refusal edge of the shared scene', () => {
    const scene = JSON.parse(fs.readFileSync(SCENE, 'utf8'));
    const disagreements = [...scene.cases, ...scene.edges]
      .map((scenario) => ({ name: scenario.name || scenario.fixture, computed: sceneBound(scenario), expected: scenario.bounds }))
      .filter(({ computed, expected }) => JSON.stringify(computed && computed.map(String)) !== JSON.stringify(expected && expected.map(String)));
    assert.deepEqual(disagreements, []);
    assert.ok(scene.cases.length + scene.edges.length > 400);
  });
}

test('an unlimited capacity, a negative one and zero-volume instances are read as the reference reads them', () => {
  const container = {
    innerVolume: 1000n, baseArea: 100n, height: 10n, usable: -1n, costMinor: 3n, payload: 5n, maxItems: null, quantity: 1n,
  };
  assert.deepEqual(lowerBound([[0n, 2n]], [[1n, 2n]], false, [container]), [2n, 0n, 0n, 0n, 0n]);
  assert.deepEqual(lowerBound([[0n, 2n]], [[1n, 2n]], false, [{ ...container, quantity: null }]), [0n, 1n, 3n, 1000000n, 0n]);
  assert.deepEqual(lowerBound([[1n, 1n]], [[0n, 1n]], false, []), [1n, 0n, 0n, 0n, 0n]);
});

/** One cube in a box for two: attains every position but the height, 1000000 against 500000. */
const REQUEST = {
  items: [{ id: 'cube', quantity: 1, dimensions: { length: '10', width: '10', height: '10' } }],
  containers: [{ id: 'box', inner_dimensions: { length: '20', width: '10', height: '10' } }],
};

const MM3 = 16000 ** 3;

function result(optimality) {
  const tick = (mm) => ({ ticks: mm * 16000, value: String(mm), unit: 'mm' });
  return {
    status: 'feasible',
    feasibility: { code: 'feasible' },
    termination: {
      code: 'complete',
      any_start_truncated: false,
      all_required_starts_completed: true,
      winning_start_truncated: false,
      global_deadline_reached: false,
      starts: [{ id: 'test', started: true, completed: true, truncated: false, selected: true, global_deadline_reached: false }],
    },
    optimality,
    complete: true,
    algorithm: {
      solver: 'test',
      time_limit_reached: false,
      effort_limit_reached: false,
      candidates_evaluated: 1,
      placements_attempted: 1,
      metrics: {
        candidate_points_considered: 1,
        orientations_considered: 1,
        feasible_candidates: 1,
        collision_checks: 0,
        support_checks: 0,
        space_partitions: 0,
        search_nodes_expanded: 0,
      },
    },
    score: [0, 1, 0, 500000, 1000000],
    summary: { container_count: 1, packed_item_count: 1, unpacked_item_count: 0 },
    containers: [{
      id: 'box#1',
      container_type: 'box',
      payload_weight: { ticks: 0 },
      used_volume_ticks3: String(1000 * MM3),
      centre_of_mass_offset_ppm: 0,
      placements: [{
        item_id: 'cube#1',
        item_type: 'cube',
        orientation: 'LWH',
        position: { x: tick(0), y: tick(0), z: tick(0) },
        dimensions: { length: tick(10), width: tick(10), height: tick(10) },
      }],
    }],
    unpacked_items: [],
  };
}

const GAP = {
  code: 'not_proven',
  lower_bound: [0, 1, 0, 500000, 500000],
  gap_key: 4,
  absolute_gap: 500000,
  relative_gap: { numerator: 500000, denominator: 500000 },
};

const issuesOf = (optimality, change = () => {}) => {
  const broken = result(JSON.parse(JSON.stringify(optimality)));
  change(broken);
  return validateWith(null, REQUEST, broken).map((found) => found.code);
};

test('a stated bound and gap are valid, and so is their absence', () => {
  assert.deepEqual(issuesOf(GAP), []);
  assert.deepEqual(issuesOf({ code: 'not_proven' }), []);
});

test('each of the four checks fires on its own mutation', () => {
  assert.deepEqual(issuesOf(GAP, (broken) => { broken.optimality.lower_bound[1] = 2; }), ['optimality_bound_mismatch']);
  assert.deepEqual(issuesOf(GAP, (broken) => { broken.optimality.absolute_gap = 1; }), ['optimality_gap_mismatch']);
  assert.deepEqual(issuesOf(GAP, (broken) => { broken.score[3] = 0; }),
    ['score_mismatch', 'score_below_bound', 'optimality_bound_mismatch']);
  assert.deepEqual(issuesOf(GAP, (broken) => {
    broken.status = 'optimal';
    broken.optimality.code = 'proven_optimal';
  }), ['result_fact_mismatch', 'unproven_optimality_claim']);
});

for (const cheapCost of [0, 1]) {
  test(`an unrepresentable gap is withheld and rejected when forged (lower cost ${cheapCost})`, async () => {
    const { packFallback } = await import('../fallback.js');
    const request = {
      items: [{ id: 'i', quantity: 2, dimensions: { length: '10', width: '10', height: '10' } }],
      containers: [
        { id: 'cheap', inner_dimensions: { length: '1', width: '1', height: '1' }, cost_minor: cheapCost, max_items: 1 },
        { id: 'big', inner_dimensions: { length: '10', width: '10', height: '10' }, cost_minor: Number.MAX_SAFE_INTEGER, max_items: 1 },
      ],
    };
    const packed = packFallback(request);
    assert.deepEqual(packed.optimality, { code: 'not_proven' });
    assert.deepEqual(validateWith(null, request, packed), []);
    const absolute = 2 * Number.MAX_SAFE_INTEGER - 2 * cheapCost;
    packed.optimality = { code: 'not_proven', lower_bound: [0, 2, 2 * cheapCost], gap_key: 2, absolute_gap: absolute };
    if (cheapCost) packed.optimality.relative_gap = { numerator: absolute, denominator: 2 * cheapCost };
    assert.ok(validateWith(null, request, packed).some(issue => issue.code === 'optimality_gap_mismatch'));
  });
}

test('a gap at the portable ceiling is still stated', async () => {
  const { packFallback } = await import('../fallback.js');
  const request = {
    items: [{ id: 'i', dimensions: { length: '10', width: '10', height: '10' } }],
    containers: [
      { id: 'cheap', inner_dimensions: { length: '1', width: '1', height: '1' }, cost_minor: 0 },
      { id: 'big', inner_dimensions: { length: '10', width: '10', height: '10' }, cost_minor: Number.MAX_SAFE_INTEGER },
    ],
  };
  const packed = packFallback(request);
  assert.equal(packed.optimality.absolute_gap, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(validateWith(null, request, packed), []);
});
