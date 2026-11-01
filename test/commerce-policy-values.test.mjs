import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePolicy } from '../commerce.js';

function decision(operator, value, context) {
  const document = { policy_rules: [{ rule_id: 'restriction', versions: [{
    scope: 'facility', action: 'reject', priority: 1, effective_at: 0,
    predicates: [{ scope: 'facility', field: 'x', operator, value }],
  }] }] };
  return evaluatePolicy(document, { scope: 'facility', context, as_of: 0 }).decision;
}

const cases = [
  ['equals', { a: [1, { flag: true }], b: null }, { b: null, a: [true, { flag: 1 }] }, false],
  ['not_equals', { a: null }, { b: null }, false],
  ['equals', { a: null }, { b: null }, true],
  ['equals', { a: [1, 2] }, { a: [2, 1] }, true],
  ['in', [{ a: 1, b: true }], { b: 1, a: true }, false],
  ['not_in', [{ a: 1 }], { a: 2 }, false],
  ['in', { a: null }, 'a', false],
  ['in', { a: 'b' }, 'b', true],
  ['not_in', { a: 1 }, 'missing', false],
  ['in', { a: 1 }, ['a'], true],
  ['in', { a: 1 }, 'toString', true],
];

for (const [index, [operator, value, actual, allowed]] of cases.entries()) {
  test(`structured policy value ${index}: ${operator}`, () => {
    const result = decision(operator, value, { x: actual });
    assert.equal(result.allowed, allowed);
    assert.equal(result.citation === null, allowed);
  });
}

test('missing fields never match binary operators', () => {
  for (const operator of ['equals', 'not_equals', 'in', 'not_in']) {
    assert.equal(decision(operator, { a: 1 }, {}).citation, null);
  }
});
