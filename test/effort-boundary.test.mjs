import assert from 'node:assert/strict';
import test from 'node:test';

import { packFallback } from '../fallback.js';
import { validate } from './validate.mjs';

/**
 * An effort budget stops a search; it is not read off the counters afterwards.
 *
 * A start that finishes having used exactly its budget is not truncated and answers as an
 * unlimited run does; one count short, the guard refuses the next counted step, so the start is
 * truncated with the effort flag; and no counter ever passes its limit, including on the paths
 * that count a run of steps at once -- a lattice batch and a committed block.
 */

const COUNTERS = {
  max_placement_attempts: 'orientations_considered',
  max_candidates_evaluated: 'feasible_candidates',
  max_search_nodes: 'search_nodes_expanded',
};

const box = (id, length, width, height, quantity) => ({
  id, quantity, weight: '1 kg', dimensions: { length: String(length), width: String(width), height: String(height) },
});
const scene = (items, configuration, containerQuantity = 3) => ({
  units: { length: 'mm' },
  configuration: { time_limit_ms: 600_000, ...configuration },
  items,
  containers: [{ id: 'c', quantity: containerQuantity, inner_dimensions: { length: '100', width: '100', height: '100' } }],
});
const withBudget = (request, budget) => ({ ...request, configuration: { ...request.configuration, effort_budget: budget } });
const withoutDuration = (result) => JSON.stringify(result, (key, value) => (key === 'duration_ms' ? undefined : value));

// One extreme-point start, so the start the budget cuts is the one that answers.
const singleStart = scene([box('a', 30, 20, 10, 12), box('b', 40, 40, 25, 4), box('c', 15, 15, 15, 9)],
  { solver_profile: 'fast', solvers: ['extreme_points'] }, 1);
// Two item types that the block solver commits several members at a time.
const blocks = scene([box('a', 20, 20, 20, 40), box('b', 50, 50, 30, 6)], { solver_profile: 'quality', solvers: ['homogeneous_blocks'] });
// One item type, which the compact lattice answers in batches.
const lattice = scene([box('a', 30, 20, 10, 60)], { solver_profile: 'fast' }, 2);

/** The effort contract the reference validator checks, plus a valid packing. */
function assertEffortConsistent(request, result) {
  assert.deepEqual(validate(request, result), []);
  const budget = request.configuration.effort_budget;
  const { metrics, effort_limit_reached: flagged } = result.algorithm;
  let reached = false;
  for (const [limit, counter] of Object.entries(COUNTERS)) {
    if (budget[limit] == null) continue;
    assert.ok(metrics[counter] <= budget[limit], `${counter} ${metrics[counter]} passed ${limit} ${budget[limit]}`);
    reached ||= metrics[counter] === budget[limit];
  }
  if (flagged) assert.ok(reached, 'the effort flag needs a counter at its limit');
  const winner = result.termination.starts.find((start) => start.selected);
  assert.equal(winner.truncated, flagged || result.algorithm.time_limit_reached);
  assert.equal(result.termination.any_start_truncated, result.termination.starts.some((start) => start.truncated));
}

for (const [limit, counter] of Object.entries(COUNTERS)) {
  test(`a start using exactly its ${limit} finishes untruncated, and one short is stopped`, () => {
    const unlimited = packFallback(singleStart);
    const used = unlimited.algorithm.metrics[counter];
    assert.ok(used > 1);

    const exact = withBudget(singleStart, { [limit]: used });
    const atLimit = packFallback(exact);
    assertEffortConsistent(exact, atLimit);
    assert.equal(atLimit.algorithm.effort_limit_reached, false);
    assert.equal(atLimit.termination.code, 'complete');
    assert.deepEqual(atLimit.termination.starts.map((start) => start.truncated), [false]);
    assert.equal(withoutDuration(atLimit), withoutDuration(unlimited));

    const short = withBudget(singleStart, { [limit]: used - 1 });
    const stopped = packFallback(short);
    assertEffortConsistent(short, stopped);
    assert.equal(stopped.algorithm.effort_limit_reached, true);
    assert.equal(stopped.termination.code, 'effort_limit');
    assert.equal(stopped.algorithm.metrics[counter], used - 1);
  });
}

for (const [name, request] of Object.entries({ blocks, lattice })) {
  test(`no counter passes its limit on the ${name} path, and only a stop sets the flag`, () => {
    const unlimited = packFallback(request);
    for (const [limit, counter] of Object.entries(COUNTERS)) {
      const used = unlimited.algorithm.metrics[counter];
      assert.ok(used > 1, `${name} uses ${counter}`);
      for (let value = 1; value <= used + 1; value++) {
        const budgeted = withBudget(request, { [limit]: value });
        const result = packFallback(budgeted);
        assertEffortConsistent(budgeted, result);
        if (value >= used) {
          assert.equal(result.algorithm.effort_limit_reached, false, `${limit}=${value}`);
          assert.equal(withoutDuration(result), withoutDuration(unlimited), `${limit}=${value}`);
        }
      }
    }
  });
}

test('a lattice batch the budget cuts short places what it has room for and stops', () => {
  const request = withBudget(lattice, { max_placement_attempts: 7 });
  const result = packFallback(request);
  assertEffortConsistent(request, result);
  assert.equal(result.summary.packed_item_count, 7);
  assert.equal(result.algorithm.effort_limit_reached, true);
  assert.ok(result.unpacked_items.every((item) => item.reason === 'effort_limit'));
});

test('a block the budget cuts short places its first members and stops', () => {
  const unlimited = packFallback(blocks);
  const request = withBudget(blocks, { max_placement_attempts: 3 });
  const result = packFallback(request);
  assertEffortConsistent(request, result);
  assert.equal(result.algorithm.metrics.orientations_considered, 3);
  assert.equal(result.algorithm.effort_limit_reached, true);
  assert.ok(result.summary.packed_item_count > 0 && result.summary.packed_item_count < unlimited.summary.packed_item_count);
});

test('a later start handed a spent budget is still started and stopped', () => {
  const portfolio = scene([box('a', 30, 20, 10, 12), box('b', 40, 40, 25, 4)], { multi_start_orders: 3 }, 1);
  const first = packFallback(withBudget(portfolio, { max_restarts: 1 }));
  const request = withBudget(portfolio, { max_search_nodes: first.algorithm.metrics.search_nodes_expanded });
  const result = packFallback(request);
  assertEffortConsistent(request, result);
  const [own, ...later] = result.termination.starts;
  assert.deepEqual([own.started, own.truncated], [true, false]);
  assert.ok(later.length >= 2);
  for (const start of later) assert.deepEqual([start.started, start.truncated], [true, true]);
});

test('a named block solver outside quality reaches its first block', () => {
  // Both profiles leave container_plan_node_limit at one, short of the first block.
  for (const solver_profile of ['fast', 'balanced']) {
    const request = { ...blocks, configuration: { ...blocks.configuration, solver_profile } };
    const result = packFallback(request);
    assert.deepEqual(validate(request, result), []);
    assert.equal(result.summary.packed_item_count, 46, solver_profile);
    assert.equal(result.termination.code, 'complete', solver_profile);
  }
});

test('a node limit stop is the search answer, not a time limit', () => {
  const request = { ...blocks, configuration: { ...blocks.configuration, container_plan_node_limit: 1 } };
  const result = packFallback(request);
  assert.deepEqual(validate(request, result), []);
  assert.equal(result.summary.packed_item_count, 0);
  assert.equal(result.algorithm.time_limit_reached, false);
  assert.equal(result.termination.code, 'complete');
});
