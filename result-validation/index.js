/**
 * `validate` without the compiled addon: the JavaScript port of the reference validator.
 *
 * A port of `packvium.validate` (packvium-python's `result_validation.py`) over the JSON
 * documents rather than this package's model. It shares no code with the fallback solver or
 * with anything else in this package: units, geometry, support and load are all recomputed here
 * from the request and the reported placements, because a validator built on the engine's own
 * code would agree with the engine's bugs. Every issue code and every detail string is the
 * reference's, Python spelling included, so one result gets the same issue list from every
 * package (docs/VALIDATION-CONTRACT.md). It follows the Rust core's port wherever the
 * reference's own behaviour leaves a choice, so the addon and this port answer alike.
 *
 * Cost is the reference's: per container O(p^2) pair checks over its `p` placements (each pair
 * of exact hulls a separating-axis test over O(v^4) candidate axes), O(p log p + q + e) to build
 * the support graph and propagate load, and O(s * p^2) to replay `s` route stops; O(p + e)
 * memory. Integers are `BigInt`, so nothing is bounded by 2^53.
 */

import { checkAccounting, checkStructure, containerTagRules } from './accounting.js';
import { checkOptimalityBound } from './bound.js';
import { checkAchievedExtent, checkContainer, checkMadeToMeasure } from './container.js';
import { checkAlgorithmMetrics, checkEffortBudget, checkResultFacts } from './facts.js';
import {
  PyDict, at, flag, getNull, getOr, has, list, optInt,
} from './json.js';
import { materialize } from './lattice.js';
import { Refusal, contract, issue, shape } from './outcome.js';
import { pyStr, strRepr } from './pyfmt.js';
import { checkFixedPlacements, checkGroups, checkObjective, checkSolverSelection } from './objective.js';
import { parseContainers, parseItems } from './spec.js';
import { LENGTH, lengthUnit, ratioOf, toTicks } from './units.js';

const REQUIRED_KEYS = ['status', 'feasibility', 'termination', 'optimality', 'complete', 'algorithm', 'summary',
  'containers', 'unpacked_items', 'score'];

/** A value as the reference would read it from `JSON.stringify` text, which is what the addon is handed. */
function documentOf(value, what) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw shape(`${what} is not JSON`);
  return JSON.parse(encoded);
}

function checkInfeasibleProof(result, issues) {
  if (at(result, 'status') !== 'infeasible') return;
  for (const unpacked of list(at(result, 'unpacked_items'), 'result.unpacked_items')) {
    if (getNull(getOr(unpacked, 'proof', {}), 'level') !== 'proven') {
      issues.push(issue('unproven_infeasible', 'infeasible status requires a proven rejection for every unpacked item'));
      return;
    }
  }
}

/** Each packed container against its type, a made-to-measure box recomputed first; returns those boxes by id. */
function checkContainers(validated, reported, context, globalSupport, issues) {
  const fabricated = new PyDict();
  const originals = list(at(reported, 'containers'), 'result.containers');
  list(at(validated, 'containers'), 'result.containers').forEach((packed, index) => {
    const containerType = at(packed, 'container_type');
    const declared = context.containers.get(containerType);
    if (declared === undefined) {
      issues.push(issue('unknown_container_type', pyStr(containerType)));
      return;
    }
    const compact = has(originals[index], 'lattice_summary');
    const spec = checkMadeToMeasure(packed, compact, declared, context.items, context.clearance, issues);
    if (spec.madeToMeasure !== null) fabricated.set(at(packed, 'id'), spec);
    checkContainer(packed, spec, context.items, context.clearance, globalSupport, issues);
    checkAchievedExtent(packed, spec, context.clearance, issues);
  });
  return fabricated;
}

function checkContainerCounts(validated, configuration, containers, issues) {
  const opened = list(at(validated, 'containers'), 'result.containers');
  const inventory = new PyDict();
  for (const packed of opened) {
    const containerType = at(packed, 'container_type');
    if (containers.has(containerType)) inventory.set(containerType, (inventory.get(containerType) ?? 0n) + 1n);
  }
  for (const [containerType, count] of inventory.items()) {
    const { quantity } = containers.get(containerType);
    if (quantity !== null && count > quantity) {
      issues.push(issue('container_inventory_exceeded', `${pyStr(containerType)}: used ${count}, available ${quantity}`));
    }
  }
  const limit = optInt(getNull(configuration, 'max_containers'), 'max_containers');
  if (limit !== null && BigInt(opened.length) > limit) {
    issues.push(issue('max_containers_exceeded', `${opened.length} containers opened, limit ${limit}`));
  }
}

function judge(request, result) {
  for (const key of REQUIRED_KEYS) {
    if (!has(result, key)) throw contract(`result is missing ${strRepr(key)}`);
  }
  const unit = lengthUnit(request);
  const configuration = getOr(request, 'configuration', {});
  const coordinatesRequired = flag(configuration, 'require_placement_coordinates', true, 'configuration');
  const clearance = toTicks(getOr(configuration, 'clearance', 0), unit, LENGTH);
  const globalSupport = ratioOf(getOr(configuration, 'minimum_support_ratio', 0));
  const items = parseItems(request, unit);
  const containers = parseContainers(request, unit);

  const issues = [];
  const validated = materialize(coordinatesRequired, result, items, containers, clearance, issues);
  checkStructure(validated, issues);
  checkAlgorithmMetrics(validated, issues);
  checkEffortBudget(request, validated, issues);
  checkResultFacts(validated, issues);
  const context = { items, containers, clearance, rules: containerTagRules(request) };
  checkAccounting(validated, context, issues);
  checkInfeasibleProof(validated, issues);
  const fabricated = checkContainers(validated, result, context, globalSupport, issues);
  checkContainerCounts(validated, configuration, containers, issues);
  checkFixedPlacements(request, validated, unit, issues);
  checkGroups(request, validated, issues);
  checkSolverSelection(request, validated, issues);
  const score = checkObjective(request, validated, { items, containers, fabricated, clearance }, issues);
  checkOptimalityBound(request, validated, items, containers, score, issues);
  return issues;
}

/**
 * Every way `result` fails to be a sound answer to `request`, as the addon's `validateJson`
 * answers: `{issues: [{code, detail}]}`, or `{refusal: {kind, message}}` when the documents
 * cannot be judged. Never throws for a refusal; it is part of the answer.
 */
export function validateDocuments(request, result) {
  try {
    return { issues: judge(documentOf(request, 'the request'), documentOf(result, 'the result')) };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { refusal: { kind: error.kind, message: error.message } };
  }
}
