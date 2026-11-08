/**
 * 1.10: a request may declare its currency, a rate table may say which it prices in, and the
 * result echoes the request's. Nothing converts, prices or ranks by it. Mirrors the Python
 * reference's `test_currency.py`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { InvalidRequestError, packFallback } from '../fallback.js';
import { validateDocuments } from '../result-validation/index.js';

const THREE_LETTERS = 'must be three capital letters (ISO 4217)';

function request(currency, table) {
  const built = {
    items: [{ id: 'cube', quantity: 2, weight: '1000', dimensions: { length: '100', width: '100', height: '100' } }],
    containers: [{ id: 'box', inner_dimensions: { length: '200', width: '100', height: '200' },
      rate_table: { weight_brackets_g: [5000], prices_minor: [900] } }],
    configuration: { solver_profile: 'fast' },
  };
  if (currency !== undefined) built.currency = currency;
  if (table !== undefined) built.containers[0].rate_table.currency = table;
  return built;
}

const withoutDuration = (result) => ({ ...result, algorithm: { ...result.algorithm, duration_ms: 0 } });

/** Two solvers that disagree, so the answer carries a runner-up (conformance's feature-alternatives-runner-up). */
const runnerUp = () => ({
  currency: 'EUR',
  items: [
    { id: 'wide', quantity: 1, dimensions: { length: '60', width: '100', height: '100' } },
    { id: 'narrow', quantity: 1, dimensions: { length: '40', width: '100', height: '100' } },
    { id: 'half', quantity: 2, dimensions: { length: '50', width: '100', height: '100' } },
  ],
  containers: [{ id: 'crate', quantity: 3, inner_dimensions: { length: '100', width: '100', height: '100' },
    rate_table: { weight_brackets_g: [5000], prices_minor: [900], currency: 'EUR' } }],
  configuration: { solver_profile: 'balanced', alternatives: 3, time_limit_ms: 300000,
    effort_budget: { max_search_nodes: 1000000 }, solvers: ['extreme_points', 'layer'] },
});

test('the result echoes the request currency on the answer and every alternative', () => {
  const declared = runnerUp();
  const result = packFallback(declared);
  assert.equal(result.currency, 'EUR');
  assert.ok(result.alternatives.length > 0);
  for (const alternative of result.alternatives) {
    const keys = Object.keys(alternative);
    assert.equal(alternative.currency, 'EUR');
    assert.equal(keys.indexOf('currency'), keys.indexOf('catalog_versions_used') + 1);
  }
  assert.deepEqual(validateDocuments(declared, result), { issues: [] });
});

test('the currency sits after catalog_versions_used and before warnings', () => {
  const keys = Object.keys(packFallback(request('EUR')));
  assert.equal(keys.indexOf('currency'), keys.indexOf('catalog_versions_used') + 1);
  assert.equal(keys.indexOf('warnings'), keys.indexOf('currency') + 1);
});

test('a request without a currency keeps its bytes', () => {
  assert.equal('currency' in packFallback(request()), false);
  assert.equal('currency' in packFallback(request(null)), false);
});

test('the currency changes nothing but the echo', () => {
  const plain = withoutDuration(packFallback(request()));
  const { currency, ...rest } = withoutDuration(packFallback(request('JPY')));
  assert.equal(currency, 'JPY');
  assert.deepEqual(rest, plain);
});

for (const [currency, table, reason, field, detail] of [
  [978, undefined, 'wrong_type', '/currency', 'must be a string'],
  ['usd', undefined, 'invalid_value', '/currency', THREE_LETTERS],
  ['USD\n', undefined, 'invalid_value', '/currency', THREE_LETTERS],
  ['ÜSD', undefined, 'invalid_value', '/currency', THREE_LETTERS],
  ['USD', 840, 'wrong_type', '/containers/0/rate_table/currency', 'must be a string'],
  ['USD', 'EURO', 'invalid_value', '/containers/0/rate_table/currency', THREE_LETTERS],
  [undefined, 'USD', 'missing_field', '/currency', 'is required when a rate_table declares a currency'],
  [null, 'USD', 'missing_field', '/currency', 'is required when a rate_table declares a currency'],
  ['USD', 'EUR', 'not_allowed', '/containers/0/rate_table/currency', 'must equal the request currency "USD"'],
]) {
  test(`a bad currency is refused: ${JSON.stringify([currency, table])}`, () => {
    assert.throws(() => packFallback(request(currency, table)), (error) => error instanceof InvalidRequestError
      && error.reason === reason && error.field === field && error.detail === detail);
  });
}

test('a rate table may leave its currency to the request, or repeat it', () => {
  assert.equal(packFallback(request('USD')).currency, 'USD');
  assert.equal(packFallback(request('USD', 'USD')).currency, 'USD');
  assert.equal(packFallback(request(undefined, null)).currency, undefined);
});

test('the validator holds the echo to the request', () => {
  const declared = request('EUR');
  const result = packFallback(declared);
  const { currency, ...silent } = result;
  assert.equal(currency, 'EUR');
  assert.deepEqual(validateDocuments(declared, silent).issues,
    [{ code: 'currency_mismatch', detail: "reported None, requested 'EUR'" }]);
  assert.deepEqual(validateDocuments(declared, { ...result, currency: 'USD' }).issues,
    [{ code: 'currency_mismatch', detail: "reported 'USD', requested 'EUR'" }]);
  assert.deepEqual(validateDocuments(request(), { ...result, currency: 'EUR' }).issues,
    [{ code: 'currency_mismatch', detail: "reported 'EUR', requested None" }]);
  assert.deepEqual(validateDocuments({ ...request(), currency: null }, { ...silent, currency: null }).issues, []);
});
