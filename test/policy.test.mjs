import assert from 'node:assert/strict';
import test from 'node:test';

import { explainReason, packFallback, rebalanceWeight } from '../fallback.js';
import { PolicyError, parsePolicy } from '../policy.js';

/**
 * Versioned eligibility rules in the JavaScript fallback.
 *
 * Every assertion here is about a *packing*, not about a parsed object: a rule that is
 * resolved correctly and then never consulted is indistinguishable, from the outside,
 * from one that was ignored. Each test therefore packs the same request twice — once
 * with the rule participating and once without — and asserts the two answers differ in
 * the way the rule says they should.
 */

const AS_OF = 1_704_067_200_000;
const mm = (size) => ({ length: String(size), width: String(size), height: String(size) });

const REQUEST = {
  units: { length: 'mm' },
  policy: {
    as_of: AS_OF,
    shipment: { facility: 'SEA1', carrier: 'ups' },
    rules: [{
      id: 'hazmat-food-segregation',
      version: 1,
      effective_at: AS_OF,
      priority: 100,
      separate_tags: { tag: 'hazmat', from_tag: 'food' },
    }],
  },
  items: [
    { id: 'drum', quantity: 1, dimensions: mm(100), tags: ['hazmat'] },
    { id: 'carton', quantity: 1, dimensions: mm(100), tags: ['food'] },
  ],
  containers: [{ id: 'pallet', quantity: 4, inner_dimensions: mm(300) }],
};

const copy = (value) => JSON.parse(JSON.stringify(value));
const containersUsed = (request) => packFallback(request).summary.container_count;
const withoutPolicy = (request) => { const stripped = copy(request); delete stripped.policy; return stripped };
const withRules = (rules, rest = {}) => {
  const request = { ...copy(REQUEST), ...copy(rest) };
  request.policy.rules = copy(rules);
  return request;
};
const unpackedByPolicy = (request) =>
  packFallback(request).unpacked_items.find((item) => item.reason === 'policy_rule');

// ------------------------------------------------------------------ participation

test('a segregation rule opens a container the geometry did not need', () => {
  assert.equal(containersUsed(withoutPolicy(REQUEST)), 1);
  assert.equal(containersUsed(copy(REQUEST)), 2);
});

test('a container tag rule leaves an item behind rather than routing it wrongly', () => {
  const request = withRules([{
    id: 'cold-chain', version: 1, effective_at: AS_OF, priority: 10,
    require_container_tag: { item_tag: 'food', container_tag: 'reefer' },
  }]);
  assert.equal(packFallback(withoutPolicy(request)).summary.unpacked_item_count, 0);
  assert.equal(packFallback(request).summary.unpacked_item_count, 1);
});

test('a tag cap splits a container the cap would otherwise overfill', () => {
  const request = withRules([{
    id: 'lithium-cap', version: 1, effective_at: AS_OF, priority: 10,
    limit_tag_per_container: { tag: 'lithium', max: 2 },
  }], { items: [{ id: 'cell', quantity: 3, dimensions: mm(100), tags: ['lithium'] }] });
  assert.equal(containersUsed(withoutPolicy(request)), 1);
  assert.equal(containersUsed(request), 2);
});

test('a rule that is not yet effective does not participate', () => {
  const request = copy(REQUEST);
  request.policy.rules[0].effective_at = AS_OF + 1;
  assert.equal(containersUsed(request), 1);
});

test('a rule scoped to another shipment does not participate', () => {
  const request = copy(REQUEST);
  request.policy.rules[0].applies_to = { facility: 'DEN2' };
  assert.equal(containersUsed(request), 1);
  request.policy.rules[0].applies_to = { facility: 'SEA1' };
  assert.equal(containersUsed(request), 2);
});

test('a rule scoped to a fact the shipment never declared does not participate', () => {
  // Absent is not a wildcard: an undeclared customer cannot silently match a rule
  // written for a specific one.
  const request = copy(REQUEST);
  request.policy.rules[0].applies_to = { customer: 'acme' };
  assert.equal(containersUsed(request), 1);
});

// -------------------------------------------------------------------- resolution

test('the highest effective version of one id wins', () => {
  const base = {
    id: 'segregation', effective_at: AS_OF, priority: 100,
    separate_tags: { tag: 'hazmat', from_tag: 'food' },
  };
  // Superseded by a later text that forbids nothing these items carry, so the two
  // share a container again -- observable only if the newer version really won.
  const superseded = withRules([
    { ...base, version: 1 },
    { ...base, version: 2, effective_at: AS_OF, separate_tags: { tag: 'frozen', from_tag: 'dry' } },
  ]);
  assert.equal(containersUsed(superseded), 1);
  // Same id, but the newer text is not yet in force.
  const notYet = copy(superseded);
  notYet.policy.rules[1].effective_at = AS_OF + 1;
  assert.equal(containersUsed(notYet), 2);
});

test('resolution orders rules by priority then id, never by declaration order', () => {
  const rules = [
    {
      id: 'zebra-routing', version: 1, effective_at: AS_OF, priority: 10,
      require_container_tag: { item_tag: 'food', container_tag: 'reefer' },
    },
    {
      id: 'alpha-routing', version: 1, effective_at: AS_OF, priority: 10,
      require_container_tag: { item_tag: 'food', container_tag: 'dock' },
    },
  ];
  // Both reject the carton. The cited rule is the tie-break winner -- the
  // lexicographically smallest id -- whichever order the caller wrote them in.
  for (const declared of [rules, [...rules].reverse()]) {
    const item = unpackedByPolicy(withRules(declared));
    assert.match(item.details[0], /^alpha-routing@1: /);
  }
  // Priority outranks the id tie-break.
  const prioritised = copy(rules);
  prioritised[0].priority = 50;
  assert.match(unpackedByPolicy(withRules(prioritised)).details[0], /^zebra-routing@1: /);
});

test('an undeclared shipment fact is absent rather than matching anything', () => {
  const rule = {
    id: 'r', version: 1, effective_at: 0, priority: 0,
    applies_to: { facility: 'SEA1' },
    separate_tags: { tag: 'a', from_tag: 'b' },
  };
  assert.equal(parsePolicy({ as_of: 0, shipment: { facility: 'SEA1' }, rules: [rule] }).length, 1);
  assert.equal(parsePolicy({ as_of: 0, rules: [rule] }).length, 0);
  const unscoped = { ...rule, applies_to: undefined };
  delete unscoped.applies_to;
  assert.equal(parsePolicy({ as_of: 0, shipment: { facility: 'SEA1' }, rules: [unscoped] }).length, 1);
});

// -------------------------------------------------------------------- admission

test('a malformed rule fails admission rather than being dropped', () => {
  // A rule quietly dropped for being malformed would let a request pack in a way its
  // own policy forbids -- the failure the whole contract exists to prevent.
  const cases = [
    [{ id: '', version: 1, effective_at: 0, priority: 0, separate_tags: { tag: 'a', from_tag: 'b' } },
      /id must be a non-empty string/],
    [{ id: 'r', version: 0, effective_at: 0, priority: 0, separate_tags: { tag: 'a', from_tag: 'b' } },
      /version must be an integer >= 1/],
    [{ id: 'r', version: true, effective_at: 0, priority: 0, separate_tags: { tag: 'a', from_tag: 'b' } },
      /version must be an integer >= 1/],
    [{ id: 'r', version: 1.5, effective_at: 0, priority: 0, separate_tags: { tag: 'a', from_tag: 'b' } },
      /version must be an integer >= 1/],
    [{ id: 'r', version: 1, effective_at: -1, priority: 0, separate_tags: { tag: 'a', from_tag: 'b' } },
      /effective_at must be an integer >= 0/],
    [{ id: 'r', version: 1, effective_at: 0, priority: 0 }, /exactly one rule form/],
    [{ id: 'r', version: 1, effective_at: 0, priority: 0,
      separate_tags: { tag: 'a', from_tag: 'b' }, limit_tag_per_container: { tag: 'a', max: 1 } },
    /exactly one rule form/],
    [{ id: 'r', version: 1, effective_at: 0, priority: 0, separate_tags: { tag: 'a' } },
      /is missing from_tag/],
    [{ id: 'r', version: 1, effective_at: 0, priority: 0,
      separate_tags: { tag: 'a', from_tag: 'b', extra: 1 } }, /unknown keys: extra/],
    [{ id: 'r', version: 1, effective_at: 0, priority: 0, limit_tag_per_container: { tag: 'a', max: -1 } },
      /max must be an integer >= 0/],
    [{ id: 'r', version: 1, effective_at: 0, priority: 0,
      applies_to: { region: 'eu' }, separate_tags: { tag: 'a', from_tag: 'b' } },
    /unknown shipment facts: region/],
  ];
  for (const [rule, expected] of cases) {
    assert.throws(() => parsePolicy({ as_of: 0, rules: [rule] }), expected);
    assert.throws(() => parsePolicy({ as_of: 0, rules: [rule] }), PolicyError);
  }
});

test('rules without an as_of fail admission', () => {
  const rule = {
    id: 'r', version: 1, effective_at: 0, priority: 0,
    separate_tags: { tag: 'a', from_tag: 'b' },
  };
  assert.throws(() => parsePolicy({ rules: [rule] }), /as_of is required/);
  // An empty rule set needs no instant, because nothing can be dated.
  assert.deepEqual(parsePolicy({ rules: [] }), []);
  assert.deepEqual(parsePolicy(null), []);
  assert.deepEqual(parsePolicy(undefined), []);
});

test('an unknown policy key fails admission', () => {
  assert.throws(() => parsePolicy({ as_of: 0, rules: [], effect: 'deny' }), /unknown keys: effect/);
});

test('a malformed rule set is refused before either solver path runs', () => {
  // Admission, not a solver-path detail: the compact grid path returns before the
  // general one builds anything, and a rule dropped there would be dropped silently.
  const request = withRules([{ id: 'r', version: 1, effective_at: 0, priority: 0 }], {
    items: [{ id: 'plain', quantity: 4, dimensions: mm(100) }],
    configuration: { require_placement_coordinates: false },
  });
  assert.throws(() => packFallback(request), PolicyError);
});

test('a rule set stands the lattice fast path down', () => {
  // That path skips the constraint checks the rules compile onto, so it is gated on
  // there being no rule at all rather than on which fields a rule happens to read. Every
  // form keys on item tags, which the path already excludes -- but that is a property of
  // today's forms, not a guarantee. The compact lattice output is what makes the gate
  // observable; the packing itself is unchanged, so standing down costs no quality here.
  const base = {
    units: { length: 'mm' },
    items: [{ id: 'plain', quantity: 4, dimensions: mm(100) }],
    containers: [{ id: 'pallet', quantity: 4, inner_dimensions: mm(300) }],
    configuration: { require_placement_coordinates: false },
  };
  const compact = packFallback(copy(base));
  assert.ok(compact.containers[0].lattice_summary);
  const gated = packFallback({
    ...copy(base),
    policy: {
      as_of: 0,
      rules: [{
        id: 'lithium-cap', version: 1, effective_at: 0, priority: 0,
        limit_tag_per_container: { tag: 'lithium', max: 1 },
      }],
    },
  });
  assert.equal(gated.containers[0].lattice_summary, undefined);
  assert.deepEqual(gated.score, compact.score);
});

// --------------------------------------------------------------------- citation

test('a rejection names the rule and version that caused it', () => {
  const item = unpackedByPolicy(withRules([{
    id: 'cold-chain', version: 7, effective_at: AS_OF, priority: 10,
    require_container_tag: { item_tag: 'food', container_tag: 'reefer' },
  }]));
  assert.equal(item.item_type, 'carton');
  // Version, not just id: replaying a past decision needs to know which text was in
  // force, and two versions of one rule can forbid different things.
  assert.deepEqual(item.details, [
    "cold-chain@7: requires a container tagged 'reefer', "
    + 'which none of the containers offered carries',
  ]);
  // Proven rather than observed: no search outcome can make the item placeable, so this
  // is a fact about the request.
  assert.equal(item.proof.level, 'proven');
  assert.equal(item.proof.observations[0].code, 'policy_rule');
  assert.match(explainReason('policy_rule'), /policy rule/);
});

test('a rule the search worked around is not reported as proven', () => {
  // Segregation left nothing behind here -- it opened a second container. Reporting a
  // policy rejection would name a rule that did not reject anything.
  const result = packFallback(copy(REQUEST));
  assert.equal(result.summary.unpacked_item_count, 0);
  assert.equal(result.summary.container_count, 2);
});

test('a cap that leaves an item behind is observed, not proven', () => {
  // A per-container cap depends on what else was packed, so an item it leaves behind was
  // left behind by the search. Claiming `proven` would assert more than the engine
  // knows, so the generic observed reason stands and no rule is cited.
  const request = withRules([{
    id: 'lithium-cap', version: 1, effective_at: AS_OF, priority: 10,
    limit_tag_per_container: { tag: 'lithium', max: 2 },
  }], {
    items: [{ id: 'cell', quantity: 3, dimensions: mm(100), tags: ['lithium'] }],
    containers: [{ id: 'pallet', quantity: 1, inner_dimensions: mm(300) }],
  });
  const result = packFallback(request);
  assert.equal(result.summary.unpacked_item_count, 1);
  assert.notEqual(result.unpacked_items[0].reason, 'policy_rule');
});

test('rebalancing may not move an item into a container a rule forbids', () => {
  // The rebalancer accepts the same request the packer does, so a rule set it did not
  // consult would be a rule set honoured during the search and then undone by the move
  // that follows it -- the answer would claim a policy it no longer satisfies.
  const request = withRules([{
    id: 'hazmat-food-segregation', version: 1, effective_at: AS_OF, priority: 100,
    separate_tags: { tag: 'hazmat', from_tag: 'food' },
  }], {
    items: [
      { id: 'drum', quantity: 2, dimensions: mm(100), weight: '10 kg', tags: ['hazmat'] },
      { id: 'carton', quantity: 1, dimensions: mm(100), weight: '1 kg', tags: ['food'] },
    ],
    containers: [{ id: 'pallet', quantity: 2, inner_dimensions: mm(300) }],
  });
  const packed = packFallback(copy(request));
  assert.equal(packed.summary.container_count, 2);
  // The same packing, rebalanced against the same request with and without the rule set:
  // the spread is worth closing and the rebalancer closes it, unless a rule says it may
  // not. Anything else here would compare two different packings.
  assert.ok(rebalanceWeight(withoutPolicy(request), packed).moves.length > 0);
  assert.deepEqual(rebalanceWeight(request, packed).moves, []);
});

test('geometry outranks policy in the reported reason', () => {
  // An item too big for every container is impossible whatever a policy says, and
  // reporting the policy first would send a caller to fix the wrong thing.
  const request = withRules([{
    id: 'cold-chain', version: 1, effective_at: AS_OF, priority: 10,
    require_container_tag: { item_tag: 'food', container_tag: 'reefer' },
  }], { items: [{ id: 'slab', quantity: 1, dimensions: mm(9000), tags: ['food'] }] });
  assert.deepEqual(
    packFallback(request).unpacked_items.map((item) => item.reason),
    ['no_compatible_container_dimensions'],
  );
});
