/**
 * Packvium's exported commercial and control-plane API for JavaScript.
 *
 * Three deterministic functions over one canonical JSON document: a quote, a policy
 * decision and catalog version metadata. The contract -- document format, result
 * shapes, the closed set of rejection codes, complexity and limitations -- is
 * docs/COMMERCE-API.md.
 *
 * Parsing is strict in both directions: a missing required key and an unrecognised
 * extra key are both a CommerceInputError, because a field the contract does not define
 * must never be silently ignored. A well-formed request the commercial model simply
 * cannot answer is not an error at all -- it is a result document whose status is
 * "rejected", the same way an infeasible packing request returns a result with a status.
 *
 * This module is package-internal: package.json exports only the root entry point,
 * which re-exports these as `commerce`.
 */

import {
  CommerceInputError,
  compareCodePoints,
  POLICY_ACTIONS,
  POLICY_OPERATORS,
  POLICY_SCOPES,
  decide,
  effectiveVersion,
  isUnary,
  rateTariff,
} from './commerce-model.js';

export { CommerceInputError };

export const API_VERSION = 1;

/** The closed set of rejection codes, in the order docs/COMMERCE-API.md tabulates them. */
export const REJECTION_CODES = [
  'tariff_not_found',
  'no_effective_tariff',
  'unavailable_zone',
  'unavailable_accessorial',
  'policy_rule_not_found',
  'policy_version_not_found',
  'catalog_not_found',
  'catalog_version_not_found',
  'no_effective_catalog_version',
  'ambiguous_catalog_reference',
];

const EXCLUSION_SCOPES = ['item_carton', 'item_pallet'];
const OVERRIDE_KINDS = ['carton', 'item', 'pallet'];

// ------------------------------------------------------------------- shape primitives

function fail(path, message) {
  throw new CommerceInputError(`${path}: ${message}`);
}

function asObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'expected an object');
  }
  return value;
}

function asList(value, path) {
  if (!Array.isArray(value)) fail(path, 'expected a list');
  return value;
}

function asInteger(value, path) {
  // A JSON boolean where an exact integer belongs is a caller mistake, not a 0 or a 1.
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(path, 'expected an exact integer');
  }
  return value;
}

function asText(value, path) {
  if (typeof value !== 'string') fail(path, 'expected a string');
  return value;
}

function checkKeys(value, path, required, optionalKeys = []) {
  const missing = required.filter((key) => !Object.hasOwn(value, key)).sort();
  if (missing.length > 0) fail(path, `missing required key(s) ${JSON.stringify(missing)}`);
  const unknown = Object.keys(value)
    .filter((key) => !required.includes(key) && !optionalKeys.includes(key))
    .sort();
  if (unknown.length > 0) fail(path, `unrecognised key(s) ${JSON.stringify(unknown)}`);
}

/** An absent or explicitly-null optional field reads as absent, in every language. */
function optional(value, key) {
  const found = value[key];
  return found === undefined || found === null ? undefined : found;
}

function asAxes(value, path, count) {
  const entries = asList(value, path);
  if (entries.length !== count) fail(path, `expected exactly ${count} axes`);
  return entries.map((entry, index) => asInteger(entry, `${path}[${index}]`));
}

function asEnum(value, path, allowed, label) {
  const found = asText(value, path);
  if (!allowed.includes(found)) fail(path, `unsupported ${label} '${found}'`);
  return found;
}

function positive(value, path, message) {
  if (value <= 0) fail(path, message);
  return value;
}

function nonNegative(value, path, message) {
  if (value < 0) fail(path, message);
  return value;
}

function requireUniqueIds(entries, label, path) {
  const ids = entries.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) fail(path, `duplicate ${label} ids in catalog snapshot`);
}

/**
 * The shared shape of all three histories: a list of `{...identity, versions: [...]}`
 * entries, keyed by identity, where a version's number is its 1-based position.
 */
function loadHistories(value, path, identityKeys, label, parseVersion) {
  const histories = new Map();
  asList(value, path).forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const fields = asObject(entry, entryPath);
    checkKeys(fields, entryPath, [...identityKeys, 'versions']);
    const identity = identityKeys.map((name) => asText(fields[name], `${entryPath}.${name}`));
    const key = identity.join('/');
    if (histories.has(key)) fail(entryPath, `duplicate ${label} history for '${key}'`);
    const versions = asList(fields.versions, `${entryPath}.versions`);
    if (versions.length === 0) {
      fail(`${entryPath}.versions`, `a ${label} history needs at least one version`);
    }
    const history = [];
    versions.forEach((version, position) => {
      history.push(
        parseVersion(version, `${entryPath}.versions[${position}]`, identity, position + 1, history),
      );
    });
    histories.set(key, history);
  });
  return histories;
}

// -------------------------------------------------------------------- document loading

/** Build the three append-only histories one canonical commerce document describes. */
export function loadDocument(document) {
  const root = asObject(document, 'document');
  checkKeys(root, 'document', [], ['tariffs', 'policy_rules', 'catalogs']);
  return {
    carriers: loadHistories(
      optional(root, 'tariffs') ?? [], 'document.tariffs',
      ['carrier_id', 'service_id'], 'tariff', parseTariff,
    ),
    policies: loadHistories(
      optional(root, 'policy_rules') ?? [], 'document.policy_rules',
      ['rule_id'], 'rule', parseRule,
    ),
    catalogs: loadHistories(
      optional(root, 'catalogs') ?? [], 'document.catalogs',
      ['catalog_id'], 'catalog', parseCatalogVersion,
    ),
  };
}

function parseTariff(value, path, [carrierId, serviceId], number) {
  const fields = asObject(value, path);
  checkKeys(
    fields, path,
    ['effective_at', 'dimensional_weight_divisor', 'cost_per_dimensional_kg_minor'],
    ['minimum_charge_minor', 'fuel_surcharge_permille', 'accessorials'],
  );
  const zonesPath = `${path}.cost_per_dimensional_kg_minor`;
  const costPerDimensionalKgMinor = {};
  const zones = asObject(fields.cost_per_dimensional_kg_minor, zonesPath);
  for (const [zone, cost] of Object.entries(zones)) {
    costPerDimensionalKgMinor[zone] = nonNegative(
      asInteger(cost, `${zonesPath}[${zone}]`), zonesPath,
      'cost_per_dimensional_kg_minor entries cannot be negative',
    );
  }
  return {
    carrierId,
    serviceId,
    version: number,
    effectiveAt: nonNegative(
      asInteger(fields.effective_at, `${path}.effective_at`),
      path, 'effective_at cannot be negative',
    ),
    dimensionalWeightDivisor: positive(
      asInteger(fields.dimensional_weight_divisor, `${path}.dimensional_weight_divisor`),
      path, 'dimensional_weight_divisor must be positive',
    ),
    costPerDimensionalKgMinor,
    minimumChargeMinor: nonNegative(
      asInteger(optional(fields, 'minimum_charge_minor') ?? 0, `${path}.minimum_charge_minor`),
      path, 'minimum_charge_minor cannot be negative',
    ),
    fuelSurchargePermille: nonNegative(
      asInteger(optional(fields, 'fuel_surcharge_permille') ?? 0, `${path}.fuel_surcharge_permille`),
      path, 'fuel_surcharge_permille cannot be negative',
    ),
    accessorials: parseAccessorials(optional(fields, 'accessorials') ?? [], `${path}.accessorials`),
  };
}

function parseAccessorials(value, path) {
  const charges = {};
  asList(value, path).forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const fields = asObject(entry, entryPath);
    checkKeys(fields, entryPath, ['accessorial_id'], ['flat_charge_minor', 'permille_of_base']);
    const id = asText(fields.accessorial_id, `${entryPath}.accessorial_id`);
    if (Object.hasOwn(charges, id)) fail(entryPath, `duplicate accessorial_id '${id}'`);
    const flat = optional(fields, 'flat_charge_minor');
    const permille = optional(fields, 'permille_of_base');
    if ((flat === undefined) === (permille === undefined)) {
      fail(entryPath, 'an accessorial must set exactly one of flat_charge_minor or permille_of_base');
    }
    charges[id] = {
      accessorialId: id,
      flatChargeMinor: flat === undefined ? null : nonNegative(
        asInteger(flat, `${entryPath}.flat_charge_minor`),
        entryPath, 'flat_charge_minor cannot be negative',
      ),
      permilleOfBase: permille === undefined ? null : nonNegative(
        asInteger(permille, `${entryPath}.permille_of_base`),
        entryPath, 'permille_of_base cannot be negative',
      ),
    };
  });
  return charges;
}

function parseRule(value, path, [ruleId], number) {
  const fields = asObject(value, path);
  checkKeys(fields, path, ['scope', 'action', 'predicates', 'priority', 'effective_at'], ['reason']);
  const scope = asEnum(fields.scope, `${path}.scope`, POLICY_SCOPES, 'policy scope');
  const predicates = parsePredicates(fields.predicates, `${path}.predicates`, scope);
  if (predicates.length === 0) fail(path, 'a rule must have at least one predicate');
  return {
    ruleId,
    version: number,
    scope,
    action: asEnum(fields.action, `${path}.action`, POLICY_ACTIONS, 'policy action'),
    predicates,
    priority: asInteger(fields.priority, `${path}.priority`),
    effectiveAt: nonNegative(
      asInteger(fields.effective_at, `${path}.effective_at`),
      path, 'effective_at cannot be negative',
    ),
    reason: asText(optional(fields, 'reason') ?? '', `${path}.reason`),
  };
}

function parsePredicates(value, path, scope) {
  return asList(value, path).map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const fields = asObject(entry, entryPath);
    checkKeys(fields, entryPath, ['scope', 'field', 'operator'], ['value']);
    if (asEnum(fields.scope, `${entryPath}.scope`, POLICY_SCOPES, 'policy scope') !== scope) {
      fail(entryPath, "every predicate of a rule must share the rule's own scope");
    }
    const operator = asEnum(
      fields.operator, `${entryPath}.operator`, POLICY_OPERATORS, 'policy operator',
    );
    const predicateValue = optional(fields, 'value') ?? null;
    if (!isUnary(operator) && predicateValue === null) {
      fail(entryPath, `operator '${operator}' requires a value`);
    }
    const field = asText(fields.field, `${entryPath}.field`);
    if (field === '') fail(entryPath, 'field is required');
    return { scope, field, operator, value: predicateValue };
  });
}

function parseCatalogVersion(value, path, _identity, number, history) {
  const fields = asObject(value, path);
  if (Object.hasOwn(fields, 'rollback_to')) return parseRollback(fields, path, number, history);
  checkKeys(fields, path, ['effective_at', 'published_at', 'snapshot'], ['note']);
  return {
    number,
    snapshot: parseSnapshot(fields.snapshot, `${path}.snapshot`),
    effectiveAt: nonNegative(
      asInteger(fields.effective_at, `${path}.effective_at`),
      path, 'effective_at cannot be negative',
    ),
    publishedAt: nonNegative(
      asInteger(fields.published_at, `${path}.published_at`),
      path, 'published_at cannot be negative',
    ),
    rolledBackFrom: null,
    note: asText(optional(fields, 'note') ?? '', `${path}.note`),
  };
}

/** A rollback is a new, higher-numbered version whose snapshot equals a prior one's. */
function parseRollback(fields, path, number, history) {
  checkKeys(fields, path, ['rollback_to', 'published_at'], ['effective_at', 'note']);
  const toVersion = asInteger(fields.rollback_to, `${path}.rollback_to`);
  const target = history.find((version) => version.number === toVersion);
  if (target === undefined) {
    fail(path, `rollback_to names version ${toVersion}, which is not published yet`);
  }
  const publishedAt = asInteger(fields.published_at, `${path}.published_at`);
  const note = asText(optional(fields, 'note') ?? '', `${path}.note`);
  return {
    number,
    snapshot: target.snapshot,
    effectiveAt: asInteger(optional(fields, 'effective_at') ?? publishedAt, `${path}.effective_at`),
    publishedAt,
    rolledBackFrom: toVersion,
    note: note === '' ? `rollback to version ${toVersion}` : note,
  };
}

function parseSnapshot(value, path) {
  const fields = asObject(value, path);
  checkKeys(fields, path, [], ['items', 'cartons', 'pallets', 'exclusions', 'overrides']);
  const collect = (key, parse) => asList(optional(fields, key) ?? [], `${path}.${key}`)
    .map((entry, index) => parse(
      asObject(entry, `${path}.${key}[${index}]`), `${path}.${key}[${index}]`,
    ));

  const snapshot = {
    items: collect('items', parseItem),
    cartons: collect('cartons', parseCarton),
    pallets: collect('pallets', parsePallet),
    exclusions: collect('exclusions', parseExclusion),
    overrides: collect('overrides', parseOverride),
  };
  requireUniqueIds(snapshot.items, 'item', path);
  requireUniqueIds(snapshot.cartons, 'carton', path);
  requireUniqueIds(snapshot.pallets, 'pallet', path);
  requireUniqueIds(snapshot.exclusions, 'exclusion', path);
  requireUniqueIds(snapshot.overrides, 'facility override', path);
  return snapshot;
}

function identifier(fields, path, label) {
  const id = asText(fields.id, `${path}.id`);
  if (id === '') fail(path, `${label} id is required`);
  return id;
}

function parseItem(fields, path) {
  checkKeys(fields, path, ['id', 'dimensions_mm', 'weight_g'], ['description']);
  const dimensions = asAxes(fields.dimensions_mm, `${path}.dimensions_mm`, 3);
  if (dimensions.some((axis) => axis <= 0)) fail(path, 'item dimensions must be positive');
  return {
    id: identifier(fields, path, 'item'),
    dimensionsMm: dimensions,
    weightG: positive(
      asInteger(fields.weight_g, `${path}.weight_g`), path, 'item weight must be positive',
    ),
    description: asText(optional(fields, 'description') ?? '', `${path}.description`),
  };
}

function parseCarton(fields, path) {
  checkKeys(fields, path, ['id', 'inner_dimensions_mm', 'max_payload_g'], ['cost_minor']);
  const dimensions = asAxes(fields.inner_dimensions_mm, `${path}.inner_dimensions_mm`, 3);
  if (dimensions.some((axis) => axis <= 0)) fail(path, 'carton dimensions must be positive');
  return {
    id: identifier(fields, path, 'carton'),
    innerDimensionsMm: dimensions,
    maxPayloadG: positive(
      asInteger(fields.max_payload_g, `${path}.max_payload_g`),
      path, 'carton max_payload_g must be positive',
    ),
    costMinor: nonNegative(
      asInteger(optional(fields, 'cost_minor') ?? 0, `${path}.cost_minor`),
      path, 'cost_minor cannot be negative',
    ),
  };
}

function parsePallet(fields, path) {
  checkKeys(fields, path, ['id', 'deck_dimensions_mm', 'max_payload_g'], ['max_stack_height_mm']);
  const deck = asAxes(fields.deck_dimensions_mm, `${path}.deck_dimensions_mm`, 2);
  if (deck.some((axis) => axis <= 0)) fail(path, 'pallet dimensions must be positive');
  const height = optional(fields, 'max_stack_height_mm');
  return {
    id: identifier(fields, path, 'pallet'),
    deckDimensionsMm: deck,
    maxPayloadG: positive(
      asInteger(fields.max_payload_g, `${path}.max_payload_g`),
      path, 'pallet max_payload_g must be positive',
    ),
    maxStackHeightMm: height === undefined ? null : positive(
      asInteger(height, `${path}.max_stack_height_mm`),
      path, 'max_stack_height_mm must be positive',
    ),
  };
}

function parseExclusion(fields, path) {
  checkKeys(fields, path, ['id', 'scope', 'subject_id', 'excluded_id'], ['reason']);
  const subjectId = asText(fields.subject_id, `${path}.subject_id`);
  const excludedId = asText(fields.excluded_id, `${path}.excluded_id`);
  if (subjectId === '' || excludedId === '') {
    fail(path, 'an exclusion rule must reference both a subject and an excluded id');
  }
  return {
    id: identifier(fields, path, 'exclusion'),
    scope: asEnum(fields.scope, `${path}.scope`, EXCLUSION_SCOPES, 'exclusion scope'),
    subjectId,
    excludedId,
    reason: asText(optional(fields, 'reason') ?? '', `${path}.reason`),
  };
}

function parseOverride(fields, path) {
  checkKeys(fields, path, ['id', 'facility_id', 'entry_id', 'kind', 'override']);
  const kind = asEnum(fields.kind, `${path}.kind`, OVERRIDE_KINDS, 'override kind');
  const parse = { item: parseItem, carton: parseCarton, pallet: parsePallet }[kind];
  const entry = parse(asObject(fields.override, `${path}.override`), `${path}.override`);
  const facilityId = asText(fields.facility_id, `${path}.facility_id`);
  const entryId = asText(fields.entry_id, `${path}.entry_id`);
  if (facilityId === '') fail(path, 'facility_id is required');
  if (entry.id !== entryId) fail(path, "a facility override's entry_id must match override.id");
  return { id: identifier(fields, path, 'facility override'), facilityId, entryId, kind, entry };
}

// --------------------------------------------------------------------------- responses

function ok(key, payload) {
  return { api_version: API_VERSION, status: 'ok', [key]: payload };
}

function rejected(code, fields) {
  return { api_version: API_VERSION, status: 'rejected', error: { code, fields } };
}

function exactlyOne(request, names) {
  const present = names.filter((name) => optional(request, name) !== undefined);
  if (present.length !== 1) fail('request', `expected exactly one of ${JSON.stringify(names)}`);
  return present[0];
}

// ------------------------------------------------------------------------------- quote

/** Price one shipment against one pinned or effective-dated tariff version. */
export function quote(document, request) {
  const loaded = loadDocument(document);
  const fields = asObject(request, 'request');
  checkKeys(
    fields, 'request',
    ['carrier_id', 'service_id', 'zone', 'actual_weight_g', 'volume_mm3'],
    ['tariff_version', 'as_of', 'requested_accessorials'],
  );
  const pin = exactlyOne(fields, ['tariff_version', 'as_of']);
  const carrierId = asText(fields.carrier_id, 'request.carrier_id');
  const serviceId = asText(fields.service_id, 'request.service_id');
  const ratingRequest = parseRatingRequest(fields);
  const identity = { carrier_id: carrierId, service_id: serviceId };

  const resolved = resolveTariff(loaded.carriers, identity, fields, pin);
  if (resolved.rejection !== undefined) {
    return rejected(resolved.rejection.code, resolved.rejection.fields);
  }

  const { tariff } = resolved;
  const { breakdown, rejection } = rateTariff(tariff, ratingRequest);
  if (rejection !== undefined) {
    const where = { ...identity, tariff_version: tariff.version };
    return rejection.kind === 'zone'
      ? rejected('unavailable_zone', { ...where, zone: rejection.zone })
      : rejected('unavailable_accessorial', { ...where, accessorial_ids: rejection.accessorialIds });
  }
  return ok('quote', breakdown);
}

function resolveTariff(carriers, identity, fields, pin) {
  const history = carriers.get(`${identity.carrier_id}/${identity.service_id}`);
  if (pin === 'tariff_version') {
    const version = asInteger(fields.tariff_version, 'request.tariff_version');
    const tariff = history?.find((candidate) => candidate.version === version);
    if (tariff === undefined) {
      return { rejection: { code: 'tariff_not_found', fields: { ...identity, tariff_version: version } } };
    }
    return { tariff };
  }
  const asOf = asInteger(fields.as_of, 'request.as_of');
  if (history === undefined) {
    return { rejection: { code: 'tariff_not_found', fields: identity } };
  }
  const tariff = effectiveVersion(history, asOf, (candidate) => candidate.version);
  if (tariff === null) {
    return { rejection: { code: 'no_effective_tariff', fields: { ...identity, as_of: asOf } } };
  }
  return { tariff };
}

function parseRatingRequest(fields) {
  const requestedAccessorials = asList(
    optional(fields, 'requested_accessorials') ?? [], 'request.requested_accessorials',
  ).map((entry, index) => asText(entry, `request.requested_accessorials[${index}]`));
  if (requestedAccessorials.some((id) => id === '')) {
    fail('request.requested_accessorials', 'accessorial ids must be non-empty');
  }
  if (new Set(requestedAccessorials).size !== requestedAccessorials.length) {
    fail('request.requested_accessorials', 'accessorial ids must be unique');
  }
  const zone = asText(fields.zone, 'request.zone');
  if (zone === '') fail('request.zone', 'zone is required');
  return {
    zone,
    actualWeightG: nonNegative(
      asInteger(fields.actual_weight_g, 'request.actual_weight_g'),
      'request.actual_weight_g', 'actual_weight_g cannot be negative',
    ),
    volumeMm3: nonNegative(
      asInteger(fields.volume_mm3, 'request.volume_mm3'),
      'request.volume_mm3', 'volume_mm3 cannot be negative',
    ),
    requestedAccessorials,
  };
}

// --------------------------------------------------------------------- evaluate policy

/** Decide one eligibility question against a pinned or effective-dated rule set. */
export function evaluatePolicy(document, request) {
  const loaded = loadDocument(document);
  const fields = asObject(request, 'request');
  checkKeys(fields, 'request', ['scope', 'context'], ['as_of', 'rule_versions']);
  const pin = exactlyOne(fields, ['as_of', 'rule_versions']);
  const scope = asEnum(fields.scope, 'request.scope', POLICY_SCOPES, 'policy scope');
  const context = asObject(fields.context, 'request.context');

  if (pin === 'as_of') {
    const asOf = asInteger(fields.as_of, 'request.as_of');
    const effective = [...loaded.policies.values()]
      .map((history) => effectiveVersion(history, asOf, (rule) => rule.version))
      .filter((rule) => rule !== null);
    return ok('decision', decide(effective, scope, context));
  }
  const resolved = resolvePins(loaded.policies, fields.rule_versions);
  if (resolved.rejection !== undefined) {
    return rejected(resolved.rejection.code, resolved.rejection.fields);
  }
  return ok('decision', decide(resolved.rules, scope, context));
}

function resolvePins(policies, value) {
  const pins = asList(value, 'request.rule_versions').map((entry, index) => {
    const path = `request.rule_versions[${index}]`;
    const pair = asList(entry, path);
    if (pair.length !== 2) fail(path, 'expected a [rule_id, version] pair');
    return [asText(pair[0], `${path}[0]`), asInteger(pair[1], `${path}[1]`)];
  });
  if (new Set(pins.map(([ruleId]) => ruleId)).size !== pins.length) {
    fail('request.rule_versions', 'a policy snapshot cannot pin the same rule id twice');
  }
  // Sorted so an explicit snapshot is order-independent, exactly as the reference
  // implementation orders it before deciding.
  pins.sort(([leftId, leftVersion], [rightId, rightVersion]) => (
    leftId === rightId ? leftVersion - rightVersion : compareCodePoints(leftId, rightId)
  ));

  const rules = [];
  for (const [ruleId, version] of pins) {
    const history = policies.get(ruleId);
    if (history === undefined) {
      return { rejection: { code: 'policy_rule_not_found', fields: { rule_id: ruleId } } };
    }
    const rule = history.find((candidate) => candidate.version === version);
    if (rule === undefined) {
      return { rejection: { code: 'policy_version_not_found', fields: { rule_id: ruleId, version } } };
    }
    rules.push(rule);
  }
  return { rules };
}

// ---------------------------------------------------------------- catalog version info

/** Report which catalog version a reference resolves to, and what it contains. */
export function catalogVersionInfo(document, request) {
  const loaded = loadDocument(document);
  const fields = asObject(request, 'request');
  checkKeys(fields, 'request', ['catalog_id', 'resolved_at'], ['version', 'as_of']);
  const catalogId = asText(fields.catalog_id, 'request.catalog_id');
  const resolvedAt = asInteger(fields.resolved_at, 'request.resolved_at');
  const version = optional(fields, 'version') === undefined
    ? undefined
    : asInteger(fields.version, 'request.version');
  const asOf = optional(fields, 'as_of') === undefined
    ? undefined
    : asInteger(fields.as_of, 'request.as_of');
  if (version !== undefined && asOf !== undefined) {
    fail('request', 'expected at most one of ["as_of","version"]');
  }

  const history = loaded.catalogs.get(catalogId);
  if (history === undefined) return rejected('catalog_not_found', { catalog_id: catalogId });
  const selector = { catalog_id: catalogId };
  if (version !== undefined) selector.version = version;
  if (asOf !== undefined) selector.as_of = asOf;

  const resolved = resolveCatalogVersion(history, version, asOf);
  if (typeof resolved === 'string') return rejected(resolved, selector);
  return ok('catalog', catalogPayload(catalogId, resolved, resolvedAt));
}

function resolveCatalogVersion(history, version, asOf) {
  if (version !== undefined) {
    return history.find((candidate) => candidate.number === version) ?? 'catalog_version_not_found';
  }
  if (asOf === undefined) {
    return history.length > 1 ? 'ambiguous_catalog_reference' : history[0];
  }
  return effectiveVersion(history, asOf, (candidate) => candidate.number)
    ?? 'no_effective_catalog_version';
}

function catalogPayload(catalogId, version, resolvedAt) {
  const { snapshot } = version;
  // Sorted so no map or insertion ordering can leak into the answer.
  const ids = (entries) => entries.map((entry) => entry.id).sort(compareCodePoints);
  return {
    catalog_id: catalogId,
    version: version.number,
    effective_at: version.effectiveAt,
    published_at: version.publishedAt,
    resolved_at: resolvedAt,
    rolled_back_from: version.rolledBackFrom,
    note: version.note,
    entry_counts: {
      items: snapshot.items.length,
      cartons: snapshot.cartons.length,
      pallets: snapshot.pallets.length,
      exclusions: snapshot.exclusions.length,
      overrides: snapshot.overrides.length,
    },
    item_ids: ids(snapshot.items),
    carton_ids: ids(snapshot.cartons),
    pallet_ids: ids(snapshot.pallets),
  };
}

// ---------------------------------------------------------------------- canonical form

/** The one byte-comparable spelling of a result document: sorted keys, no padding. */
export function canonicalJson(result) {
  const sort = (value) => {
    if (Array.isArray(value)) return value.map(sort);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.keys(value).sort(compareCodePoints).map((key) => [key, sort(value[key])]),
    );
  };
  return JSON.stringify(sort(result));
}
