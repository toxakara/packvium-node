import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogVersionInfo, CommerceInputError, quote } from '../commerce.js';

function tariff(carrierId, serviceId, rate = 100) {
  return { carrier_id: carrierId, service_id: serviceId, versions: [{
    effective_at: 0, dimensional_weight_divisor: 5000,
    cost_per_dimensional_kg_minor: { z: rate },
  }] };
}

function quoteRequest(carrierId, serviceId, pin) {
  return { carrier_id: carrierId, service_id: serviceId, ...pin,
    zone: 'z', actual_weight_g: 1000, volume_mm3: 0 };
}

for (const separator of ['/', '\0']) {
  for (const pin of [{ tariff_version: 1 }, { as_of: 0 }]) {
    test(`tariff identity cannot alias through ${JSON.stringify(separator)} with ${Object.keys(pin)[0]}`, () => {
      const document = { tariffs: [tariff(`a${separator}b`, 'c')] };
      const result = quote(document, quoteRequest('a', `b${separator}c`, pin));
      assert.deepEqual(result, { api_version: 1, status: 'rejected', error: {
        code: 'tariff_not_found', fields: {
          carrier_id: 'a', service_id: `b${separator}c`,
          ...(pin.tariff_version === undefined ? {} : { tariff_version: 1 }),
        },
      } });
    });

    test(`distinct tariff identities containing ${JSON.stringify(separator)} retain their own rate with ${Object.keys(pin)[0]}`, () => {
      const document = { tariffs: [tariff(`a${separator}b`, 'c', 100), tariff('a', `b${separator}c`, 250)] };
      for (const [carrierId, serviceId, total] of [[`a${separator}b`, 'c', 100], ['a', `b${separator}c`, 250]]) {
        const result = quote(document, quoteRequest(carrierId, serviceId, pin));
        assert.equal(result.status, 'ok');
        assert.equal(result.quote.carrier_id, carrierId);
        assert.equal(result.quote.service_id, serviceId);
        assert.equal(result.quote.total_minor, total);
      }
    });
  }
}

test('an identical tariff identity is still refused as a duplicate', () => {
  assert.throws(() => quote({ tariffs: [tariff('a/b', 'c'), tariff('a/b', 'c')] },
    quoteRequest('a/b', 'c', { tariff_version: 1 })), CommerceInputError);
});

test('a zone named __proto__ retains its declared rate', () => {
  const document = { tariffs: [tariff('carrier', 'service')] };
  document.tariffs[0].versions[0].cost_per_dimensional_kg_minor = JSON.parse('{"__proto__":100}');
  const result = quote(document, { ...quoteRequest('carrier', 'service', { tariff_version: 1 }),
    zone: '__proto__' });
  assert.equal(result.status, 'ok');
  assert.equal(result.quote.total_minor, 100);
});

test('an accessorial named __proto__ is charged in request order', () => {
  const document = { tariffs: [tariff('carrier', 'service')] };
  document.tariffs[0].versions[0].accessorials = [
    { accessorial_id: '__proto__', flat_charge_minor: 25 },
    { accessorial_id: 'constructor', flat_charge_minor: 5 },
  ];
  const result = quote(document, { ...quoteRequest('carrier', 'service', { tariff_version: 1 }),
    requested_accessorials: ['constructor', '__proto__'] });
  assert.equal(result.status, 'ok');
  assert.equal(result.quote.total_minor, 130);
  assert.deepEqual(result.quote.accessorial_charges_minor, [['constructor', 5], ['__proto__', 25]]);
});

test('duplicate __proto__ accessorial identifiers are refused', () => {
  const document = { tariffs: [tariff('carrier', 'service')] };
  document.tariffs[0].versions[0].accessorials = [
    { accessorial_id: '__proto__', flat_charge_minor: 25 },
    { accessorial_id: '__proto__', flat_charge_minor: 50 },
  ];
  assert.throws(() => quote(document,
    quoteRequest('carrier', 'service', { tariff_version: 1 })), CommerceInputError);
});

function catalog(rollback) {
  return { catalogs: [{ catalog_id: 'catalog', versions: [
    { effective_at: 0, published_at: 0, snapshot: {} }, rollback,
  ] }] };
}

for (const rollback of [
  { rollback_to: 1, published_at: -1 },
  { rollback_to: 1, published_at: -1, effective_at: 0 },
  { rollback_to: 1, published_at: 0, effective_at: -1 },
]) {
  test(`catalog rollback refuses negative dates: ${JSON.stringify(rollback)}`, () => {
    assert.throws(() => catalogVersionInfo(catalog(rollback),
      { catalog_id: 'catalog', version: 2, resolved_at: 0 }), CommerceInputError);
  });
}

test('catalog resolution refuses a negative resolved_at', () => {
  assert.throws(() => catalogVersionInfo(catalog({ rollback_to: 1, published_at: 0 }),
    { catalog_id: 'catalog', version: 2, resolved_at: -1 }), CommerceInputError);
});

test('catalog rollback accepts zero dates and null effective_at defaults to published_at', () => {
  const result = catalogVersionInfo(catalog({ rollback_to: 1, published_at: 0, effective_at: null }),
    { catalog_id: 'catalog', version: 2, resolved_at: 0 });
  assert.equal(result.catalog.effective_at, 0);
  assert.equal(result.catalog.published_at, 0);
  assert.equal(result.catalog.resolved_at, 0);
});
