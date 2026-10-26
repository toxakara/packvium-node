/** The summary, the item accounting, and the proof behind every unpacked reason. */

import { ROTATIONS } from './geometry.js';
import {
  PyDict, at, getNull, getOr, has, hashKey, isDict, list, pyCmp, pyEq, pyIntInstance, text, truthy,
} from './json.js';
import { issue, shape } from './outcome.js';
import { pyRepr, pyStr, strRepr } from './pyfmt.js';
import { holds, intersectsTags, rotationAxes } from './spec.js';

export function checkStructure(result, issues) {
  const summary = at(result, 'summary');
  const containers = list(at(result, 'containers'), 'result.containers');
  const packed = containers.reduce((total, container) => total + list(at(container, 'placements'), 'placements').length, 0);
  const unpacked = list(at(result, 'unpacked_items'), 'result.unpacked_items').length;
  for (const [field, actual] of [['container_count', containers.length], ['packed_item_count', packed],
    ['unpacked_item_count', unpacked]]) {
    const reported = at(summary, field);
    if (!pyEq(reported, actual)) issues.push(issue('summary_mismatch', `${field} ${pyStr(reported)} != ${actual}`));
  }
  const complete = at(result, 'complete');
  if (!pyEq(complete, unpacked === 0)) {
    issues.push(issue('complete_mismatch', `complete=${pyStr(complete)} with ${unpacked} unpacked`));
  }
}

/** Whether a rule's `applies_to` facts all hold for the shipment. */
function applies(rule, shipment) {
  const appliesTo = truthy(getNull(rule, 'applies_to')) ? getNull(rule, 'applies_to') : {};
  if (!isDict(appliesTo)) throw shape('applies_to must be an object');
  return Object.keys(appliesTo).every((fact) => pyEq(getNull(shipment, fact), appliesTo[fact]));
}

/**
 * Participating `require_container_tag` rules, resolved from the request alone -- a second
 * implementation of docs/POLICY-RULES.md, so a resolution bug shared with an engine cannot hide
 * behind agreement with it.
 */
export function containerTagRules(request) {
  const policy = getNull(request, 'policy');
  if (!isDict(policy)) return [];
  const declared = truthy(getNull(policy, 'rules')) ? getNull(policy, 'rules') : [];
  if (!Array.isArray(declared) || declared.length === 0) return [];
  const asOf = pyIntInstance(getNull(policy, 'as_of'));
  if (asOf === null) return [];
  const shipment = truthy(getNull(policy, 'shipment')) ? getNull(policy, 'shipment') : {};
  const latest = new PyDict();
  for (const rule of declared) {
    if (!has(rule, 'require_container_tag') || !applies(rule, shipment)) continue;
    if (pyCmp(getOr(rule, 'effective_at', 0), asOf) > 0) continue;
    const id = getNull(rule, 'id');
    const current = latest.get(id);
    const newer = current === undefined || pyCmp(
      [getOr(rule, 'effective_at', 0), getOr(rule, 'version', 0)],
      [getOr(current, 'effective_at', 0), getOr(current, 'version', 0)],
    ) > 0;
    if (newer) latest.set(id, rule);
  }
  return latest.values();
}

export function checkAccounting(result, context, issues) {
  const seen = new Set();
  const perType = new PyDict();
  const count = (itemType) => perType.set(itemType, (perType.get(itemType) ?? 0n) + 1n);
  const see = (itemId) => {
    const key = hashKey(itemId);
    const repeated = seen.has(key);
    seen.add(key);
    return repeated;
  };
  for (const container of list(at(result, 'containers'), 'result.containers')) {
    for (const placement of list(at(container, 'placements'), 'placements')) {
      const itemId = at(placement, 'item_id');
      if (see(itemId)) issues.push(issue('duplicate_item', pyStr(itemId)));
      count(at(placement, 'item_type'));
    }
  }
  const algorithm = at(result, 'algorithm');
  const timedOut = truthy(at(algorithm, 'time_limit_reached'));
  const effortLimited = truthy(at(algorithm, 'effort_limit_reached'));
  for (const unpacked of list(at(result, 'unpacked_items'), 'result.unpacked_items')) {
    const itemId = at(unpacked, 'item_id');
    if (see(itemId)) issues.push(issue('duplicate_item', `${pyStr(itemId)} is both packed and unpacked`));
    count(at(unpacked, 'item_type'));
    if (!truthy(getNull(unpacked, 'reason'))) issues.push(issue('missing_reason', pyStr(itemId)));
    const spec = context.items.get(at(unpacked, 'item_type'));
    checkReasonProof(unpacked, spec, context, timedOut, effortLimited, issues);
  }
  for (const [itemType, counted] of perType.items()) {
    const spec = context.items.get(itemType);
    if (spec === undefined) {
      issues.push(issue('unknown_item', pyStr(itemType)));
    } else if (!pyEq(spec.quantity, counted)) {
      issues.push(issue('quantity_mismatch', `${pyStr(itemType)}: ${counted} accounted for, ${pyStr(spec.quantity)} requested`));
    }
  }
  for (const [itemType, spec] of context.items.items()) {
    if (!perType.has(itemType)) {
      issues.push(issue('quantity_mismatch', `${pyStr(itemType)}: 0 accounted for, ${pyStr(spec.quantity)} requested`));
    }
  }
}

/**
 * Whether one envelope of this size fits the empty container: its frame and, for a flat bag,
 * both girth sums with the envelope alone at the origin.
 */
export function fitsEmpty(container, size) {
  if (size.some((side, axis) => side > container.inner[axis])) return false;
  return !container.flatBag || (size[0] + size[2] <= container.inner[0] && size[1] + size[2] <= container.inner[1]);
}

/**
 * `any(_fits_empty(container, rotated envelope) for container ... for rotation ...)`, stopping at
 * the first fit as Python's generator does, so an unknown rotation is only an error when reached.
 */
function fitsSome(spec, context, rotations) {
  const margin = 2n * context.clearance;
  for (const container of context.containers.values()) {
    for (const rotation of rotations) {
      const axes = rotationAxes(text(rotation, 'a rotation'));
      if (fitsEmpty(container, axes.map((axis) => spec.dimensions[axis] + margin))) return true;
    }
  }
  return false;
}

const PROVEN = ['no_compatible_container_dimensions', 'payload_exceeded', 'no_eligible_container',
  'rotation_restricted', 'policy_rule'];
const LIMITED = ['time_limit', 'effort_limit'];
const OBSERVED = ['no_feasible_placement', 'search_exhausted', 'exact_search_incomplete', 'insufficient_support'];

function expectedLevel(reason) {
  hashKey(reason);
  const is = (names) => names.includes(reason);
  if (is(PROVEN)) return 'proven';
  if (is(LIMITED)) return 'unknown_due_to_limit';
  return is(OBSERVED) ? 'observed' : 'inferred';
}

function checkReasonProof(unpacked, spec, context, timedOut, effortLimited, issues) {
  const itemId = pyStr(getOr(unpacked, 'item_id', '?'));
  const reason = getOr(unpacked, 'reason', '');
  const proof = getNull(unpacked, 'proof');
  if (!isDict(proof)) {
    issues.push(issue('missing_reason_proof', itemId));
    return;
  }
  const expected = expectedLevel(reason);
  const level = getNull(proof, 'level');
  if (level !== expected) {
    issues.push(issue('reason_proof_mismatch',
      `${itemId}: ${pyRepr(reason)} has proof ${pyRepr(level)}, expected ${strRepr(expected)}`));
  }
  if (reason === 'time_limit' && !timedOut) {
    issues.push(issue('reason_limit_mismatch', `${itemId}: time_limit reason without a reached time limit`));
  }
  if (reason === 'effort_limit' && !effortLimited) {
    issues.push(issue('reason_limit_mismatch', `${itemId}: effort_limit reason without a reached effort limit`));
  }
  if (spec !== undefined) checkProvenReason(unpacked, reason, spec, context, itemId, issues);
  checkObservations(proof, reason, itemId, issues);
}

const EVERY_ROTATION = ROTATIONS.map(([name]) => name);

function checkProvenReason(unpacked, reason, spec, context, itemId, issues) {
  const invalid = (detail) => issues.push(issue('invalid_proven_reason', `${itemId}: ${detail}`));
  const own = spec.allowedRotations;
  if (reason === 'no_compatible_container_dimensions') {
    if (fitsSome(spec, context, own)) invalid('at least one allowed orientation fits a container');
    if (fitsSome(spec, context, EVERY_ROTATION)) {
      invalid('fits at least one container once every rotation is tried, not only its own allowed set -- '
        + 'should be rotation_restricted');
    }
  }
  if (reason === 'rotation_restricted') {
    if (fitsSome(spec, context, own)) invalid('already fits a container within its own allowed rotations');
    if (!fitsSome(spec, context, EVERY_ROTATION)) {
      invalid('does not fit any container even with every rotation tried -- should be no_compatible_container_dimensions');
    }
  }
  const containers = context.containers.values();
  if (reason === 'payload_exceeded'
    && containers.some((container) => container.maxPayload === null || spec.weight <= container.maxPayload)) {
    invalid('its weight is within at least one container payload limit');
  }
  if (reason === 'no_eligible_container' && containers.some((container) => spec.eligibleContainerTags.size === 0
    || intersectsTags(spec.eligibleContainerTags, container.tags))) {
    invalid('at least one container satisfies its eligible tags');
  }
  if (reason === 'policy_rule') checkPolicyCitation(unpacked, spec, context, invalid);
}

/**
 * Two claims, both checked: that some rule rules this item out of every container, and that the
 * rule the result *names* is that rule.
 */
function checkPolicyCitation(unpacked, spec, context, invalid) {
  const blocking = context.rules.filter((rule) => holds(spec.tags, getNull(at(rule, 'require_container_tag'), 'item_tag'))
    && !context.containers.values().some((container) => holds(
      container.tags, getNull(at(rule, 'require_container_tag'), 'container_tag'),
    )));
  if (blocking.length === 0) {
    invalid('no participating policy rule rules it out of every container');
    return;
  }
  const details = getNull(unpacked, 'details');
  const cited = truthy(details) ? list(details, 'details').map((detail) => text(detail, 'details')).join(' ') : '';
  const named = blocking.some((rule) => cited.includes(`${pyStr(at(rule, 'id'))}@${pyStr(at(rule, 'version'))}`));
  if (!named) invalid(`cites ${strRepr(cited)}, which names no rule that actually blocks it`);
}

function wellFormedObservation(observation) {
  const code = getNull(observation, 'code');
  if (typeof code !== 'string' || code === '') return false;
  const count = pyIntInstance(getNull(observation, 'count'));
  return count !== null && count >= 1n && Array.isArray(getNull(observation, 'details'));
}

function checkObservations(proof, reason, itemId, issues) {
  const observations = getNull(proof, 'observations');
  if (!Array.isArray(observations) || observations.length === 0) {
    issues.push(issue('missing_reason_observations', itemId));
    return;
  }
  let observedReason = false;
  for (const observation of observations) {
    if (!isDict(observation) || !wellFormedObservation(observation)) {
      issues.push(issue('malformed_reason_observation', itemId));
      continue;
    }
    if (pyEq(getNull(observation, 'code'), reason)) observedReason = true;
  }
  if (!observedReason) issues.push(issue('reason_observation_mismatch', `${itemId}: ${pyStr(reason)}`));
}
