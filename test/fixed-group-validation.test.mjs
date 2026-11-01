import assert from 'node:assert/strict';
import test from 'node:test';

import { InvalidRequestError, packFallback } from '../fallback.js';

const dimensions = (length = '10') => ({ length, width: '10', height: '10' });
const request = (configuration = {}) => ({
  configuration: { solver_profile: 'fast', solvers: ['extreme_points'], time_limit_ms: 300000,
    max_containers: 2, ...configuration },
  items: [{ id: 'cube', quantity: 2, group: 'g', dimensions: dimensions() }],
  containers: [{ id: 'box', inner_dimensions: dimensions() }],
  fixed_placements: [{ item_type: 'cube', container_type: 'box', orientation: 'LWH' }],
});

function assertInvalid(result, complete, warning) {
  assert.equal(result.status, 'invalid_result');
  assert.deepEqual(result.feasibility, { code: 'unknown' });
  assert.equal(result.termination.code, 'error');
  assert.deepEqual(result.optimality, { code: 'not_proven' });
  assert.equal(result.complete, complete);
  assert.ok(result.warnings.includes(warning), JSON.stringify(result.warnings));
}

test('a group split across its fixed container and a fresh one is invalid', () => {
  assertInvalid(packFallback(request()), true, 'group_split: g: box#1, box#2');
});

test('an anchored group with a free member left unpacked is invalid', () => {
  assertInvalid(packFallback(request({ max_containers: 1 })), false, 'group_partial: g: 1/2 packed');
});

test('an anchored group that fits together remains a valid complete result', () => {
  const data = request();
  data.containers[0].inner_dimensions = dimensions('20');
  const result = packFallback(data);
  assert.equal(result.complete, true);
  assert.equal(result.feasibility.code, 'feasible');
  assert.equal(result.termination.code, 'complete');
  assert.equal(result.containers.length, 1);
  assert.equal(result.containers[0].placements.length, 2);
  assert.ok(!result.warnings.some((warning) => warning.startsWith('group_')));
});

test('leaving every member of a group unpacked does not partially pack it', () => {
  const data = request();
  delete data.fixed_placements;
  const result = packFallback(data);
  assert.equal(result.complete, false);
  assert.notEqual(result.status, 'invalid_result');
  assert.equal(result.containers.length, 0);
  assert.equal(result.unpacked_items.length, 2);
  assert.ok(!result.warnings.some((warning) => warning.startsWith('group_')));
});

test('validate_result remains an unknown serialized field', () => {
  assert.throws(() => packFallback(request({ validate_result: false })),
    (error) => error instanceof InvalidRequestError && error.field === '/configuration/validate_result');
});

test('null groups are ungrouped and can occupy separate containers', () => {
  const data = request();
  data.items[0].group = null;
  const result = packFallback(data);
  assert.notEqual(result.status, 'invalid_result');
  assert.equal(result.complete, true);
  assert.equal(result.feasibility.code, 'feasible');
});

test('an empty string names a real group, as in the other ports', () => {
  const data = request();
  data.items[0].group = '';
  assertInvalid(packFallback(data), true, 'group_split: : box#1, box#2');
});

test('each alternative receives its own group validation result', () => {
  const result = packFallback(request({ solver_profile: 'balanced', solvers: ['extreme_points', 'layer'], alternatives: 3 }));
  assert.ok(result.alternatives.length > 0);
  for (const alternative of result.alternatives) {
    assertInvalid(alternative, true, 'group_split: g: box#1, box#2');
  }
});

test('group accounting combines fixed and free members of distinct item types', () => {
  const data = request({ max_containers: 1 });
  data.items = [{ id: 'cube', group: 'g', dimensions: dimensions() },
    { id: 'other', quantity: 2, group: 'g', dimensions: dimensions() }];
  assertInvalid(packFallback(data), false, 'group_partial: g: 1/3 packed');
});
