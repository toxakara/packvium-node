/**
 * Versioned eligibility rules, compiled into the checks the packer already runs.
 *
 * See docs/POLICY-RULES.md for the contract and the reasoning behind its shape. The
 * short version: rules travel in the request as data because an engine is driven over
 * JSON as a subprocess, so a rule registered inside one process has no wire
 * representation and nothing can check that four engines agree about it.
 *
 * Deliberately not a predicate language. `eligible_container_tags`, `incompatible_tags`
 * and `tag_limits` already express the predicates in every engine, so each rule form
 * here compiles to a check the packer already performs. What a rule adds is only what
 * tags cannot carry: identity, effective dating, priority, and the shipment-scoped facts
 * a request had nowhere to put.
 *
 * This module is package-internal: package.json exports only the root entry point.
 */

// The shipment-scoped facts a rule may select on. Properties of the shipment rather
// than of any item or container, which is why the request had nowhere to put them.
const SHIPMENT_FACTS = ['facility', 'customer', 'carrier', 'service'];

// Wire name -> the keys the form requires, in the order they are read. Exactly one may
// appear on a rule: a rule naming two forms would have no single meaning for a citation.
const FORMS = {
  separate_tags: ['tag', 'from_tag'],
  require_container_tag: ['item_tag', 'container_tag'],
  limit_tag_per_container: ['tag', 'max'],
};

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// The detail strings are part of the cross-language contract, and every other engine
// renders a tag the way its own language quotes a short string literal. Single quotes
// are what those agree on; a tag is a request-supplied string, so it is escaped here
// rather than interpolated raw.
const quoted = tag => `'${tag.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * A rule set this engine cannot honour exactly as written.
 *
 * Structured rather than skipped: a rule silently dropped for being malformed would let
 * a request pack in a way its own policy forbids, which is the failure the whole
 * contract exists to prevent.
 */
export class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyError';
    this.code = 'policy_error';
  }
}

function integer(value, where, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new PolicyError(`${where} must be an integer >= ${minimum}`);
  }
  return value;
}

/**
 * Declared facts, or the absence of one. A fact nobody declared is not a wildcard: a
 * rule naming it simply never participates, so an unstated facility cannot silently
 * match a rule written for a specific one.
 */
function shipmentContext(raw, where) {
  const context = {};
  for (const fact of SHIPMENT_FACTS) context[fact] = null;
  if (raw == null) return context;
  if (!isPlainObject(raw)) throw new PolicyError(`${where} must be an object`);
  const unknown = Object.keys(raw).filter(key => !SHIPMENT_FACTS.includes(key)).sort();
  if (unknown.length) throw new PolicyError(`${where} names unknown shipment facts: ${unknown.join(', ')}`);
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || !value) throw new PolicyError(`${where}.${name} must be a non-empty string`);
    context[name] = value;
  }
  return context;
}

/** Whether every fact this selector names equals the shipment's own. */
const satisfiedBy = (selector, shipment) =>
  SHIPMENT_FACTS.every(fact => selector[fact] === null || selector[fact] === shipment[fact]);

function parseForm(name, raw, where) {
  if (!isPlainObject(raw)) throw new PolicyError(`${where} must be an object`);
  const keys = FORMS[name];
  const unknown = Object.keys(raw).filter(key => !keys.includes(key)).sort();
  if (unknown.length) throw new PolicyError(`${where} has unknown keys: ${unknown.join(', ')}`);
  const missing = keys.filter(key => !hasOwn(raw, key));
  if (missing.length) throw new PolicyError(`${where} is missing ${missing.join(', ')}`);
  const form = {kind: name};
  for (const key of keys) {
    if (key === 'max') { form.max = integer(raw.max, `${where}.max`, 0); continue }
    if (typeof raw[key] !== 'string' || !raw[key]) throw new PolicyError(`${where}.${key} must be a non-empty string`);
    form[key] = raw[key];
  }
  return form;
}

function parseRule(raw, index) {
  const where = `policy.rules[${index}]`;
  if (!isPlainObject(raw)) throw new PolicyError(`${where} must be an object`);
  const named = Object.keys(FORMS).filter(name => hasOwn(raw, name));
  if (named.length !== 1) {
    throw new PolicyError(
      `${where} must name exactly one rule form (${Object.keys(FORMS).sort().join(', ')}), not ${named.length}`);
  }
  if (typeof raw.id !== 'string' || !raw.id) throw new PolicyError(`${where}.id must be a non-empty string`);
  const version = integer(raw.version, `${where}.version`, 1);
  return {
    id: raw.id,
    version,
    citation: `${raw.id}@${version}`,
    effective_at: integer(raw.effective_at, `${where}.effective_at`, 0),
    priority: integer(raw.priority, `${where}.priority`, 0),
    applies_to: shipmentContext(raw.applies_to, `${where}.applies_to`),
    form: parseForm(named[0], raw[named[0]], `${where}.${named[0]}`),
  };
}

/**
 * Resolution, fixed by the contract and identical in every engine — or the same request
 * packs differently depending on which one answered it.
 */
function resolve(rules, asOf, shipment) {
  const participating = rules.filter(
    rule => rule.effective_at <= asOf && satisfiedBy(rule.applies_to, shipment));
  // Append-only per id: among participating versions of one id the highest
  // `effective_at` wins, ties broken by the highest `version`. The same resolution the
  // catalog registry already uses for `as_of` lookups, deliberately, so a reader learns
  // one rule and not two.
  const latest = new Map();
  for (const rule of participating) {
    const current = latest.get(rule.id);
    if (current === undefined || rule.effective_at > current.effective_at
      || (rule.effective_at === current.effective_at && rule.version > current.version)) {
      latest.set(rule.id, rule);
    }
  }
  // Citation order, not evaluation order: the first rule that rejects a candidate is the
  // one cited, so sorting here is what makes the citation deterministic. Ties go to the
  // lexicographically smallest id -- never to insertion order, which would make the
  // citation depend on the order the caller happened to write.
  return [...latest.values()].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The rules that participate in one request, already resolved and ordered. */
export function parsePolicy(raw) {
  if (raw == null) return [];
  if (!isPlainObject(raw)) throw new PolicyError('policy must be an object');
  const unknown = Object.keys(raw).filter(key => !['as_of', 'shipment', 'rules'].includes(key)).sort();
  if (unknown.length) throw new PolicyError(`policy has unknown keys: ${unknown.join(', ')}`);
  const declared = raw.rules ?? [];
  if (!Array.isArray(declared)) throw new PolicyError('policy.rules must be an array');
  if (!declared.length) return [];
  // No default: a guessed instant silently activates or hides a restriction, and reading
  // a clock here would make one request pack differently on different days.
  if (!hasOwn(raw, 'as_of')) throw new PolicyError('policy.as_of is required whenever policy.rules is non-empty');
  const asOf = integer(raw.as_of, 'policy.as_of', 0);
  const shipment = shipmentContext(raw.shipment, 'policy.shipment');
  return resolve(declared.map(parseRule), asOf, shipment);
}

/**
 * Whether every rule permits `itemTags` in a container tagged `containerTags` that
 * already holds `presentTags`, and the citation of the first that does not.
 *
 * `O(m + r)` for `m` placements already in the container and `r` resolved rules: one
 * pass collecting the tags present, then one pass over the rules. The same bound class
 * as the tag-count check it compiles onto, so the published complexity bounds are
 * unchanged. Rules arrive in citation order, so the first rejection is already the one
 * the contract says to cite.
 */
export function policyRejection(rules, itemTags, containerTags, presentTags) {
  for (const rule of rules) {
    const form = rule.form;
    if (form.kind === 'require_container_tag') {
      if (itemTags.includes(form.item_tag) && !containerTags.includes(form.container_tag)) {
        return `${rule.citation}: requires a container tagged ${quoted(form.container_tag)}`;
      }
    } else if (form.kind === 'separate_tags') {
      if (itemTags.includes(form.tag) && presentTags.get(form.from_tag)) {
        return `${rule.citation}: ${quoted(form.tag)} may not share a container with ${quoted(form.from_tag)}`;
      }
      if (itemTags.includes(form.from_tag) && presentTags.get(form.tag)) {
        return `${rule.citation}: ${quoted(form.from_tag)} may not share a container with ${quoted(form.tag)}`;
      }
    } else if (itemTags.includes(form.tag) && (presentTags.get(form.tag) ?? 0) >= form.max) {
      return `${rule.citation}: at most ${form.max} item(s) tagged ${quoted(form.tag)} per container`;
    }
  }
  return null;
}

/**
 * The rule that rules an item out of every offered container, if one does.
 *
 * Only `require_container_tag` can be answered here, and that is not a gap. It is a
 * statement about the request alone -- this item carries the tag, no offered container
 * carries the one it requires -- so it holds however the search goes. Segregation and
 * per-container caps depend on what else was packed, so an item they leave behind was
 * left behind by the search, and reporting that as proven would claim more than the
 * engine knows.
 *
 * `O(r * c)` for `r` rules and `c` container templates, once per unpacked item rather
 * than per candidate.
 */
export function provesUnplaceable(rules, itemTags, templates) {
  for (const rule of rules) {
    const form = rule.form;
    if (form.kind !== 'require_container_tag' || !itemTags.includes(form.item_tag)) continue;
    if (!templates.some(template => (template.tags ?? []).includes(form.container_tag))) {
      return `${rule.citation}: requires a container tagged ${quoted(form.container_tag)}, `
        + 'which none of the containers offered carries';
    }
  }
  return null;
}

/** Tag occurrence counts across placements, for the two forms that need them. */
export function tagOccurrences(placements) {
  const counts = new Map();
  for (const placement of placements) {
    for (const tag of placement.item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return counts;
}
