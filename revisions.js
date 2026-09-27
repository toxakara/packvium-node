/**
 * Plan revisions: an append-only chain of exceptions against approved plans.
 *
 * `docs/PLAN-REVISIONS.md` is the contract and `packvium.revisions` the reference. A revision
 * records what differed from an approved plan -- a missing item, a substituted carton, a lock,
 * a verified placement -- and derives the request the next plan solves. It is a pure function
 * of its parent, the approved artifact and its events: it calls no solver, validator or clock,
 * so four builders emit the same bytes.
 *
 * Where an input breaks two rules, the checks run in Python's order, and a message quotes a
 * value by its canonical JSON (`"x"`, `null`, `["a","b"]`), because the code and text are
 * compared across engines.
 */

import { createHash } from 'node:crypto';

import { FORMAT as ARTIFACT_FORMAT, SUITE_VERSION } from './artifacts.js';
import { CanonicalJsonError, canonicalJson, jsonInteger, jsonSpelling } from './canonical-json.js';
import { compareCodePoints } from './commerce-model.js';
import { requirePointShape } from './fallback.js';

export const FORMAT = 'packvium-plan-revision/v1';

export const EVENT_TYPES = Object.freeze(['item_missing', 'container_substituted', 'placement_locked', 'placement_verified']);

const ORIENTATIONS = ['LWH', 'LHW', 'WLH', 'WHL', 'HLW', 'HWL'];

const EVENT_FIELDS = new Map([
  ['item_missing', ['item_type', 'quantity']],
  ['container_substituted', ['container_type', 'replacement']],
  ['placement_locked', ['placement']],
  ['placement_verified', ['placement']],
]);

const PLACEMENT_FIELDS = ['item_type', 'container_type', 'container_instance', 'position', 'orientation'];

/**
 * A revision could not be built. `code` is one of a closed set shared by four engines:
 * `invalid_revision`, `invalid_event`, `event_conflict`, `invalid_artifact`, and the
 * canonical-form codes `number_out_of_range`, `invalid_string`, `invalid_value`.
 */
export class PlanRevisionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlanRevisionError';
    this.code = code;
  }
}

/** The RFC 8785 canonical form, the bytes a digest and four engines are compared on. */
export function canonicalRevisionJson(document) {
  try {
    return canonicalJson(document);
  } catch (error) {
    if (error instanceof CanonicalJsonError) throw new PlanRevisionError(error.code, error.message);
    throw error;
  }
}

/** `sha256:` and the hex SHA-256 of a document's canonical bytes. */
export function documentDigest(document) {
  return `sha256:${createHash('sha256').update(canonicalRevisionJson(document), 'utf8').digest('hex')}`;
}

/** Revision 0: the request as first approved, with nothing recorded against it. */
export function rootRevision(request) {
  if (!isMapping(request)) throw new PlanRevisionError('invalid_revision', 'a request is a JSON object');
  const document = revisionDocument(0, null, null, [], clone(request));
  canonicalRevisionJson(document);
  return document;
}

/**
 * The next revision: `events`, observed against `approvedArtifact`, applied to `parent`.
 *
 * Copies and hashes the request/artifact in their serialized size. Placement-only replay
 * indexes canonical keys; missing-item and carton events still scan their request lists.
 */
export function deriveRevision(parent, approvedArtifact, events) {
  requireRevision(parent);
  requireArtifact(approvedArtifact, parent.request);
  if (!Array.isArray(events) || !events.length) {
    throw new PlanRevisionError('invalid_event', 'a revision records at least one event');
  }
  const first = lastSequence(parent) + 1;
  const recorded = events.map((event, offset) => recordedEvent(event, first + offset));
  const request = applyEvents(parent.request, recorded);
  const approved = {
    artifact: documentDigest(approvedArtifact),
    replay: clone(approvedArtifact.provenance.replay),
  };
  const document = revisionDocument(jsonInteger(parent.revision) + 1, documentDigest(parent), approved, recorded, request);
  canonicalRevisionJson(document);
  return document;
}

/**
 * The request these events derive from `request`. Refuses a contradiction, never physics:
 * whether the new fixed set can hold is the engine's admission check when it is solved.
 */
export function applyEvents(request, events) {
  if (!isMapping(request)) throw new PlanRevisionError('invalid_revision', 'a request is a JSON object');
  if (!Array.isArray(events)) throw new PlanRevisionError('invalid_event', 'events are a JSON array');
  const derived = clone(request);
  const placementSession = { fixed: null, keys: null, indexable: true };
  for (const event of events) {
    requireShape(event);
    const given = get(event, 'sequence');
    if (jsonInteger(given) === null) {
      throw new PlanRevisionError('invalid_event', `event sequence ${jsonSpelling(given)} is not an integer`);
    }
    APPLY[event.type](derived, event, placementSession);
  }
  return derived;
}

/**
 * Every way the chain fails to be what its root and events derive, without stopping at the
 * first. `artifacts[k]`, when given, is the artifact revision `k` names as approved.
 */
export function verifyRevisionChain(revisions, artifacts = null) {
  if (!Array.isArray(revisions)) throw new PlanRevisionError('invalid_revision', 'a chain is a JSON array');
  if (artifacts != null && !Array.isArray(artifacts)) {
    throw new PlanRevisionError('invalid_artifact', 'artifacts is a JSON array');
  }
  const issues = [];
  let last = 0;
  for (let position = 0; position < revisions.length; position += 1) {
    const revision = revisions[position];
    try {
      requireRevision(revision);
    } catch (error) {
      if (!(error instanceof PlanRevisionError)) throw error;
      issues.push(issue('invalid_revision', position, error.message));
      return issues;
    }
    const number = jsonInteger(revision.revision);
    if (number !== position) {
      issues.push(issue('revision_number', position, `revision ${number} at position ${position}`));
    }
    const parent = position ? revisions[position - 1] : null;
    const expectedParent = parent === null ? null : documentDigest(parent);
    const recordedParent = get(revision, 'parent');
    if (recordedParent !== expectedParent) {
      issues.push(issue('parent_mismatch', position, `parent ${plain(recordedParent)}, expected ${plain(expectedParent)}`));
    }
    last = checkSequences(revision, position, last, issues);
    if (parent !== null) checkRequest(revision, parent, position, issues);
    const artifact = artifacts == null || position >= artifacts.length ? null : artifacts[position];
    if (artifact != null && parent !== null) checkArtifact(revision, parent, artifact, position, issues);
  }
  return issues;
}

// ---------------------------------------------------------------------------- building

function revisionDocument(number, parent, approved, events, request) {
  return {
    format: FORMAT,
    suite_version: SUITE_VERSION,
    revision: number,
    parent,
    approved,
    events,
    request,
  };
}

function requireRevision(document) {
  if (!isMapping(document) || get(document, 'format') !== FORMAT) {
    throw new PlanRevisionError('invalid_revision', `not a ${FORMAT} document`);
  }
  const number = jsonInteger(get(document, 'revision'));
  if (number === null || number < 0) {
    throw new PlanRevisionError('invalid_revision', 'revision is a non-negative integer');
  }
  if (!isMapping(get(document, 'request'))) {
    throw new PlanRevisionError('invalid_revision', 'a revision carries its request');
  }
  const events = get(document, 'events');
  if (!Array.isArray(events)) {
    throw new PlanRevisionError('invalid_revision', 'a revision carries its events');
  }
  if (!events.every((event) => isMapping(event) && jsonInteger(get(event, 'sequence')) !== null)) {
    throw new PlanRevisionError('invalid_revision', "a revision's events each carry an integer sequence");
  }
}

function requireArtifact(artifact, request) {
  if (!isMapping(artifact) || get(artifact, 'format') !== ARTIFACT_FORMAT) {
    throw new PlanRevisionError('invalid_artifact', `not a ${ARTIFACT_FORMAT} document`);
  }
  const provenance = get(artifact, 'provenance');
  if (!isMapping(provenance) || !isMapping(get(provenance, 'replay'))) {
    throw new PlanRevisionError('invalid_artifact', 'the artifact carries no provenance.replay');
  }
  if (!same(get(provenance, 'request'), request)) {
    throw new PlanRevisionError('invalid_artifact', "the artifact was built from a different request than the parent's");
  }
}

function lastSequence(revision) {
  const { events } = revision;
  if (events.length) return jsonInteger(get(events[events.length - 1], 'sequence'));
  if (jsonInteger(revision.revision) !== 0) {
    throw new PlanRevisionError('invalid_revision', 'only the root revision records no events');
  }
  return 0;
}

function recordedEvent(raw, sequence) {
  requireShape(raw);
  const given = get(raw, 'sequence');
  if (jsonInteger(given) !== sequence) {
    throw new PlanRevisionError('invalid_event', `event sequence ${jsonSpelling(given)} does not continue the chain at ${sequence}`);
  }
  return clone(raw);
}

function requireShape(raw) {
  if (!isMapping(raw)) throw new PlanRevisionError('invalid_event', 'an event is a JSON object');
  const kind = get(raw, 'type');
  const fields = typeof kind === 'string' ? EVENT_FIELDS.get(kind) : undefined;
  if (fields === undefined) throw new PlanRevisionError('invalid_event', `unknown event type ${jsonSpelling(kind)}`);
  const allowed = new Set(['sequence', 'type', ...fields]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key)).sort(compareCodePoints);
  if (unknown.length) throw new PlanRevisionError('invalid_event', `${kind} does not carry ${jsonSpelling(unknown)}`);
  const missing = fields.filter((field) => !hasOwn(raw, field));
  if (missing.length) throw new PlanRevisionError('invalid_event', `${kind} needs ${jsonSpelling(missing)}`);
  VALIDATE[kind](raw);
}

function validateItemMissing(event) {
  requireName(event.item_type, 'item_type');
  const quantity = jsonInteger(event.quantity);
  if (quantity === null || quantity < 1) {
    throw new PlanRevisionError('invalid_event', 'item_missing.quantity is a positive integer');
  }
}

function validateContainerSubstituted(event) {
  requireName(event.container_type, 'container_type');
  if (!isMapping(event.replacement)) throw new PlanRevisionError('invalid_event', 'a replacement is a container object');
  requireName(get(event.replacement, 'id'), 'replacement.id');
}

function validatePlacement(event) {
  const { placement } = event;
  if (!isMapping(placement)) throw new PlanRevisionError('invalid_event', 'a placement is a fixed-placement object');
  const unknown = Object.keys(placement).filter((key) => !PLACEMENT_FIELDS.includes(key)).sort(compareCodePoints);
  if (unknown.length) throw new PlanRevisionError('invalid_event', `a placement does not carry ${jsonSpelling(unknown)}`);
  requireName(get(placement, 'item_type'), 'placement.item_type');
  requireName(get(placement, 'container_type'), 'placement.container_type');
  if (!ORIENTATIONS.includes(get(placement, 'orientation'))) {
    throw new PlanRevisionError('invalid_event', 'placement.orientation is one of the six codes');
  }
  const instance = jsonInteger(hasOwn(placement, 'container_instance') ? placement.container_instance : 1);
  if (instance === null || instance < 1) {
    throw new PlanRevisionError('invalid_event', 'placement.container_instance counts from 1');
  }
  requirePointShape(hasOwn(placement, 'position') ? placement.position : {}, 'placement.position', '', invalidEvent);
}

function invalidEvent(message) {
  return new PlanRevisionError('invalid_event', message);
}

function requireName(value, field) {
  if (typeof value !== 'string' || !value) throw new PlanRevisionError('invalid_event', `${field} is a non-empty string`);
}

const VALIDATE = {
  item_missing: validateItemMissing,
  container_substituted: validateContainerSubstituted,
  placement_locked: validatePlacement,
  placement_verified: validatePlacement,
};

// ---------------------------------------------------------------------------- applying

function applyItemMissing(request, event) {
  const items = entries(request, 'items');
  const index = indexOf(items, event.item_type, 'item');
  const quantity = jsonInteger(hasOwn(items[index], 'quantity') ? items[index].quantity : 1);
  if (quantity === null) {
    throw new PlanRevisionError('invalid_revision', `request.items[${index}].quantity is an integer`);
  }
  const remaining = quantity - jsonInteger(event.quantity);
  const fixed = fixedPlacements(request).filter((entry) => get(entry, 'item_type') === event.item_type).length;
  if (remaining < fixed) {
    throw new PlanRevisionError('event_conflict',
      `event ${sequenceOf(event)}: ${fixed} ${event.item_type} are fixed, ${Math.max(remaining, 0)} would remain`);
  }
  if (remaining > 0) {
    items[index].quantity = remaining;
    return;
  }
  if (items.length === 1) {
    throw new PlanRevisionError('event_conflict', `event ${sequenceOf(event)}: no item would remain to pack`);
  }
  items.splice(index, 1);
}

function applyContainerSubstituted(request, event) {
  const containers = entries(request, 'containers');
  const index = indexOf(containers, event.container_type, 'container');
  if (fixedPlacements(request).some((entry) => get(entry, 'container_type') === event.container_type)) {
    throw new PlanRevisionError('event_conflict',
      `event ${sequenceOf(event)}: fixed placements are in ${event.container_type}`);
  }
  const replacementId = event.replacement.id;
  if (containers.some((container, position) => position !== index && get(container, 'id') === replacementId)) {
    throw new PlanRevisionError('event_conflict',
      `event ${sequenceOf(event)}: another container is already ${replacementId}`);
  }
  containers[index] = clone(event.replacement);
}

function applyPlacement(request, event, session) {
  const placement = withDefaultInstance(event.placement);
  if (session.fixed === null) {
    session.fixed = fixedPlacements(request);
    request.fixed_placements = session.fixed;
    try {
      session.keys = new Set(session.fixed.map((entry) => canonicalRevisionJson(withDefaultInstance(entry))));
    } catch (error) {
      if (!(error instanceof PlanRevisionError)) throw error;
      session.indexable = false;
    }
  }
  const fixed = session.fixed;
  // One box cannot be two fixed items: a lock that is later verified in place is recorded
  // twice in the chain and once in the request.
  if (session.indexable) {
    try {
      const key = canonicalRevisionJson(placement);
      if (session.keys.has(key)) return;
      fixed.push(clone(event.placement));
      session.keys.add(key);
      return;
    } catch (error) {
      if (!(error instanceof PlanRevisionError)) throw error;
      session.indexable = false;
    }
  }
  // Direct callers may supply values outside canonical JSON. Keep the former first-match
  // refusal order rather than making construction of the index an earlier refusal.
  if (fixed.some((entry) => same(withDefaultInstance(entry), placement))) return;
  fixed.push(clone(event.placement));
}

function withDefaultInstance(placement) {
  return { container_instance: 1, ...clone(placement) };
}

const APPLY = {
  item_missing: applyItemMissing,
  container_substituted: applyContainerSubstituted,
  placement_locked: applyPlacement,
  placement_verified: applyPlacement,
};

/**
 * The request's fixed placements; absent or null is none, anything else not a list of objects
 * is a request no event can safely edit.
 */
function fixedPlacements(request) {
  return get(request, 'fixed_placements') === null ? [] : entries(request, 'fixed_placements');
}

function entries(request, key) {
  const list = get(request, key);
  if (!Array.isArray(list) || !list.every(isMapping)) {
    throw new PlanRevisionError('invalid_revision', `request.${key} is a list of objects`);
  }
  return list;
}

function indexOf(list, identifier, kind) {
  const index = list.findIndex((entry) => get(entry, 'id') === identifier);
  if (index < 0) throw new PlanRevisionError('event_conflict', `the request has no ${kind} ${jsonSpelling(identifier)}`);
  return index;
}

// ------------------------------------------------------------------------------ audit

function checkSequences(revision, position, last, issues) {
  const { events } = revision;
  if (position === 0 && events.length) issues.push(issue('sequence_gap', 0, 'the root revision records no events'));
  if (position > 0 && !events.length) issues.push(issue('sequence_gap', position, 'a revision records at least one event'));
  let next = last;
  for (const event of events) {
    const sequence = sequenceOf(event);
    if (sequence !== next + 1) {
      issues.push(issue('sequence_gap', position, `event ${sequence} where ${next + 1} was next`));
    }
    next = sequence;
  }
  return next;
}

function checkRequest(revision, parent, position, issues) {
  let derived;
  try {
    derived = applyEvents(parent.request, revision.events);
  } catch (error) {
    if (!(error instanceof PlanRevisionError)) throw error;
    issues.push(issue('request_mismatch', position, `the events do not apply: ${error.message}`));
    return;
  }
  if (!same(derived, revision.request)) {
    issues.push(issue('request_mismatch', position, "the request is not what the parent's request and these events derive"));
  }
}

function checkArtifact(revision, parent, artifact, position, issues) {
  const approved = get(revision, 'approved');
  const digest = digestOrNull(artifact);
  if (digest === null || !isMapping(approved) || get(approved, 'artifact') !== digest) {
    issues.push(issue('artifact_mismatch', position, "the artifact's digest is not the one this revision approved"));
    return;
  }
  const provenance = get(artifact, 'provenance');
  if (!isMapping(provenance) || !same(get(provenance, 'request'), parent.request)) {
    issues.push(issue('artifact_mismatch', position, "the artifact was built from a different request than the parent's"));
  } else if (!same(get(provenance, 'replay'), get(approved, 'replay'))) {
    issues.push(issue('artifact_mismatch', position, "approved.replay is not the artifact's provenance.replay"));
  }
}

function issue(code, revision, detail) {
  return { code, revision, detail };
}

// ------------------------------------------------------------------------------ values

/** Equality as the canonical form sees it, so `1.0` and `1` are one value, as in every engine. */
function same(left, right) {
  return canonicalRevisionJson(left) === canonicalRevisionJson(right);
}

/**
 * A deep copy of a JSON tree, so a caller's document is never mutated. Keys are defined, not
 * assigned: assigning `__proto__` would swap the copy's prototype instead of keeping the key.
 */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isMapping(value) && Object.getPrototypeOf(value) === Object.prototype) {
    const copy = {};
    for (const [key, entry] of Object.entries(value)) {
      Object.defineProperty(copy, key, { value: clone(entry), enumerable: true, writable: true, configurable: true });
    }
    return copy;
  }
  return value;
}

/** Python's `Mapping.get`: an absent key reads as null, and never from the prototype. */
function get(mapping, name) {
  return isMapping(mapping) && hasOwn(mapping, name) ? (mapping[name] ?? null) : null;
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(mapping, name) {
  return Object.prototype.hasOwnProperty.call(mapping, name);
}

/** A validated event's sequence; `requireRevision` or `applyEvents` has vouched for it. */
function sequenceOf(event) {
  return jsonInteger(get(event, 'sequence'));
}

/** An audited artifact's digest; one with no canonical form matches no approval. */
function digestOrNull(document) {
  try {
    return documentDigest(document);
  } catch (error) {
    if (!(error instanceof PlanRevisionError)) throw error;
    return null;
  }
}

/** A digest as itself, and anything a tampered chain puts in its place as JSON. */
function plain(value) {
  return typeof value === 'string' ? value : jsonSpelling(value);
}
