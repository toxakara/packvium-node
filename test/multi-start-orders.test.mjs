import assert from 'node:assert/strict';
import test from 'node:test';

import { packFallback } from '../fallback.js';

/**
 * Starts the JavaScript engine runs when the request does not say.
 *
 * Eight orderings outside `fast`, one under it, as Python, PHP and Rust default to; the
 * effort budget is the request's, shared by every start; and a shuffled ordering keeps the
 * lead keys, so priority survives a restart.
 */

const cube = (id, side, extra = {}) => ({
  id, weight: '1 kg', dimensions: { length: String(side), width: String(side), height: String(side) }, ...extra,
});
const scene = (configuration = {}, items = [cube('a', 10, { quantity: 20 })]) => ({
  units: { length: 'mm' },
  configuration: { time_limit_ms: 60_000, ...configuration },
  items,
  containers: [{ id: 'c', quantity: 1, inner_dimensions: { length: '100', width: '100', height: '100' } }],
});
const startCount = (result) => result.termination.starts.length;

test('balanced and quality run eight orderings by default, fast runs one', () => {
  assert.equal(startCount(packFallback(scene())), 8);
  assert.equal(startCount(packFallback(scene({ solver_profile: 'fast' }))), 1);
  assert.equal(startCount(packFallback(scene({ solver_profile: 'fast', multi_start_orders: 8 }))), 1);
  assert.equal(startCount(packFallback(scene({ multi_start_orders: 3 }))), 3);
});

test('the effort budget is shared by every start', () => {
  const result = packFallback(scene({ effort_budget: { max_search_nodes: 5 } }));
  assert.equal(result.algorithm.metrics.search_nodes_expanded, 5);
  assert.equal(result.termination.code, 'effort_limit');
  assert.deepEqual(result.termination.starts.map((start) => [start.started, start.truncated]),
    [[true, true], ...Array.from({ length: 7 }, () => [true, true])]);
});

test('start 0 leads with priority; shuffled starts are free shuffles', () => {
  // Start 0 respects priority. Later starts re-solve a plain shuffle, allowing the portfolio
  // to try low-priority items first (JS gap 2 revert).
  const items = [cube('big', 100), cube('small', 10, { priority: 5 })];
  const start0 = packFallback(scene({}, items), Date.now, null, 0);
  assert.deepEqual(start0.containers.flatMap((c) => c.placements.map((p) => p.item_id)), ['small#1']);
  const start4 = packFallback(scene({}, items), Date.now, null, 4);
  assert.deepEqual(start4.containers.flatMap((c) => c.placements.map((p) => p.item_id)), ['big#1']);
});
