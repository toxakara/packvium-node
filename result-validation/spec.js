/**
 * The request, read independently of the engine's own model (the reference's `ItemSpec`,
 * `ContainerSpec` and `MachineSpec`).
 */

import { ROTATIONS, cuboid } from './geometry.js';
import {
  PyDict, at, compareCodePoints, flag, getNull, getOr, hashKey, int, isDict, list, optInt, pyEq, pyInt, text, truthy,
} from './json.js';
import { ratioPpm } from './num.js';
import { shape } from './outcome.js';
import { LENGTH, WEIGHT, dimensions, ratioOf, toTicks } from './units.js';

/** The six axis-aligned exit directions a placement could be slid out through. */
export const EXIT_DIRECTIONS = Object.freeze(['+x', '-x', '+y', '-y', '+z', '-z']);

const UPRIGHT_ROTATIONS = ['LWH', 'WLH'];

/** `ROTATIONS[orientation]`. */
export function rotationAxes(orientation) {
  const found = ROTATIONS.find(([name]) => name === orientation);
  if (found === undefined) throw shape(`unknown orientation ${JSON.stringify(orientation)}`);
  return found[1];
}

/** `orientation in ROTATIONS`, for any document value; an unhashable one is Python's `TypeError`. */
export function isRotation(orientation) {
  hashKey(orientation);
  return typeof orientation === 'string' && ROTATIONS.some(([name]) => name === orientation);
}

/** `value in tags` for a frozenset of strings; an unhashable value is Python's `TypeError`. */
export function holds(tags, value) {
  hashKey(value);
  return typeof value === 'string' && tags.has(value);
}

export function intersectsTags(left, right) {
  for (const tag of left) {
    if (right.has(tag)) return true;
  }
  return false;
}

/** `sorted(tags)`, by code point. */
export const sortedTags = (tags) => Array.from(tags).sort(compareCodePoints);

export const allows = (spec, orientation) => spec.allowedRotations.some((allowed) => pyEq(allowed, orientation));

export function rotated(spec, orientation) {
  const axes = rotationAxes(orientation);
  return [spec.dimensions[axes[0]], spec.dimensions[axes[1]], spec.dimensions[axes[2]]];
}

/** `frozenset(value)` of a request's tag list. The contract's tags are strings. */
function tagSet(value, what) {
  return new Set(list(value, what).map((tag) => text(tag, what)));
}

/** `None if raw.get(key) is None else read(raw[key])`. */
function optional(raw, key, read) {
  const value = getNull(raw, key);
  return value === null ? null : read(value);
}

const weightTicks = (value) => toTicks(value, 'g', WEIGHT);

function allowedRotations(raw, keepUpright) {
  const listed = getNull(raw, 'allowed_rotations');
  if (listed !== null) return list(listed, 'allowed_rotations').slice();
  return keepUpright ? UPRIGHT_ROTATIONS.slice() : ROTATIONS.map(([name]) => name);
}

function hullVertices(value, unit) {
  return list(value, 'hull_vertices').map((vertex) => ['x', 'y', 'z'].map((axis) => toTicks(at(vertex, axis), unit, LENGTH)));
}

function parseItem(raw, unit, index) {
  const owner = `items[${index}]`;
  const keepUpright = flag(raw, 'keep_upright', false, owner);
  const stackable = flag(raw, 'stackable', true, owner);
  const mustBeOnFloor = flag(raw, 'must_be_on_floor', false, owner);
  const groups = getNull(raw, 'accepts_stacking_groups');
  return Object.freeze({
    allowedRotations: allowedRotations(raw, keepUpright),
    id: text(at(raw, 'id'), 'an item id'),
    dimensions: dimensions(at(raw, 'dimensions'), unit),
    weight: weightTicks(getOr(raw, 'weight', 0)),
    quantity: getOr(raw, 'quantity', 1),
    stackable,
    mustBeOnFloor,
    maxTopLoad: optional(raw, 'max_top_load', weightTicks),
    minimumSupportRatio: ratioOf(getOr(raw, 'minimum_support_ratio', 0)),
    tags: tagSet(getOr(raw, 'tags', []), 'tags'),
    eligibleContainerTags: tagSet(getOr(raw, 'eligible_container_tags', []), 'eligible_container_tags'),
    maxStackedItems: optInt(getNull(raw, 'max_stacked_items'), 'max_stacked_items'),
    groundContactRule: getNull(raw, 'ground_contact_rule'),
    nestingHeight: optional(raw, 'nesting_height', (value) => toTicks(value, unit, LENGTH)),
    incompatibleTags: tagSet(getOr(raw, 'incompatible_tags', []), 'incompatible_tags'),
    stopIndex: optInt(getNull(raw, 'stop_index'), 'stop_index'),
    value: getNull(raw, 'value'),
    shapeType: getOr(raw, 'shape_type', 'rigid_cuboid'),
    hullVertices: optional(raw, 'hull_vertices', (value) => hullVertices(value, unit)),
    // The solvers' ratio rule, applied once: floor(ratio * 1000000 + 0.5) on the double.
    compressionRatioPpm: optional(raw, 'compression_ratio', (value) => ratioPpm(ratioOf(value))),
    maxCompressionPressureKpa: optInt(getNull(raw, 'max_compression_pressure_kpa'), 'max_compression_pressure_kpa'),
    stackingGroup: getNull(raw, 'stacking_group'),
    acceptsStackingGroups: truthy(groups) ? tagSet(groups, 'accepts_stacking_groups') : new Set(),
  });
}

/** The request's item types by id, in request order; a repeated id keeps its first place. */
export function parseItems(request, unit) {
  const items = new PyDict();
  for (const [index, raw] of list(at(request, 'items'), 'request.items').entries()) {
    const spec = parseItem(raw, unit, index);
    items.set(at(raw, 'id'), spec);
  }
  return items;
}

function accessDirections(raw) {
  const declared = list(getOr(raw, 'access_directions', []), 'access_directions');
  declared.forEach(hashKey);
  return EXIT_DIRECTIONS.filter((direction) => declared.some((value) => value === direction));
}

function obstacles(raw, unit) {
  const boxes = [];
  for (const obstacle of list(getOr(raw, 'obstacles', []), 'obstacles')) {
    const additional = list(getOr(obstacle, 'additional_boxes', []), 'additional_boxes');
    for (const component of [obstacle, ...additional]) {
      const origin = getOr(component, 'origin', {});
      const [length, width, height] = dimensions(at(component, 'dimensions'), unit);
      const [x, y, z] = ['x', 'y', 'z'].map((axis) => toTicks(getOr(origin, axis, 0), unit, LENGTH));
      boxes.push(cuboid(x, y, z, length, width, height));
    }
  }
  return boxes;
}

/** `{str(tag): int(limit)}`, then sorted by tag as the reference iterates it. */
function tagLimits(raw) {
  const declared = getOr(raw, 'tag_limits', {});
  if (!isDict(declared)) throw shape('tag_limits must be an object');
  return Object.keys(declared)
    .map((tag) => [tag, pyInt(declared[tag], 'tag_limits')])
    .sort(([left], [right]) => compareCodePoints(left, right));
}

function parseMachine(raw, unit) {
  const sides = (name) => {
    const value = getNull(raw, name);
    return value === null ? [0n, 0n, 0n] : dimensions(value, unit);
  };
  const price = getNull(raw, 'cost_per_square_metre_minor');
  return Object.freeze({
    minimum: sides('minimum'),
    increment: sides('increment'),
    pricePerSquareMetreMinor: truthy(price) ? int(price, 'cost_per_square_metre_minor') : 0n,
    tarePerSquareMetre: optional(raw, 'tare_per_square_metre', weightTicks) ?? 0n,
    allowance: sides('outer_allowance'),
  });
}

function axles(value, unit) {
  return list(value, 'axles').map((axle) => Object.freeze({
    position: toTicks(at(axle, 'position'), unit, LENGTH),
    maxLoad: optional(axle, 'max_load', weightTicks),
  }));
}

function parseContainer(raw, unit) {
  return Object.freeze({
    id: at(raw, 'id'),
    inner: dimensions(at(raw, 'inner_dimensions'), unit),
    accessDirections: accessDirections(raw),
    outer: optional(raw, 'outer_dimensions', (value) => dimensions(value, unit)),
    costMinor: int(getOr(raw, 'cost_minor', 0), 'cost_minor'),
    maxPayload: optional(raw, 'max_payload', weightTicks),
    maxItems: optInt(getNull(raw, 'max_items'), 'max_items'),
    quantity: optInt(getNull(raw, 'quantity'), 'quantity'),
    obstacles: obstacles(raw, unit),
    tags: tagSet(getOr(raw, 'tags', []), 'tags'),
    tagLimits: tagLimits(raw),
    voidFillReserveRatio: ratioOf(getOr(raw, 'void_fill_reserve_ratio', 0)),
    tareWeight: weightTicks(getOr(raw, 'tare_weight', 0)),
    axles: optional(raw, 'axles', (value) => axles(value, unit)),
    maxStackDensity: optional(raw, 'max_stack_density', weightTicks),
    rateTable: getNull(raw, 'rate_table'),
    flatBag: getNull(raw, 'deformable_boundary') !== null,
    reportsAchievedExtent: getNull(raw, 'deformable_boundary') !== null || getNull(raw, 'made_to_measure') !== null,
    madeToMeasure: optional(raw, 'made_to_measure', (machine) => parseMachine(machine, unit)),
  });
}

/** The request's container types by id, in request order. */
export function parseContainers(request, unit) {
  const containers = new PyDict();
  for (const raw of list(at(request, 'containers'), 'request.containers')) {
    containers.set(at(raw, 'id'), parseContainer(raw, unit));
  }
  return containers;
}

export const volumeOf = (container) => container.inner[0] * container.inner[1] * container.inner[2];
