/**
 * Quote a shipment, apply a policy rule, and inspect a catalog version.
 *
 * Run it:
 *
 *     node examples/commerce.mjs
 *
 * Everything the three functions need arrives in one *commerce document*: the tariffs
 * you publish, the eligibility rules you publish, and the catalog versions you publish.
 * Each history is a list, and a version's number is simply its position in that list
 * starting at 1 — so `tariff_version: 2` always means "the second entry under this
 * carrier and service", with no separate numbering to keep in sync.
 *
 * `commerce` picks the native addon when @packvium/native is installed and the
 * deterministic JavaScript engine otherwise. Both return the same answer;
 * `commerce.backend()` says which one answered.
 */

import { commerce } from '../index.js';

// One document, three histories. You would normally load this from your own storage.
const document = {
  tariffs: [{
    carrier_id: 'acme',
    service_id: 'ground',
    // Two published versions. The second takes effect at instant 1000.
    versions: [
      {
        effective_at: 0,
        // Volume in mm^3 divided by this gives dimensional weight in grams.
        dimensional_weight_divisor: 5000,
        // Minor currency units (cents) per billed kilogram, per zone.
        cost_per_dimensional_kg_minor: { 'zone-a': 450, 'zone-b': 610 },
        minimum_charge_minor: 900,
        // Permille: 120 means 12.0%.
        fuel_surcharge_permille: 120,
        accessorials: [
          { accessorial_id: 'liftgate', flat_charge_minor: 250 },
          { accessorial_id: 'residential', permille_of_base: 75 },
        ],
      },
      {
        effective_at: 1000,
        dimensional_weight_divisor: 4000,
        cost_per_dimensional_kg_minor: { 'zone-a': 480 },
        minimum_charge_minor: 950,
        fuel_surcharge_permille: 140,
        accessorials: [{ accessorial_id: 'liftgate', flat_charge_minor: 275 }],
      },
    ],
  }],
  policy_rules: [{
    rule_id: 'no-hazmat-air',
    versions: [{
      scope: 'hazmat',
      action: 'reject',
      priority: 10,
      effective_at: 0,
      reason: 'class 1.4 is not accepted on air services',
      predicates: [
        { scope: 'hazmat', field: 'un_class', operator: 'equals', value: '1.4' },
      ],
    }],
  }],
  catalogs: [{
    catalog_id: 'dc-12',
    versions: [
      {
        effective_at: 0,
        published_at: 0,
        note: 'initial',
        snapshot: {
          items: [{ id: 'sku-1', dimensions_mm: [100, 200, 300], weight_g: 1200 }],
          cartons: [{
            id: 'box-m', inner_dimensions_mm: [320, 240, 180],
            max_payload_g: 15000, cost_minor: 85,
          }],
        },
      },
      // A rollback is a new, higher-numbered version, never an edit of history.
      {
        rollback_to: 1, published_at: 900, effective_at: 900,
        note: 'revert the weight correction',
      },
    ],
  }],
};

const show = (title, result) => {
  console.log(`\n== ${title}`);
  console.log(JSON.stringify(result, null, 2));
};

console.log(`backend: ${commerce.backend()}`);

// 1. Quote: what does this shipment cost?
const pinned = commerce.quote(document, {
  carrier_id: 'acme',
  service_id: 'ground',
  tariff_version: 1,          // replay against exactly this version...
  zone: 'zone-a',
  actual_weight_g: 1200,
  volume_mm3: 6000000,
  requested_accessorials: ['liftgate'],
});
show('a quote pinned to tariff version 1', pinned);
console.log(`   -> the caller pays ${pinned.quote.total_minor} minor units`);

const effective = commerce.quote(document, {
  carrier_id: 'acme',
  service_id: 'ground',
  as_of: 1500,                // ...or against whatever was in force at this instant
  zone: 'zone-a',
  actual_weight_g: 1200,
  volume_mm3: 6000000,
  requested_accessorials: ['liftgate'],
});
console.log(`\n   as of instant 1500 the tariff is version ${effective.quote.tariff_version},`
  + ` and the price is ${effective.quote.total_minor}`);

// A request the model cannot answer is not an exception. It is a result with a status,
// a code from a closed set, and the structured fields that say what was missing.
show('a zone this tariff does not price', commerce.quote(document, {
  carrier_id: 'acme', service_id: 'ground', tariff_version: 1,
  zone: 'zone-nowhere', actual_weight_g: 1200, volume_mm3: 6000000,
}));

// A *malformed* request is a different thing entirely: that is your bug, and it throws.
try {
  commerce.quote(document, {
    carrier_id: 'acme', service_id: 'ground', tariff_version: 1,
    zone: 'zone-a', actual_weight_g: -1, volume_mm3: 6000000,
  });
} catch (error) {
  console.log(`\n   a negative weight is refused before anything is priced: ${error.message}`);
}

// 2. Policy: may this shipment go at all?
show('a policy decision, with the rule that made it', commerce.evaluatePolicy(document, {
  scope: 'hazmat',
  context: { un_class: '1.4' },
  as_of: 0,
}));

const allowed = commerce.evaluatePolicy(document, {
  scope: 'hazmat', context: { un_class: '9' }, as_of: 0,
});
console.log('\n   nothing matched, so the shipment is allowed with no citation:'
  + ` ${allowed.decision.citation}`);

// 3. Catalog: which master data was this decision made against?
const catalog = commerce.catalogVersionInfo(document, {
  catalog_id: 'dc-12',
  version: 2,
  resolved_at: 1700,
});
show('catalog version metadata', catalog);
console.log(`\n   version ${catalog.catalog.version} is a rollback of version`
  + ` ${catalog.catalog.rolled_back_from}`);

// Storing or comparing a result: use the canonical form, never JSON.stringify directly.
console.log('\n== the canonical form is what you store, log and compare');
console.log(commerce.canonicalJson(pinned));
