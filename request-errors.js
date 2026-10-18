/**
 * Structured request errors: one type, a closed reason, and the JSON Pointer of the bad value.
 *
 * Held to `packvium.request_errors`. A caller who sends a malformed request needs to know which
 * value is wrong and why in a form a program can branch on, and four engines phrasing the prose
 * four ways answers neither. So every request error is an `InvalidRequestError` with:
 *
 * - `code`: `invalid_request` (a subclass such as `FixedPlacementError` names its own);
 * - `reason`: one of a closed set shared by all four engines (`packvium.request_errors.REASONS`);
 * - `field`: an RFC 6901 JSON Pointer to the offending value (`/items/0/quantity`), or `""` for
 *   the request as a whole;
 * - `detail`: the fixed text for the reason, so the message is identical in every engine.
 *
 * `checkRequest` walks the schema's rules over the raw JSON before any model is built, and the
 * first violation wins, in the order every engine follows: units, output, configuration, items,
 * containers. A cross-engine suite holds all four engines to the same reason, field and
 * message.
 *
 * This module is package-internal: the error class is re-exported from `fallback.js` and the
 * package root.
 */

import { compareCodePoints } from './commerce-model.js';
import { jsonSpelling } from './canonical-json.js';
import { boxCost } from './made-to-measure.js';

export const SOLVER_PROFILES = Object.freeze(['fast', 'balanced', 'quality', 'exact_small']);
export const OBJECTIVES = Object.freeze(['default', 'lowest_cost', 'shipping_cost', 'lowest_landed_cost', 'open_dimension_height', 'maximum_value', 'maximum_volume']);
export const ACCESS_DIRECTIONS = Object.freeze(['+x', '-x', '+y', '-y', '+z', '-z']);
// The schema's closed vocabularies, each refused as `not_allowed` like the two above.
export const SOLVERS = Object.freeze(['grid', 'extreme_points', 'homogeneous_blocks', 'layer', 'maximal_spaces', 'exact_small']);
export const ROTATIONS = Object.freeze(['LWH', 'LHW', 'WLH', 'WHL', 'HLW', 'HWL']);
export const LENGTH_UNITS = Object.freeze(['mm', 'cm', 'm', 'in', 'ft']);
export const WEIGHT_UNITS = Object.freeze(['mg', 'g', 'kg', 'oz', 'lb']);
export const GROUND_CONTACT_RULES = Object.freeze(['free', 'covered', 'single', 'multiple']);
export const SHAPE_TYPES = Object.freeze(['rigid_cuboid', 'convex_hull', 'compressible']);

/** The request is not one any engine may answer. Nothing was solved. */
export class InvalidRequestError extends RangeError {
  static code = 'invalid_request';

  /** The message a subclass may respell; it runs before `this` exists, so it is static. */
  static describe(field, detail) {
    return field ? `${this.code}: ${field}: ${detail}` : `${this.code}: ${detail}`;
  }

  constructor(reason, field, detail) {
    super(new.target.describe(field, detail));
    this.name = 'InvalidRequestError';
    this.code = new.target.code;
    this.reason = reason;
    this.field = field;
    this.detail = detail;
  }
}

/** The RFC 6901 pointer to a value, escaping `~` and `/` in keys. */
export function pointer(...parts) {
  return parts.map((part) => `/${String(part).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

// ------------------------------------------------------------------------------ primitives

const MAX_EXACT_MAGNITUDE = Number.MAX_SAFE_INTEGER;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function requireInteger(value, field, minimum) {
  if (Number.isSafeInteger(value)) {
    if (value < minimum) throw new InvalidRequestError('below_minimum', field, `must be at least ${minimum}`);
    return;
  }
  // A whole number past 2^53 - 1 is out of range, not mistyped: say which way.
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (value < minimum) throw new InvalidRequestError('below_minimum', field, `must be at least ${minimum}`);
    throw new InvalidRequestError('above_maximum', field, `must be at most ${MAX_EXACT_MAGNITUDE}`);
  }
  throw new InvalidRequestError('wrong_type', field, 'must be an integer');
}

function requireRatio(value, field, maximum = 1) {
  if (typeof value !== 'number') throw new InvalidRequestError('wrong_type', field, 'must be a number');
  if (value < 0) throw new InvalidRequestError('below_minimum', field, 'must be at least 0');
  if (maximum !== null && value > maximum) {
    throw new InvalidRequestError('above_maximum', field, `must be at most ${maximum}`);
  }
}

const requireUnbounded = (value, field) => requireRatio(value, field, null);

function requireOneOf(value, field, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new InvalidRequestError('not_allowed', field, `must be one of ${jsonSpelling([...allowed])}`);
  }
}

const oneOf = (allowed) => (value, field) => requireOneOf(value, field, allowed);

const eachOneOf = (allowed) => (raw, where) => {
  requireList(raw, where).forEach((value, index) => requireOneOf(value, where + pointer(index), allowed));
};

/**
 * The schema closes this object: a key it does not name is refused, never ignored. The first
 * unknown key in code-point order is named, the order every engine can share.
 */
function requireKnownFields(value, field, known) {
  const unknown = Object.keys(value).filter((key) => !known.includes(key)).sort(compareCodePoints);
  if (unknown.length > 0) {
    throw new InvalidRequestError('not_allowed', field + pointer(unknown[0]), 'is not a known field');
  }
}

function requireObject(value, field) {
  if (!isObject(value)) throw new InvalidRequestError('wrong_type', field, 'must be an object');
  return value;
}

function requireList(value, field) {
  if (!Array.isArray(value)) throw new InvalidRequestError('wrong_type', field, 'must be a list');
  return value;
}

/**
 * A measure is an integer, a string or `{value, unit}`, and never negative. `kind` is the
 * engine's own parser for one quantity (`{units, parse}`), so what a measure may spell is the
 * parser's to say, exactly as it is when the model is built.
 */
function requireMeasure(value, field, kind, unit) {
  const whole = typeof value === 'number' && Number.isInteger(value);
  if (!whole && typeof value !== 'string' && !isObject(value)) {
    throw new InvalidRequestError('wrong_type', field, 'must be a measure');
  }
  if (isObject(value)) requireMeasureObject(value, field, kind, unit);
  try {
    kind.parse(value, unit);
  } catch (error) {
    if (String(error?.message).includes('cannot be negative')) {
      throw new InvalidRequestError('negative_measure', field, 'cannot be negative');
    }
    throw new InvalidRequestError('wrong_type', field, 'must be a measure');
  }
}

function requireMeasureObject(value, field, kind, unit) {
  if (!hasOwn(value, 'value')) throw new InvalidRequestError('wrong_type', field, 'must be a measure');
  const stated = hasOwn(value, 'unit') ? value.unit : unit;
  if (!knownUnit(stated, kind)) {
    throw new InvalidRequestError('invalid_unit', field, `has an unknown unit ${jsonSpelling(stated)}`);
  }
}

const knownUnit = (unit, kind) => typeof unit === 'string' && hasOwn(kind.units, unit.trim().toLowerCase());

// ------------------------------------------------------------------------------ the rules

const CONFIGURATION_INTEGERS = [['time_limit_ms', 1], ['alternatives', 1], ['max_containers', 1],
  ['exact_item_limit', 1], ['multi_start_orders', 1], ['max_candidates_per_item', 1],
  ['max_candidate_points', 16], ['container_plan_beam_width', 1], ['container_plan_node_limit', 1],
  ['dimensional_weight_divisor', 1]];
const EFFORT_LIMITS = ['max_candidates_evaluated', 'max_placement_attempts', 'max_search_nodes', 'max_restarts'];
/** Every key the request schema's `configuration` declares; it sets `additionalProperties: false`. */
const CONFIGURATION_FIELDS = ['alternatives', 'clearance', 'container_plan_beam_width',
  'container_plan_node_limit', 'dimensional_weight_divisor', 'dimensional_weight_length_unit',
  'dimensional_weight_weight_unit', 'effort_budget', 'exact_item_limit', 'max_candidate_points',
  'max_candidates_per_item', 'max_containers', 'minimum_support_ratio', 'multi_start_orders', 'objective',
  'require_placement_coordinates', 'seed', 'solver_profile', 'solvers', 'time_limit_ms'];
const SIDES = ['length', 'width', 'height'];
const AXES = ['x', 'y', 'z'];
const atLeast = (minimum) => (value, field) => requireInteger(value, field, minimum);

/**
 * Refuse the request with its first violation, or return. O(size of the request).
 *
 * `measures` is `{length, weight}`, each `{units, parse(value, unit)}`: the engine's own unit
 * table and parser, passed in so this module stays below the solver it guards.
 */
export function checkRequest(data, measures) {
  const request = requireObject(data, '');
  const unit = checkUnits(request.units, measures.length);
  checkOutput(request.output);
  const length = (value, field) => requireMeasure(value, field, measures.length, unit);
  const weight = (value, field) => requireMeasure(value, field, measures.weight, 'g');
  checkConfiguration(request.configuration, length);
  const items = requiredList(request, 'items', '');
  const lengthTicks = (value) => measures.length.parse(value, unit);
  items.forEach((raw, index) => checkItem(raw, pointer('items', index), length, weight, lengthTicks));
  requireUniqueIds(items, 'items');
  const containers = requiredList(request, 'containers', '');
  containers.forEach((raw, index) => checkContainer(raw, pointer('containers', index), length, weight, lengthTicks));
  requireUniqueIds(containers, 'containers');
}

function checkUnits(raw, lengths) {
  if (raw == null) return 'mm';
  const length = requireObject(raw, '/units').length;
  if (length == null) return 'mm';
  if (!knownUnit(length, lengths)) {
    throw new InvalidRequestError('invalid_unit', '/units/length', `has an unknown unit ${jsonSpelling(length)}`);
  }
  return length;
}

function checkOutput(raw) {
  if (raw == null) return;
  const output = requireObject(raw, '/output');
  optional(output, 'length_unit', '/output', oneOf(LENGTH_UNITS));
  optional(output, 'weight_unit', '/output', oneOf(WEIGHT_UNITS));
}

function checkConfiguration(raw, length) {
  if (raw == null) return;
  const configuration = requireObject(raw, '/configuration');
  requireKnownFields(configuration, '/configuration', CONFIGURATION_FIELDS);
  optional(configuration, 'solver_profile', '/configuration', oneOf(SOLVER_PROFILES));
  optional(configuration, 'objective', '/configuration', oneOf(OBJECTIVES));
  optional(configuration, 'solvers', '/configuration', eachOneOf(SOLVERS));
  optional(configuration, 'dimensional_weight_length_unit', '/configuration', oneOf(LENGTH_UNITS));
  optional(configuration, 'dimensional_weight_weight_unit', '/configuration', oneOf(WEIGHT_UNITS));
  for (const [name, minimum] of CONFIGURATION_INTEGERS) optional(configuration, name, '/configuration', atLeast(minimum));
  optional(configuration, 'minimum_support_ratio', '/configuration', requireRatio);
  optional(configuration, 'clearance', '/configuration', length);
  if (configuration.effort_budget == null) return;
  const budget = requireObject(configuration.effort_budget, '/configuration/effort_budget');
  requireKnownFields(budget, '/configuration/effort_budget', EFFORT_LIMITS);
  for (const name of EFFORT_LIMITS) optional(budget, name, '/configuration/effort_budget', atLeast(1));
}

function checkItem(raw, where, length, weight, lengthTicks) {
  const item = requireObject(raw, where);
  requiredString(item, 'id', where);
  optional(item, 'quantity', where, atLeast(1));
  dimensions(required(item, 'dimensions', where), `${where}/dimensions`, length);
  optional(item, 'weight', where, weight);
  optional(item, 'max_top_load', where, weight);
  optional(item, 'nesting_height', where, length);
  optional(item, 'nesting_height', where, (value, field) => nestingBelowHeight(value, field, item, lengthTicks));
  optional(item, 'max_stacked_items', where, atLeast(1));
  optional(item, 'stop_index', where, atLeast(0));
  optional(item, 'value', where, atLeast(0));
  optional(item, 'max_compression_pressure_kpa', where, atLeast(0));
  optional(item, 'minimum_support_ratio', where, requireRatio);
  optional(item, 'compression_ratio', where, requireUnbounded);
  optional(item, 'stacking_group', where, stackingGroupName);
  optional(item, 'accepts_stacking_groups', where, stackingGroupNames);
  optional(item, 'allowed_rotations', where, eachOneOf(ROTATIONS));
  optional(item, 'ground_contact_rule', where, oneOf(GROUND_CONTACT_RULES));
  optional(item, 'shape_type', where, oneOf(SHAPE_TYPES));
}

/**
 * A nested copy sinks by less than its own height, or it would vanish into the one below
 *. Both measures have passed their own rules already. O(1).
 */
function nestingBelowHeight(value, field, item, lengthTicks) {
  if (lengthTicks(value) >= lengthTicks(item.dimensions.height)) {
    throw new InvalidRequestError('invalid_value', field, "must be less than the item's height");
  }
}

function stackingGroupName(value, field) {
  if (typeof value !== 'string') throw new InvalidRequestError('wrong_type', field, 'must be a string');
  if (value === '') throw new InvalidRequestError('invalid_value', field, 'must not be empty');
}

function stackingGroupNames(raw, where) {
  requireList(raw, where).forEach((name, index) => stackingGroupName(name, where + pointer(index)));
}

function checkContainer(raw, where, length, weight, lengthTicks) {
  const container = requireObject(raw, where);
  requiredString(container, 'id', where);
  optional(container, 'quantity', where, atLeast(1));
  dimensions(required(container, 'inner_dimensions', where), `${where}/inner_dimensions`, length);
  optional(container, 'outer_dimensions', where, (v, f) => dimensions(v, f, length));
  for (const name of ['tare_weight', 'max_payload', 'max_stack_density']) optional(container, name, where, weight);
  optional(container, 'max_items', where, atLeast(1));
  optional(container, 'cost_minor', where, atLeast(0));
  optional(container, 'void_fill_reserve_ratio', where, requireRatio);
  optional(container, 'access_directions', where, accessDirections);
  optional(container, 'tag_limits', where, tagLimits);
  optional(container, 'rate_table', where, rateTable);
  optional(container, 'obstacles', where, (v, f) => obstacles(v, f, length));
  optional(container, 'deformable_boundary', where, (v, f) => deformableBoundary(container, v, f, where));
  optional(container, 'made_to_measure', where, (v, f) => madeToMeasure(container, v, f, where, { length, weight, lengthTicks }));
}

/** Every key the request schema's `made_to_measure` declares; it sets `additionalProperties: false`. */
const MADE_TO_MEASURE_FIELDS = ['cost_per_square_metre_minor', 'increment', 'minimum', 'outer_allowance',
  'tare_per_square_metre'];

/**
 * The made-to-measure block's shape top to bottom, then each axis's four rules, then the
 * price ceiling. Run after every other container field, so an existing error always wins. O(1).
 */
function madeToMeasure(container, raw, field, where, { length, weight, lengthTicks }) {
  const machine = requireObject(raw, field);
  requireKnownFields(machine, field, MADE_TO_MEASURE_FIELDS);
  for (const name of ['minimum', 'increment']) required(machine, name, field);
  for (const name of ['minimum', 'increment', 'outer_allowance']) optional(machine, name, field, (v, f) => dimensions(v, f, length));
  optional(machine, 'cost_per_square_metre_minor', field, atLeast(0));
  optional(machine, 'tare_per_square_metre', field, weight);
  if (container.outer_dimensions != null) {
    throw new InvalidRequestError('not_allowed', where + pointer('outer_dimensions'), 'cannot be combined with made_to_measure');
  }
  const ticks = (sides) => SIDES.map((side) => lengthTicks(sides[side]));
  const inner = ticks(container.inner_dimensions), minimum = ticks(machine.minimum), increment = ticks(machine.increment);
  SIDES.forEach((side, axis) => {
    if (minimum[axis] === 0) throw new InvalidRequestError('invalid_value', field + pointer('minimum', side), 'must be positive');
    if (increment[axis] === 0) throw new InvalidRequestError('invalid_value', field + pointer('increment', side), 'must be positive');
    if (minimum[axis] > inner[axis]) {
      throw new InvalidRequestError('invalid_value', field + pointer('minimum', side), 'exceeds inner_dimensions');
    }
    if ((inner[axis] - minimum[axis]) % increment[axis] !== 0) {
      throw new InvalidRequestError('invalid_value', field + pointer('increment', side), 'does not divide inner_dimensions minus minimum');
    }
  });
  if (boxCost(machine.cost_per_square_metre_minor ?? 0, container.cost_minor ?? 0, inner) > BigInt(MAX_EXACT_MAGNITUDE)) {
    throw new InvalidRequestError('invalid_value', field + pointer('cost_per_square_metre_minor'),
      `prices the largest box above ${MAX_EXACT_MAGNITUDE}`);
  }
}

/**: the kinds `deformable_boundary` admits. */
export const DEFORMABLE_BOUNDARY_KINDS = Object.freeze(['flat_bag']);
/** Container fields a flat bag refuses, in reporting order (docs/DEFORMABLE-CONTAINERS.md). */
const BAG_EXCLUSIONS = Object.freeze(['obstacles', 'axles', 'access_directions', 'max_stack_density',
  'outer_dimensions', 'void_fill_reserve_ratio', 'made_to_measure']);

function deformableBoundary(container, raw, field, where) {
  const boundary = requireObject(raw, field);
  requireOneOf(required(boundary, 'kind', field), field + pointer('kind'), DEFORMABLE_BOUNDARY_KINDS);
  requireKnownFields(boundary, field, ['kind']);
  for (const name of BAG_EXCLUSIONS) {
    if (setBesideABag(name, hasOwn(container, name) ? container[name] : null)) {
      throw new InvalidRequestError('not_allowed', where + pointer(name), 'cannot be combined with deformable_boundary');
    }
  }
}

// An empty obstacle list and a zero reserve change nothing, so only they are let through.
function setBesideABag(name, value) {
  if (name === 'obstacles') return Array.isArray(value) && value.length > 0;
  if (name === 'void_fill_reserve_ratio') return value != null && value > 0;
  return value != null;
}

const accessDirections = eachOneOf(ACCESS_DIRECTIONS);

function dimensions(raw, where, length) {
  const sides = requireObject(raw, where);
  for (const side of SIDES) length(required(sides, side, where), where + pointer(side));
}

// Tags in code-point order, as every engine walks them: a JavaScript object lists integer-like
// keys first, so its own order would name a different bad tag than the others do.
function tagLimits(raw, where) {
  const limits = requireObject(raw, where);
  for (const tag of Object.keys(limits).sort(compareCodePoints)) requireInteger(limits[tag], where + pointer(tag), 1);
}

function rateTable(raw, where) {
  const table = requireObject(raw, where);
  for (const [name, minimum] of [['weight_brackets_g', 1], ['prices_minor', 0]]) {
    if (table[name] == null) continue;
    requireList(table[name], where + pointer(name))
      .forEach((value, index) => requireInteger(value, where + pointer(name, index), minimum));
  }
  optional(table, 'minimum_charge_minor', where, atLeast(0));
  optional(table, 'fuel_surcharge_permille', where, atLeast(0));
}

function obstacles(raw, where, length) {
  requireList(raw, where).forEach((entry, index) => {
    const at = where + pointer(index);
    const obstacle = requireObject(entry, at);
    if (obstacle.origin != null) {
      const point = requireObject(obstacle.origin, `${at}/origin`);
      for (const axis of AXES) optional(point, axis, `${at}/origin`, length);
    }
    dimensions(required(obstacle, 'dimensions', at), `${at}/dimensions`, length);
  });
}

// ------------------------------------------------------------------------------ plumbing

/** An optional field: absent and null are the default; anything else must pass. */
function optional(container, name, where, check) {
  const value = hasOwn(container, name) ? container[name] : null;
  if (value != null) check(value, where + pointer(name));
}

function required(container, name, where) {
  const value = hasOwn(container, name) ? container[name] : null;
  if (value == null) throw new InvalidRequestError('missing_field', where + pointer(name), 'is required');
  return value;
}

const requiredList = (container, name, where) => requireList(required(container, name, where), where + pointer(name));

function requiredString(container, name, where) {
  if (typeof required(container, name, where) !== 'string') {
    throw new InvalidRequestError('wrong_type', where + pointer(name), 'must be a string');
  }
}

/** Checked once every entry is well formed, so the later of two equal ids is named. */
function requireUniqueIds(entries, key) {
  const seen = new Set();
  entries.forEach((entry, index) => {
    if (seen.has(entry.id)) {
      throw new InvalidRequestError('duplicate_id', pointer(key, index, 'id'), `repeats the id ${jsonSpelling(entry.id)}`);
    }
    seen.add(entry.id);
  });
}
