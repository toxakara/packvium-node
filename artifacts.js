/**
 * The portable operational artifact.
 *
 * `docs/OPERATIONAL-ARTIFACTS.md` is the contract and `packvium.artifacts` is the reference.
 * The artifact is the one document that can be drawn, printed and traced offline, and it adds
 * nothing a solver decided: it reads the request, the result and the optional loading orders
 * -- the plan's own inputs -- and calls no solver, validator, renderer or clock. The plan
 * inside it is exactly what `buildExecutionPlan` emits for the same inputs. Placements are
 * found by the plan's placement reference, never by `item_id`.
 *
 * Held to byte-identical canonical output with Python, PHP and Rust. Where a document breaks
 * two rules, the checks run in Python's order, because the error code is compared too.
 */

import { CanonicalJsonError, canonicalJson } from './canonical-json.js';
import { ExecutionPlanError, buildExecutionPlan, placementReference } from './execution.js';

export const FORMAT = 'packvium-operational-artifact/v1';

/**
 * The suite version of this builder, the same string in all four engines of one release.
 * The engine's own name is deliberately not recorded: four correct builders naming themselves
 * would emit four different documents.
 */
export const SUITE_VERSION = '1.3.0';

/** The deterministic part of `result.algorithm`; `duration_ms` is wall-clock time. */
const SOLVER_FIELDS = ['profile', 'solver', 'seed', 'time_limit_reached', 'effort_limit_reached'];
const DIMENSION_AXES = ['length', 'width', 'height'];
const POSITION_AXES = ['x', 'y', 'z'];

/**
 * The builder was handed something an artifact cannot carry. `code` is one of the closed set
 * shared by all four engines (see `docs/OPERATIONAL-ARTIFACTS.md`).
 */
export class OperationalArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OperationalArtifactError';
    this.code = code;
  }
}

/**
 * Build the artifact for one validated result. O(R + P) for a request of size R and P
 * placements, plus key sorting when it is serialized.
 *
 * `loadingOrders` maps a container index to a permutation of its placement indices and is
 * passed straight to the plan builder.
 */
export function buildOperationalArtifact(request, result, { loadingOrders } = {}) {
  if (!isMapping(request)) throw refusal('invalid_request', 'a request is a JSON object');
  if (!isMapping(result)) throw refusal('invalid_result', 'a result is a JSON object');
  requireObjects(result);
  const plan = planOf(request, result, loadingOrders);

  const containers = list(get(result, 'containers'), 'result.containers');
  const { lengthUnit, weightUnit } = unitsOf(containers);
  const artifact = {
    format: FORMAT,
    suite_version: SUITE_VERSION,
    provenance: provenanceOf(request, result),
    plan,
    geometry: { containers: containers.map((container, index) => geometryOf(index, container)) },
    work_order: {
      length_unit: lengthUnit,
      weight_unit: weightUnit,
      containers: containers.map((container, index) => workOrderContainer(
        index, container, plan.containers[index], lengthUnit, weightUnit)),
    },
  };
  // Refused here rather than when someone serializes it: an artifact that exists must have
  // one spelling in every engine.
  canonicalArtifactJson(artifact);
  return artifact;
}

/** The artifact's RFC 8785 canonical form, the bytes four engines are compared on. */
export function canonicalArtifactJson(artifact) {
  try {
    return canonicalJson(artifact);
  } catch (error) {
    if (error instanceof CanonicalJsonError) throw refusal(error.code, error.message);
    throw error;
  }
}

function planOf(request, result, loadingOrders) {
  try {
    return buildExecutionPlan(request, result, { loadingOrders });
  } catch (error) {
    if (error instanceof ExecutionPlanError) throw refusal('invalid_plan_input', error.message);
    throw error;
  }
}

// ------------------------------------------------------------------------------ provenance

function provenanceOf(request, result) {
  const solver = solverOf(get(result, 'algorithm'));
  const catalogs = list(get(result, 'catalog_versions_used'), 'result.catalog_versions_used');
  catalogs.forEach(requireCatalog);
  return {
    // Embedded, not digested: only the request itself lets someone replay the artifact
    // without a lookup.
    request,
    catalog_versions_used: catalogs,
    solver,
    replay: replayOf(solver),
  };
}

/**
 * The result schema's closed catalog reference. The work order prints these fields, so a
 * mistyped one would print differently in every engine.
 */
function requireCatalog(catalog) {
  if (typeof field(catalog, 'catalog_id', 'catalog_versions_used[]') !== 'string') {
    throw refusal('invalid_result', 'catalog_versions_used[].catalog_id is not a string');
  }
  for (const name of ['version', 'effective_at', 'resolved_at']) {
    const value = field(catalog, name, 'catalog_versions_used[]');
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw refusal('invalid_result', `catalog_versions_used[].${name} is not an integer`);
    }
  }
}

function solverOf(algorithm) {
  if (algorithm === null) return null;
  if (!isMapping(algorithm)) throw refusal('invalid_result', 'result.algorithm is not an object');
  const missing = SOLVER_FIELDS.filter((name) => !hasOwn(algorithm, name));
  if (missing.length) {
    throw refusal('invalid_result', `result.algorithm has no ${missing.join(', ')}`);
  }
  for (const flag of ['time_limit_reached', 'effort_limit_reached']) {
    if (typeof algorithm[flag] !== 'boolean') {
      throw refusal('invalid_result', `result.algorithm.${flag} is not a boolean`);
    }
  }
  const solver = {};
  for (const name of SOLVER_FIELDS) solver[name] = algorithm[name];
  return solver;
}

/**
 * `exact` only when a replay must reproduce the result. A search stopped by wall-clock time
 * cannot be reproduced, and a result that does not say how it was solved cannot be promised
 * to; claiming otherwise would be softening a proof level by another name.
 */
function replayOf(solver) {
  if (solver === null) return { level: 'not_guaranteed', because: 'provenance.solver' };
  if (solver.time_limit_reached) {
    return { level: 'not_guaranteed', because: 'provenance.solver.time_limit_reached' };
  }
  return { level: 'exact', because: null };
}

// -------------------------------------------------------------------------------- geometry

function geometryOf(index, container) {
  return {
    container_index: index,
    inner_dimensions: tickDimensions(field(container, 'inner_dimensions', `containers[${index}]`)),
    placements: placementsOf(index, container).map((placement) => ({
      placement: placementReference(index, placement),
      dimensions: tickDimensions(field(placement, 'dimensions', `containers[${index}].placements[]`)),
    })),
  };
}

/**
 * Lengths as decimal strings of ticks: the scene contract's spelling, and one no engine has to
 * hold as a native number.
 */
function tickDimensions(dimensions) {
  const spelled = {};
  for (const axis of DIMENSION_AXES) spelled[axis] = ticksOf(field(dimensions, axis, 'dimensions'));
  return spelled;
}

function ticksOf(scalar) {
  const ticks = field(scalar, 'ticks', 'exact scalar');
  if (typeof ticks !== 'number' || !Number.isInteger(ticks)) {
    throw refusal('invalid_result', `ticks ${String(ticks)} is not an integer`);
  }
  // Beyond 2^53 - 1 the parser has already rounded the integer the result wrote, so the
  // decimal string would name a different length than the other engines copy.
  if (!Number.isSafeInteger(ticks)) {
    throw refusal('number_out_of_range', `ticks ${ticks} is beyond what every engine holds exactly`);
  }
  return String(ticks);
}

// ------------------------------------------------------------------------------ work order

/**
 * The display units, read from the result rather than re-derived from request defaults: the
 * result already rendered every value in them.
 */
function unitsOf(containers) {
  if (containers.length === 0) return { lengthUnit: null, weightUnit: null };
  const [first] = containers;
  const length = field(field(field(first, 'inner_dimensions', 'containers[0]'), 'length', 'inner_dimensions'),
    'unit', 'length');
  const weight = field(field(first, 'payload_weight', 'containers[0]'), 'unit', 'payload_weight');
  return { lengthUnit: length, weightUnit: weight };
}

function workOrderContainer(index, container, planContainer, lengthUnit, weightUnit) {
  const byReference = placementsByReference(index, container);
  // One line per plan step, in plan step order: the order is the plan's, looked up, never
  // derived a second time.
  const lines = planContainer.steps.map((step) => {
    const placement = byReference.get(referenceKey(step.placement));
    const line = {};
    if (hasOwn(step, 'sequence')) line.sequence = step.sequence;
    const position = field(placement, 'position', 'placement');
    const dimensions = field(placement, 'dimensions', 'placement');
    line.placement = step.placement;
    line.position = renderedValues(position, POSITION_AXES, 'position', lengthUnit);
    line.dimensions = renderedValues(dimensions, DIMENSION_AXES, 'dimensions', lengthUnit);
    return line;
  });
  return {
    container_index: index,
    container_type: get(container, 'container_type'),
    payload_weight: renderedValue(field(container, 'payload_weight', `containers[${index}]`), weightUnit),
    gross_weight: renderedValue(field(container, 'gross_weight', `containers[${index}]`), weightUnit),
    lines,
  };
}

function renderedValues(mapping, axes, where, unit) {
  const values = {};
  for (const axis of axes) values[axis] = renderedValue(field(mapping, axis, where), unit);
  return values;
}

/** A hash lookup per step, so the work order stays O(P) rather than scanning per line. */
function placementsByReference(index, container) {
  const placements = placementsOf(index, container);
  const found = new Map();
  for (const placement of placements) {
    found.set(referenceKey(placementReference(index, placement)), placement);
  }
  if (found.size !== placements.length) {
    throw refusal('invalid_result',
      `two placements in container ${index} share an origin, type and orientation`);
  }
  return found;
}

function referenceKey(reference) {
  const ticks = reference.position_ticks;
  return JSON.stringify([reference.item_type, reference.orientation, ticks.x, ticks.y, ticks.z]);
}

/** The result's rendered value, copied and never re-rendered. */
function renderedValue(scalar, unit) {
  const found = field(scalar, 'unit', 'exact scalar');
  if (found !== unit) {
    throw refusal('mixed_units', `a value in ${String(found)} where the result uses ${String(unit)}`);
  }
  const value = field(scalar, 'value', 'exact scalar');
  if (typeof value !== 'string') {
    throw refusal('invalid_result', `value ${String(value)} is not a string`);
  }
  return value;
}

// --------------------------------------------------------------------------------- helpers

/**
 * Every list entry the artifact and its plan read is an object, checked before either reads
 * one, so a malformed result is refused by name in every engine instead of failing wherever
 * each language first touches it. Linear in the entries it checks.
 */
function requireObjects(result) {
  for (const name of ['containers', 'unpacked_items', 'alternatives', 'catalog_versions_used']) {
    if (!list(get(result, name), `result.${name}`).every(isMapping)) {
      throw refusal('invalid_result', `result.${name} holds a non-object entry`);
    }
  }
  list(get(result, 'containers'), 'result.containers').forEach((container, index) => {
    if (!placementsOf(index, container).every(isMapping)) {
      throw refusal('invalid_result', `containers[${index}].placements holds a non-object entry`);
    }
  });
}

function placementsOf(index, container) {
  return list(get(container, 'placements'), `containers[${index}].placements`);
}

function list(value, where) {
  if (value === null) return [];
  if (!Array.isArray(value)) throw refusal('invalid_result', `${where} is not a list`);
  return [...value];
}

function field(mapping, name, where) {
  if (!isMapping(mapping) || !hasOwn(mapping, name)) {
    throw refusal('invalid_result', `${where} has no ${name}`);
  }
  return mapping[name];
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

function refusal(code, message) {
  return new OperationalArtifactError(code, message);
}
