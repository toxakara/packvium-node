/**
 * The execution-plan adapter in JavaScript.
 *
 * docs/EXECUTION-PLAN.md is the contract and `packvium.execution` is the reference. The
 * same properties are held here as in the other three implementations, because the bar is
 * byte-identical output and a property proved on one side of that proves half of it.
 *
 * JavaScript needs one assertion the others do not: `JSON.stringify` emits insertion order,
 * so the canonical form depends on this module sorting keys itself.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  ExecutionPlanError,
  FORMAT,
  buildExecutionPlan,
  canonicalPlanJson,
  placementReference,
} from '../execution.js';

const scalar = (ticks) => ({ ticks, value: String(Math.trunc(ticks / 16000)), unit: 'mm' });

const placement = (itemType, x) => ({
  item_id: `${itemType}#${x}`,
  item_type: itemType,
  orientation: 'LWH',
  position: { x: scalar(x), y: scalar(0), z: scalar(0) },
  dimensions: { length: scalar(1600000), width: scalar(1600000), height: scalar(1600000) },
  support_ratio: 1.0,
  top_load: 0,
});

const result = (overrides = {}) => ({
  status: 'feasible',
  objective: 'default',
  score: [0, 1, 0, 0, 1000000],
  feasibility: { code: 'feasible' },
  optimality: { code: 'not_proven' },
  containers: [{
    id: 'box#1',
    container_type: 'box',
    volume_utilization: 0.5,
    placements: [placement('cube', 0), placement('cube', 1600000)],
  }],
  unpacked_items: [],
  alternatives: [],
  ...overrides,
});

test('without an injected order the plan says so', () => {
  const container = buildExecutionPlan({}, result()).containers[0];
  assert.equal(container.order, 'unavailable');
  // Every placement is still listed; no step numbers, because array position is an
  // artifact of candidate iteration.
  assert.equal(container.steps.length, 2);
  assert.ok(!('sequence' in container.steps[0]));
});

test('an injected order is used verbatim', () => {
  const container = buildExecutionPlan({}, result(), { loadingOrders: { 0: [1, 0] } })
    .containers[0];
  assert.equal(container.order, 'loading');
  assert.deepEqual(container.steps.map((s) => s.sequence), [1, 2]);
  // Step 1 is the placement the caller put first, not the one the result listed first.
  assert.equal(container.steps[0].placement.position_ticks.x, 1600000);
});

test('an order that is not a permutation is refused', () => {
  assert.throws(
    () => buildExecutionPlan({}, result(), { loadingOrders: { 0: [0, 0] } }),
    (error) => error instanceof ExecutionPlanError && /permutation/.test(error.message));
});

test('the placement reference does not use item_id', () => {
  // `item_id` exists and conformance/canonical.py drops it as an instance count;
  // referencing it would make a plan two correct engines disagree about.
  const reference = placementReference(0, placement('cube', 0));
  assert.deepEqual(Object.keys(reference).sort(),
    ['container_index', 'item_type', 'orientation', 'position_ticks']);
});

test('the placement reference reads ticks and not the rendered value', () => {
  const subject = placement('cube', 12345);
  subject.position.x.value = 'wrong';
  assert.equal(placementReference(0, subject).position_ticks.x, 12345);
});

test('a placement it cannot reference is refused', () => {
  const subject = placement('cube', 0);
  delete subject.orientation;
  assert.throws(() => placementReference(0, subject),
    (error) => /missing a field/.test(error.message));
});

test('the loss is the first differing index and never a blend', () => {
  const plan = buildExecutionPlan({}, result({
    alternatives: [{ status: 'feasible', score: [0, 2, 0, 0, 900000] }],
  }));
  assert.deepEqual(plan.alternatives[0].facts.first_difference,
    { index: 1, winner: 1, alternative: 2, difference: 1 });
  assert.ok(!('total' in plan.alternatives[0].facts));
});

test('the sentence names an axis and claims no cause', () => {
  const plan = buildExecutionPlan({}, result({
    alternatives: [{ status: 'feasible', score: [0, 2, 0, 0, 900000] }],
  }));
  const { summary, cites } = plan.alternatives[0].presentation;
  assert.match(summary, /axis 1/);
  assert.deepEqual(cites, ['score', 'alternatives[].score']);
  for (const causal of ['because', 'due to', 'caused']) {
    assert.ok(!summary.toLowerCase().includes(causal), summary);
  }
});

test('score vectors of different length are refused', () => {
  assert.throws(() => buildExecutionPlan({}, result({ alternatives: [{ score: [0, 1] }] })),
    (error) => /different length/.test(error.message));
});

test('a result with no alternatives is well formed', () => {
  // The common case, and today the only one.
  const plan = buildExecutionPlan({}, result());
  assert.deepEqual(plan.alternatives, []);
  assert.equal(plan.format, FORMAT);
});

test('an unpacked item keeps its proof level unsoftened', () => {
  const plan = buildExecutionPlan({}, result({
    unpacked_items: [{
      item_id: 'ladder#1', item_type: 'ladder', reason: 'no_container_fits',
      details: ['too long'],
      proof: { level: 'observed', observations: [{ code: 'too_long' }] },
    }],
  }));
  assert.equal(plan.unplaced[0].facts.proof_level, 'observed');
  // The level appears in the sentence too: a reader must not be told "cannot fit" when
  // the engine only observed that it did not.
  assert.match(plan.unplaced[0].presentation.summary, /observed/);
});

test('a result without a status is not a validated result', () => {
  assert.throws(() => buildExecutionPlan({}, { containers: [] }),
    (error) => /validated result/.test(error.message));
});

test('the canonical form sorts keys, which JSON.stringify does not', () => {
  // The assertion the other three implementations do not need: `JSON.stringify` emits
  // insertion order, so without the sort this would not be comparable with them.
  const plan = buildExecutionPlan({}, result());
  const canonical = canonicalPlanJson(plan);
  assert.ok(canonical.startsWith('{"alternatives":'), canonical.slice(0, 40));
  assert.ok(!canonical.includes(', '));
  assert.ok(JSON.stringify(plan).startsWith('{"format":'), 'insertion order still differs');
});

test('the canonical form never reorders a sequence', () => {
  // Steps are ordered on purpose; sorting them would be a different plan.
  const canonical = canonicalPlanJson(
    buildExecutionPlan({}, result(), { loadingOrders: { 0: [1, 0] } }));
  const roundTrip = JSON.parse(canonical);
  assert.deepEqual(roundTrip.containers[0].steps.map((s) => s.sequence), [1, 2]);
  assert.equal(roundTrip.containers[0].steps[0].placement.position_ticks.x, 1600000);
});

test('the adapter imports no solver and no validator', async () => {
  // The dependency direction from docs/EXECUTION-PLAN.md, as the cheapest test of it.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../execution.js', import.meta.url), 'utf8');
  for (const forbidden of ['./fallback.js', './contact-graph.js', 'require(']) {
    assert.ok(!source.includes(forbidden), forbidden);
  }
});

// --------------------------------------------------------------------------------------
// The three paths the corpus does not reach. Python and PHP cover them from their own
// suites; this package measured 97.87% without them, which on a derived-document adapter
// means the refusal and the equal-score wording were shipped untested.
// --------------------------------------------------------------------------------------

test('a placement missing a tick on any axis is refused, and the message names the axis', () => {
  // `ticks` is the exact integer the reference is built from. Falling back to the rendered
  // `value` would put a rounded millimetre where a coordinate belongs, so its absence has
  // to be an error rather than a substitution.
  for (const axis of ['x', 'y', 'z']) {
    const broken = placement('cube', 0);
    delete broken.position[axis].ticks;
    assert.throws(
      () => placementReference(0, broken),
      (error) => error instanceof ExecutionPlanError
        && error.message.includes(`position.${axis}.ticks`),
      `axis ${axis} should be named in the refusal`,
    );
  }
});

test('an axis that is not an object at all is refused rather than read as undefined', () => {
  const broken = placement('cube', 0);
  broken.position.y = 0;
  assert.throws(() => placementReference(0, broken), ExecutionPlanError);
});

test('an alternative scoring identically to the winner records no first difference', () => {
  // The honest wording for a tie: the score is what the solver recorded, and it does not
  // say why one option was taken over an equal one. Claiming a cause here would invent
  // evidence the result does not contain.
  const plan = buildExecutionPlan({}, result({
    score: [0, 1, 0, 0, 1000000],
    alternatives: [{ score: [0, 1, 0, 0, 1000000], status: 'best_found' }],
  }));
  const [alternative] = plan.alternatives;
  assert.equal(alternative.facts.first_difference, null);
  assert.match(alternative.presentation.summary, /scored identically/);
  assert.match(alternative.presentation.summary, /does not record why/);
  assert.deepEqual(alternative.presentation.cites, ['score', 'alternatives[].score']);
});

test('an alternative that differs reports the first axis it differs on', () => {
  const plan = buildExecutionPlan({}, result({
    score: [0, 1, 0, 0, 1000000],
    alternatives: [{ score: [0, 1, 0, 5, 1000000], status: 'best_found' }],
  }));
  const { first_difference: difference } = plan.alternatives[0].facts;
  assert.equal(difference.index, 3);
  assert.equal(difference.winner, 0);
  assert.equal(difference.alternative, 5);
});
