/**
 * The exported commercial and control-plane API.
 *
 * JavaScript is an independent implementation of the contract, so it is held to
 * producing a *valid* result that meets each shared fixture's objective floor. For a
 * quote that floor is an exact integer price, so "no worse than the floor" and "equal
 * to it" coincide: the fixture half of this suite compares against the committed golden
 * documents, and the rejection half checks that every documented code is reachable and
 * carries only structured fields.
 *
 * The shared fixtures live in the surrounding workspace; a published copy of this
 * package does not carry them, so that half skips rather than fails when they are gone.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { commerce } from '../index.js';
import { CommerceInputError, canonicalJson, quote } from '../commerce.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARED = path.resolve(HERE, '../../../../conformance/commerce');
const hasFixtures = fs.existsSync(path.join(SHARED, 'fixtures'));

const cases = hasFixtures
  ? fs.readdirSync(path.join(SHARED, 'fixtures'))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      name: name.replace(/\.json$/, ''),
      expects: 'result',
      ...JSON.parse(fs.readFileSync(path.join(SHARED, 'fixtures', name), 'utf8')),
    }))
  : [];

const answered = cases.filter((testCase) => testCase.expects === 'result');
const malformed = cases.filter((testCase) => testCase.expects === 'input_error');

const OPERATIONS = {
  quote: commerce.quote,
  evaluate_policy: commerce.evaluatePolicy,
  catalog_version_info: commerce.catalogVersionInfo,
};

function run(testCase) {
  return OPERATIONS[testCase.operation](testCase.document, testCase.request);
}

const MINIMAL_DOCUMENT = {
  tariffs: [{
    carrier_id: 'acme',
    service_id: 'ground',
    versions: [{
      effective_at: 0,
      dimensional_weight_divisor: 5000,
      cost_per_dimensional_kg_minor: { 'zone-a': 450 },
      minimum_charge_minor: 900,
      fuel_surcharge_permille: 120,
      accessorials: [{ accessorial_id: 'liftgate', flat_charge_minor: 250 }],
    }],
  }],
};

function shipment(overrides = {}) {
  const request = {
    carrier_id: 'acme',
    service_id: 'ground',
    tariff_version: 1,
    zone: 'zone-a',
    actual_weight_g: 1200,
    volume_mm3: 6000000,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(request).filter(([, value]) => value !== null));
}

if (!hasFixtures) {
  test('the shared commerce fixtures are not part of this package', { skip: true }, () => {});
}

for (const testCase of answered) {
  test(`${testCase.name} matches the golden document`, () => {
    const golden = fs.readFileSync(path.join(SHARED, 'golden', `${testCase.name}.json`), 'utf8');

    assert.equal(canonicalJson(run(testCase)), golden.trim(), testCase.description);
  });
}

for (const testCase of malformed) {
  test(`${testCase.name} is refused rather than answered`, () => {
    assert.throws(() => run(testCase), CommerceInputError, testCase.description);
  });
}

if (hasFixtures) {
  test('the fixture set still covers every documented rejection code', () => {
    const produced = answered
      .map(run)
      .filter((result) => result.status === 'rejected')
      .map((result) => result.error.code);

    assert.deepEqual([...new Set(produced)].sort(), [...commerce.REJECTION_CODES].sort());
  });

  test('the native backend agrees with the fallback wherever both can answer', (t) => {
    const require = createRequire(import.meta.url);
    let native = null;
    // The same specifiers `force-fallback.cjs` blocks, so a coverage run pinned to the
    // fallback cannot accidentally load -- and measure -- the native addon here.
    for (const candidate of ['./packvium-native.node', '@packvium/native',
      '../../packvium-rust/bindings/node']) {
      try { native = require(candidate); break; } catch { /* not installed or blocked */ }
    }
    if (!native?.commerceQuoteJson) {
      t.skip('no native addon exporting the commerce surface is loadable here');
      return;
    }
    const entries = {
      quote: native.commerceQuoteJson,
      evaluate_policy: native.commerceEvaluatePolicyJson,
      catalog_version_info: native.commerceCatalogVersionInfoJson,
    };
    for (const testCase of answered) {
      const call = JSON.stringify({ document: testCase.document, request: testCase.request });
      // Compared as canonical text rather than as objects, so neither key order nor a
      // deep-equality coercion can hide a difference between the two backends.
      assert.equal(
        canonicalJson(JSON.parse(entries[testCase.operation](call))),
        canonicalJson(run(testCase)),
        `${testCase.name}: the native and fallback backends disagree`,
      );
    }
  });
}

test('a malformed request is a caller error, not a rejection', () => {
  for (const overrides of [
    { zone: 7 },
    { actual_weight_g: -1 },
    { actual_weight_g: true },
    { requested_accessorials: ['liftgate', 'liftgate'] },
    { discount_code: 'FREE' },
    { tariff_version: null },
    { as_of: 0 },
  ]) {
    assert.throws(() => quote(MINIMAL_DOCUMENT, shipment(overrides)), CommerceInputError,
      `expected ${JSON.stringify(overrides)} to be refused`);
  }
});

test('an unpriceable zone is an answer, not an exception', () => {
  const result = quote(MINIMAL_DOCUMENT, shipment({ zone: 'zone-nowhere' }));

  assert.equal(result.status, 'rejected');
  assert.deepEqual(result.error, {
    code: 'unavailable_zone',
    fields: {
      carrier_id: 'acme', service_id: 'ground', tariff_version: 1, zone: 'zone-nowhere',
    },
  });
});

test('a permille accessorial and a minimum charge both round up', () => {
  const document = {
    tariffs: [{
      carrier_id: 'acme',
      service_id: 'ground',
      versions: [{
        effective_at: 0,
        dimensional_weight_divisor: 5000,
        cost_per_dimensional_kg_minor: { 'zone-a': 1 },
        minimum_charge_minor: 7,
        fuel_surcharge_permille: 1,
        accessorials: [{ accessorial_id: 'residential', permille_of_base: 1 }],
      }],
    }],
  };

  const result = quote(document, shipment({
    actual_weight_g: 1, volume_mm3: 1, requested_accessorials: ['residential'],
  }));

  assert.equal(result.quote.minimum_charge_applied, true);
  assert.equal(result.quote.base_charge_minor, 7);
  assert.equal(result.quote.fuel_surcharge_minor, 1, 'ceil(7 * 1 / 1000) is 1, never 0');
  assert.deepEqual(result.quote.accessorial_charges_minor, [['residential', 1]]);
  assert.equal(result.quote.total_minor, 9);
});

test('canonical output is independent of input key order', () => {
  const forward = shipment();
  const reversed = Object.fromEntries(Object.entries(forward).reverse());

  assert.equal(
    canonicalJson(quote(MINIMAL_DOCUMENT, forward)),
    canonicalJson(quote(MINIMAL_DOCUMENT, reversed)),
  );
});
