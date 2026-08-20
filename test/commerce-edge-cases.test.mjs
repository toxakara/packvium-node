/**
 * Every way to hand the JavaScript commerce API something it should refuse, plus the
 * few legal inputs that look like they should be refused and are not.
 *
 * The shared fixtures in `commerce.test.mjs` prove this implementation agrees with the
 * other three. This file covers what a shared fixture cannot reach from outside:
 * JavaScript's own hazards. A `Number` cannot hold every exact integer the other three
 * can; a string and an object are both iterable where a list belongs; `1` and `1.0` are
 * the same value; and the default string sort is by UTF-16 code unit, not code point —
 * each one a place where this port could silently answer differently from the others.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { compareCodePoints } from '../commerce-model.js';
import {
  CommerceInputError,
  canonicalJson,
  catalogVersionInfo,
  evaluatePolicy,
  loadDocument,
  quote,
} from '../commerce.js';

const TARIFF = {
  effective_at: 0,
  dimensional_weight_divisor: 5000,
  cost_per_dimensional_kg_minor: { 'zone-a': 450 },
  minimum_charge_minor: 900,
  fuel_surcharge_permille: 120,
  accessorials: [{ accessorial_id: 'liftgate', flat_charge_minor: 250 }],
};

function tariffDocument(overrides = {}) {
  return {
    tariffs: [{
      carrier_id: 'acme',
      service_id: 'ground',
      versions: [{ ...TARIFF, ...overrides }],
    }],
  };
}

function catalogDocument(...versions) {
  return { catalogs: [{ catalog_id: 'c', versions }] };
}

function policyDocument(overrides = {}) {
  return {
    policy_rules: [{
      rule_id: 'r',
      versions: [{
        scope: 'hazmat',
        action: 'reject',
        priority: 1,
        effective_at: 0,
        predicates: [{ scope: 'hazmat', field: 'un_class', operator: 'equals', value: '1.4' }],
        ...overrides,
      }],
    }],
  };
}

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

function refuses(run, fragment) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof CommerceInputError, `expected a CommerceInputError, got ${error}`);
    assert.match(error.message, fragment);
    return true;
  });
}

// ------------------------------------------------------------------- the number problem

test('an integer beyond the exact range is refused, never silently rounded', () => {
  const document = tariffDocument({
    dimensional_weight_divisor: 1,
    cost_per_dimensional_kg_minor: { 'zone-a': 1_000_000 },
    minimum_charge_minor: 0,
    fuel_surcharge_permille: 0,
    accessorials: [],
  });

  // 10^15 grams at 10^6 minor units per kilogram is 10^18, well past 2^53.
  refuses(
    () => quote(document, shipment({ actual_weight_g: 0, volume_mm3: 10 ** 15 })),
    /outside JavaScript's exact integer range/,
  );
});

test('the largest exactly representable quote is still answered', () => {
  const document = tariffDocument({
    dimensional_weight_divisor: 1,
    cost_per_dimensional_kg_minor: { 'zone-a': 1000 },
    minimum_charge_minor: 0,
    fuel_surcharge_permille: 0,
    accessorials: [],
  });

  const result = quote(document, shipment({ actual_weight_g: 0, volume_mm3: 9_007_199_254_740 }));

  assert.equal(result.quote.total_minor, 9_007_199_254_740);
  assert.ok(Number.isSafeInteger(result.quote.total_minor));
});

// --------------------------------------------------------------------------- code points

test('code-point ordering matches the other implementations, not UTF-16 order', () => {
  const ids = ['z', '\u{1F600}', 'Ａ'];

  assert.deepEqual([...ids].sort(compareCodePoints), ['z', 'Ａ', '\u{1F600}']);
  assert.notDeepEqual([...ids].sort(), [...ids].sort(compareCodePoints));
});

test('code-point ordering falls back to length for a shared prefix', () => {
  assert.equal(compareCodePoints('ab', 'ab'), 0);
  assert.equal(compareCodePoints('ab', 'abc'), -1);
  assert.equal(compareCodePoints('abc', 'ab'), 1);
});

test('catalog id lists come back in code-point order', () => {
  const entry = (id) => ({ id, dimensions_mm: [1, 1, 1], weight_g: 1 });
  const document = catalogDocument({
    effective_at: 0,
    published_at: 0,
    snapshot: { items: [entry('\u{1F600}'), entry('Ａ'), entry('z')] },
  });

  const result = catalogVersionInfo(document, { catalog_id: 'c', resolved_at: 1 });

  assert.deepEqual(result.catalog.item_ids, ['z', 'Ａ', '\u{1F600}']);
});

test('a pinned policy snapshot is ordered by code point too', () => {
  const rule = (id) => ({
    rule_id: id,
    versions: [{
      scope: 'carrier', action: 'reject', priority: 1, effective_at: 0, reason: id,
      predicates: [{ scope: 'carrier', field: 'f', operator: 'exists' }],
    }],
  });
  const document = { policy_rules: [rule('\u{1F600}'), rule('Ａ')] };
  const request = {
    scope: 'carrier',
    context: { f: 1 },
    rule_versions: [['Ａ', 1], ['\u{1F600}', 1]],
  };

  const forward = evaluatePolicy(document, request);
  const reversed = evaluatePolicy(document, {
    ...request, rule_versions: [...request.rule_versions].reverse(),
  });

  assert.equal(canonicalJson(forward), canonicalJson(reversed));
  assert.equal(forward.decision.citation.rule_id, 'Ａ');
});

// --------------------------------------------------------------------- malformed documents

test('a document that is not an object is refused', () => {
  for (const document of [null, [], 'x', 7, true]) {
    refuses(() => loadDocument(document), /document: expected an object/);
  }
});

test('a nested value that is not an object is refused', () => {
  refuses(
    () => loadDocument({ tariffs: [{ carrier_id: 'a', service_id: 'g', versions: ['nope'] }] }),
    /expected an object/,
  );
});

test('a history with no versions is refused', () => {
  for (const document of [
    { tariffs: [{ carrier_id: 'a', service_id: 'g', versions: [] }] },
    { policy_rules: [{ rule_id: 'r', versions: [] }] },
    { catalogs: [{ catalog_id: 'c', versions: [] }] },
  ]) {
    refuses(() => loadDocument(document), /at least one version/);
  }
});

test('an accessorial must set exactly one kind of charge', () => {
  for (const accessorial of [
    { accessorial_id: 'x' },
    { accessorial_id: 'x', flat_charge_minor: 1, permille_of_base: 1 },
  ]) {
    refuses(() => loadDocument(tariffDocument({ accessorials: [accessorial] })), /exactly one/);
  }
});

test('a binary predicate without a value is refused', () => {
  refuses(
    () => loadDocument(policyDocument({
      predicates: [{ scope: 'hazmat', field: 'f', operator: 'equals' }],
    })),
    /requires a value/,
  );
});

test('an exclusion rule needs both ends', () => {
  refuses(
    () => loadDocument(catalogDocument({
      effective_at: 0,
      published_at: 0,
      snapshot: {
        exclusions: [{ id: 'x', scope: 'item_carton', subject_id: 'a', excluded_id: '' }],
      },
    })),
    /must reference both/,
  );
});

test('a duplicate id inside one snapshot is refused', () => {
  const entry = { id: 'same', dimensions_mm: [1, 1, 1], weight_g: 1 };

  refuses(
    () => loadDocument(catalogDocument({
      effective_at: 0, published_at: 0, snapshot: { items: [entry, entry] },
    })),
    /duplicate item ids/,
  );
});

// ---------------------------------------------------------------------- malformed requests

test('an as_of quote against a carrier with no history is not found', () => {
  const result = quote(tariffDocument(), shipment({
    carrier_id: 'ghost', tariff_version: null, as_of: 0,
  }));

  assert.deepEqual(result.error, {
    code: 'tariff_not_found', fields: { carrier_id: 'ghost', service_id: 'ground' },
  });
});

test('an empty accessorial id is refused', () => {
  refuses(
    () => quote(tariffDocument(), shipment({ requested_accessorials: [''] })),
    /non-empty/,
  );
});

test('a catalog request may pin a version or an instant, never both', () => {
  const document = catalogDocument({ effective_at: 0, published_at: 0, snapshot: {} });

  refuses(
    () => catalogVersionInfo(document, {
      catalog_id: 'c', resolved_at: 1, version: 1, as_of: 1,
    }),
    /at most one/,
  );
});

// ------------------------------------------------------------ legal but easily mishandled

test('a value of a type the predicate does not compare simply does not match', () => {
  const document = policyDocument();
  const result = evaluatePolicy(document, {
    scope: 'hazmat', context: { un_class: { nested: true } }, as_of: 0,
  });

  assert.equal(result.decision.allowed, true);
});

test('an in predicate over a non-list, non-string value matches nothing', () => {
  const document = policyDocument({
    predicates: [{ scope: 'hazmat', field: 'f', operator: 'in', value: 7 }],
  });

  const result = evaluatePolicy(document, { scope: 'hazmat', context: { f: 7 }, as_of: 0 });

  assert.equal(result.decision.allowed, true);
});

test('an explicitly null optional field means the same as an omitted one', () => {
  const document = tariffDocument({
    minimum_charge_minor: null, fuel_surcharge_permille: null, accessorials: null,
  });

  const result = quote(document, shipment());

  assert.equal(result.quote.minimum_charge_applied, false);
  assert.equal(result.quote.fuel_surcharge_minor, 0);
  assert.deepEqual(result.quote.accessorial_charges_minor, []);
});

test('canonical output leaves non-ASCII and slashes unescaped', () => {
  assert.equal(canonicalJson({ note: 'zóna/1 🙂' }), '{"note":"zóna/1 🙂"}');
});
