/**
 * `placement_id` (1.10): the canonical JSON of `[container id, x, y, z, item type, orientation]`,
 * a pure function of a placement. Emitted on every result placement, recomputed by the
 * validator, restated optionally by a fixed placement and copied into the execution plan.
 *
 * Mirrors `packvium-python/tests/test_placement_id.py`; the refusal and issue texts are asserted
 * whole because they are compared across engines.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOperationalArtifact } from '@packvium/engine/artifacts.js';
import { ExecutionPlanError, buildExecutionPlan, placementReference } from '@packvium/engine/execution.js';
import { PlanRevisionError, deriveRevision, rootRevision } from '@packvium/engine/revisions.js';
import { canonicalIdentifier } from '../canonical-json.js';
import { FixedPlacementError, packFallback, rebalanceWeight } from '../fallback.js';
import { validateDocuments } from '../result-validation/index.js';
import { validate as oracle } from './validate.mjs';

const MM = 16000;
const dims = (length, width, height) => ({ length: String(length), width: String(width), height: String(height) });

function request(containerId = 'box', quantity = 4, extra = {}) {
  return {
    configuration: { solver_profile: 'balanced', alternatives: 3 },
    items: [{ id: 'cube', quantity, dimensions: dims(100, 100, 100) }],
    containers: [{ id: containerId, quantity: 3, inner_dimensions: dims(200, 100, 100) }],
    ...extra,
  };
}

const ident = (containerId, x, y, z, itemType = 'cube', orientation = 'LWH') =>
  JSON.stringify([containerId, x, y, z, itemType, orientation]);
const expectedId = (container, placement) => ident(container.id,
  ...['x', 'y', 'z'].map((axis) => placement.position[axis].ticks), placement.item_type, placement.orientation);
const pack = (body) => packFallback(body);
const issuesOf = (body, result) => validateDocuments(body, result).issues;

function* everyPlacement(result) {
  for (const document of [result, ...(result.alternatives ?? [])]) {
    for (const container of document.containers) {
      for (const placement of container.placements) yield [container, placement];
    }
  }
}

for (const containerId of ['box', 'a@b#c', 'böx-箱', 'q"uo\\te\n ']) {
  test(`every placement of the answer and its alternatives carries its id: ${JSON.stringify(containerId)}`, () => {
    const body = request(containerId);
    const result = pack(body);
    const placements = [...everyPlacement(result)];
    assert.ok(placements.length >= 4);
    for (const [container, placement] of placements) assert.equal(placement.placement_id, expectedId(container, placement));
    assert.deepEqual(issuesOf(body, result), []);
    assert.deepEqual(oracle(body, result), []);
  });
}

test('a tampered id is a mismatch naming both', () => {
  const result = pack(request());
  const placement = result.containers[0].placements[0];
  const expected = expectedId(result.containers[0], placement);
  placement.placement_id = ident('box#1', 1, 2, 3);
  assert.deepEqual(issuesOf(request(), result), [{
    code: 'placement_id_mismatch',
    detail: `${placement.item_id} in box#1: reported ${ident('box#1', 1, 2, 3)}, expected ${expected}`,
  }]);
  assert.deepEqual(oracle(request(), result), ['placement_id_mismatch']);
});

test('a missing or non-string id is a mismatch', () => {
  for (const tamper of [(placement) => { delete placement.placement_id; }, (placement) => { placement.placement_id = 7; }]) {
    const result = pack(request());
    const placement = result.containers[0].placements[0];
    tamper(placement);
    const issues = issuesOf(request(), result);
    assert.deepEqual(issues.map((found) => found.code), ['placement_id_mismatch']);
    assert.equal(issues[0].detail, `${placement.item_id} in box#1: no placement_id, expected ${expectedId(result.containers[0], placement)}`);
    assert.deepEqual(oracle(request(), result), ['placement_id_mismatch']);
  }
});

test('a repeated id is a duplicate, after its mismatch', () => {
  const result = pack(request());
  const [first, second] = result.containers[0].placements;
  second.placement_id = first.placement_id;
  assert.deepEqual(issuesOf(request(), result), [
    { code: 'placement_id_mismatch', detail: `${second.item_id} in box#1: reported ${first.placement_id}, expected ${expectedId(result.containers[0], second)}` },
    { code: 'duplicate_placement_id', detail: first.placement_id },
  ]);
  assert.deepEqual(oracle(request(), result), ['placement_id_mismatch', 'duplicate_placement_id']);
});

test('a lone surrogate in an id is written as its lowercase escape', () => {
  assert.equal(canonicalIdentifier(['b\uDC00x', 1, 'c\uD83D']), '["b\\udc00x",1,"c\\ud83d"]');
  assert.equal(canonicalIdentifier(['\u{1F600}\u0001\u007f']), '["\u{1F600}\\u0001\u007f"]');
  const body = request('b\uDC00x');
  const result = pack(body);
  assert.ok(result.containers[0].placements[0].placement_id.startsWith('["b\\udc00x#1",'));
  assert.deepEqual(issuesOf(body, result), []);
  assert.deepEqual(oracle(body, result), []);
});

test('a lattice summary has no placements and so no ids', () => {
  const body = request('box', 2);
  body.configuration = { solver_profile: 'fast', require_placement_coordinates: false };
  const result = pack(body);
  assert.ok(result.containers.every((container) => container.placements.length === 0));
  assert.deepEqual(issuesOf(body, result), []);
});

test('a lattice answer with coordinates names each placement', () => {
  const body = request('box', 2);
  body.configuration = { solver_profile: 'fast' };
  const result = pack(body);
  for (const [container, placement] of everyPlacement(result)) assert.equal(placement.placement_id, expectedId(container, placement));
  assert.deepEqual(issuesOf(body, result), []);
});

test('a rebalanced placement is named where it now sits', () => {
  const body = {
    items: [{ id: 'heavy', quantity: 2, weight: '5000', dimensions: dims(100, 100, 100) }],
    containers: [{ id: 'box', quantity: 2, inner_dimensions: dims(200, 100, 100) }],
  };
  const original = pack(body);
  const rebalanced = rebalanceWeight(body, original);
  for (const container of rebalanced.containers) {
    for (const placement of container.placements) assert.equal(placement.placement_id, expectedId(container, placement));
  }
});

// ------------------------------------------------------------------ fixed placements

const fixedRequest = (placement) => request('box', 4, {
  fixed_placements: [{ item_type: 'cube', container_type: 'box', position: { x: '100' }, orientation: 'LWH', ...placement }],
});

function refusal(body) {
  try {
    pack(body);
  } catch (error) {
    assert.ok(error instanceof FixedPlacementError);
    return error;
  }
  return assert.fail('the request was answered');
}

test('a fixed placement may quote the id its result placement carries, and null is absent', () => {
  const result = pack(fixedRequest({ placement_id: ident('box#1', 100 * MM, 0, 0) }));
  const fixed = result.containers[0].placements.filter((placement) => placement.fixed);
  assert.deepEqual(fixed.map((placement) => placement.placement_id), [ident('box#1', 100 * MM, 0, 0)]);
  assert.equal(pack(fixedRequest({ placement_id: null })).status, 'feasible');
});

test('a fixed id naming another place is refused', () => {
  const error = refusal(fixedRequest({ placement_id: ident('box#1', 0, 0, 0) }));
  assert.deepEqual([error.code, error.reason, error.field], ['invalid_fixed_placement', 'invalid_value', '/fixed_placements/0/placement_id']);
  assert.equal(error.message,
    `invalid_fixed_placement: fixed_placements[0].placement_id must be ${JSON.stringify(ident('box#1', 100 * MM, 0, 0))}`);
});

test('a fixed id counts the instance and defaults it to one', () => {
  const error = refusal(fixedRequest({ container_instance: 2, position: {}, placement_id: ident('box#1', 0, 0, 0) }));
  assert.ok(error.detail.endsWith(JSON.stringify(ident('box#2', 0, 0, 0))));
});

test('a fixed id past every exact integer is left to admission', () => {
  const error = refusal(fixedRequest({ position: { x: { value: String(2 ** 53), unit: 'ticks' } }, placement_id: ident('box#1', 0, 0, 0) }));
  assert.equal(error.reason, 'cannot_hold');
  assert.ok(error.detail.includes('outside_container'), error.detail);
});

test('a fixed id that is not a string is malformed', () => {
  const error = refusal(fixedRequest({ placement_id: 7 }));
  assert.deepEqual([error.reason, error.field, error.detail],
    ['malformed', '/fixed_placements/0/placement_id', 'fixed_placements[0].placement_id is a string']);
});

// ------------------------------------------------------------------ execution plan and artifact

const withoutIds = (result) => {
  const projection = JSON.parse(JSON.stringify(result));
  for (const container of projection.containers) for (const placement of container.placements) delete placement.placement_id;
  return projection;
};

test('the plan copies each id and a projection without ids keeps its bytes', () => {
  const result = pack(request());
  const plan = buildExecutionPlan(request(), result);
  const references = plan.containers.flatMap((container) => container.steps.map((step) => step.placement));
  assert.deepEqual(references.map((reference) => reference.placement_id),
    result.containers.flatMap((container) => container.placements.map((placement) => placement.placement_id)));
  const bare = buildExecutionPlan(request(), withoutIds(result));
  assert.ok(bare.containers.every((container) => container.steps.every((step) => !('placement_id' in step.placement))));
  assert.deepEqual(Object.keys(placementReference(0, result.containers[0].placements[0])).sort(),
    ['container_index', 'item_type', 'orientation', 'position_ticks']);
});

test('a plan with a non-string or empty id is refused', () => {
  for (const [identifier, spelled] of [[3, '3'], ['', "''"], [null, 'None']]) {
    const result = pack(request());
    result.containers[0].placements[0].placement_id = identifier;
    assert.throws(() => buildExecutionPlan(request(), result),
      (error) => error instanceof ExecutionPlanError && error.message === `placement_id ${spelled} is not a non-empty string`);
  }
});

test('the artifact v1 carries no id', () => {
  const result = pack(request());
  const artifact = buildOperationalArtifact(request(), result);
  assert.ok(!JSON.stringify(artifact).includes('placement_id'));
  assert.deepEqual(artifact, buildOperationalArtifact(request(), withoutIds(result)));
});

// ------------------------------------------------------------------ revisions

test('a lock event may carry the id and is one box with the same entry without it', () => {
  const base = request();
  const root = rootRevision(base);
  const artifact = buildOperationalArtifact(base, pack(JSON.parse(JSON.stringify(base))));
  const entry = { item_type: 'cube', container_type: 'box', position: { x: '0', y: '0', z: '0' }, orientation: 'LWH' };
  const quoted = { ...entry, placement_id: ident('box#1', 0, 0, 0) };
  const revision = deriveRevision(root, artifact, [
    { sequence: 1, type: 'placement_locked', placement: quoted },
    { sequence: 2, type: 'placement_verified', placement: entry },
  ]);
  assert.deepEqual(revision.request.fixed_placements, [quoted]);
  assert.throws(() => deriveRevision(root, artifact, [{ sequence: 1, type: 'placement_locked', placement: { ...entry, placement_id: 1 } }]),
    (error) => error instanceof PlanRevisionError && error.message.includes('placement.placement_id is a string'));
});
