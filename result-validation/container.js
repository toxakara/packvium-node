/**
 * One packed container: its geometry, its loads, its accounting figures, and the box a
 * made-to-measure machine would have cut for it.
 */

import { contains, cuboid, intersects, vertices, solidsOverlap } from './geometry.js';
import {
  PyDict, at, get, getNull, getOr, has, int, isDict, list, pyEq, pyInt, truthy,
} from './json.js';
import { Refusal, contract, issue, shape } from './outcome.js';
import { abs, ceilDiv, floorDiv, max, pyMod, ratioPpm } from './num.js';
import { intTuple, list as listRepr, pyRepr, pyStr, strRepr, valueTuple } from './pyfmt.js';
import { allows, intersectsTags, isRotation, rotated, sortedTags, volumeOf } from './spec.js';
import {
  SCORE_SCALE, SQUARE_METRE_TICKS, checkCrush, checkRouteRemovalOrder, checkStackDensity, checkSupportAndLoad,
  occupiedVolume, placedHull, propagateLoad, supportGraph, validNesting,
} from './stacking.js';

const SIDES = ['length', 'width', 'height'];

/**
 * A packed container's id as an issue prints it. The reference reads `packed["id"]` only while
 * formatting an issue, so a missing id fails only once an issue needs it; `verify` reports that
 * after the check, which aborts the run exactly as the reference's `KeyError` does.
 */
export class Label {
  constructor(packed) {
    const id = get(packed, 'id');
    this.text = id === undefined ? null : pyStr(id);
    this.missingUsed = false;
  }

  toString() {
    if (this.text !== null) return this.text;
    this.missingUsed = true;
    return '?';
  }

  verify() {
    if (this.missingUsed) throw shape('a packed container with an issue has no id');
  }
}

/** The physical box grown by the clearance margin; without integer ticks, the reference's contract refusal. */
export function envelopeOf(placement, clearance) {
  try {
    const position = at(placement, 'position');
    const dimensions = at(placement, 'dimensions');
    const tick = (block, key) => int(at(at(block, key), 'ticks'), 'placement ticks');
    const margin = 2n * clearance;
    return cuboid(
      tick(position, 'x') - clearance, tick(position, 'y') - clearance, tick(position, 'z') - clearance,
      tick(dimensions, 'length') + margin, tick(dimensions, 'width') + margin, tick(dimensions, 'height') + margin,
    );
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    throw contract(`placement is missing tick coordinates: ${error.message}`);
  }
}

/** The largest envelope x2, y2 and z2 over a packed container's placements. */
export function achievedExtent(packed, clearance) {
  const boxes = list(at(packed, 'placements'), 'placements').map((placement) => envelopeOf(placement, clearance));
  if (boxes.length === 0) return [0n, 0n, 0n];
  return boxes.slice(1).reduce(
    (extent, box) => [max(extent[0], box.x2), max(extent[1], box.y2), max(extent[2], box.z2)],
    [boxes[0].x2, boxes[0].y2, boxes[0].z2],
  );
}

const matchesInts = (values, expected) => values !== null && values.length === expected.length
  && values.every((value, index) => pyEq(value, expected[index]));

const optionalTuple = (values) => (values === null ? 'None' : valueTuple(values));

/**
 * `achieved_dimensions` is present exactly when the container declares a soft size, and equals
 * the tight extent; a flat bag's extent must pass the girth rule.
 */
export function checkAchievedExtent(packed, spec, clearance, issues) {
  const reported = getNull(packed, 'achieved_dimensions');
  const packedId = new Label(packed);
  if (!spec.reportsAchievedExtent) {
    if (reported !== null) issues.push(issue('achieved_dimensions_mismatch', `${packedId}: reported for a container of fixed size`));
    packedId.verify();
    return;
  }
  const [a, b, c] = achievedExtent(packed, clearance);
  const stated = isDict(reported) ? SIDES.map((side) => getNull(getOr(reported, side, {}), 'ticks')) : null;
  if (!matchesInts(stated, [a, b, c])) {
    issues.push(issue('achieved_dimensions_mismatch', `${packedId}: reported ${optionalTuple(stated)}, computed ${intTuple([a, b, c])}`));
  }
  if (spec.flatBag && (a + c > spec.inner[0] || b + c > spec.inner[1])) {
    issues.push(issue('bag_girth_exceeded',
      `${packedId}: a + c = ${a + c}, b + c = ${b + c}, flat size ${spec.inner[0]} x ${spec.inner[1]}`));
  }
  packedId.verify();
}

/** The smallest size on the machine grid `minimum + k * increment` that is at least `achieved`. */
const fabricatedSide = (achieved, minimum, increment) => minimum + ceilDiv(max(achieved, minimum) - minimum, increment) * increment;

/** `ceil(rate * 2(LW + LH + WH) / 1 m^2)`, the material and board rounding. */
function perSquareMetreCeiling(rate, [length, width, height]) {
  return ceilDiv(rate * 2n * (length * width + length * height + width * height), SQUARE_METRE_TICKS);
}

/** `(block.get(key) or {}).get("ticks")`. */
function nestedTicks(block, key) {
  const value = getNull(block, key);
  return truthy(value) ? getNull(value, 'ticks') : null;
}

/** `(value.get(key) or {}).get("ticks")` per side, or `null` when `value` is not an object. */
const reportedTicks = (value) => (isDict(value) ? SIDES.map((side) => nestedTicks(value, side)) : null);

/** The summed weight of every placement whose type the request declares. */
function payloadOf(placements, items) {
  return placements.reduce((total, placement) => {
    const spec = items.get(at(placement, 'item_type'));
    return spec === undefined ? total : total + spec.weight;
  }, 0n);
}

/**
 * Recompute a made-to-measure container's box from its placements alone and return the spec
 * every later check uses: the recomputed box, never the reported one. O(p).
 */
export function checkMadeToMeasure(packed, compact, spec, items, clearance, issues) {
  const containerId = pyStr(getOr(packed, 'id', '?'));
  const reportedBlock = getNull(packed, 'made_to_measure');
  const machine = spec.madeToMeasure;
  if (machine === null) {
    if (reportedBlock !== null) issues.push(issue('made_to_measure_unexpected', containerId));
    return spec;
  }
  if (!isDict(reportedBlock)) issues.push(issue('made_to_measure_missing', containerId));
  const block = isDict(reportedBlock) ? reportedBlock : {};
  if (compact) issues.push(issue('lattice_summary_on_made_to_measure', containerId));
  const achieved = achievedExtent(packed, clearance);
  const fabricated = [0, 1, 2].map((axis) => fabricatedSide(achieved[axis], machine.minimum[axis], machine.increment[axis]));
  if (fabricated.some((side, axis) => side > spec.inner[axis])) {
    issues.push(issue('fabricated_dimensions_exceed_machine', `${containerId}: ${intTuple(fabricated)} beyond ${intTuple(spec.inner)}`));
  }
  const reportedInner = reportedTicks(getNull(packed, 'inner_dimensions'));
  if (!matchesInts(reportedInner, fabricated)) {
    issues.push(issue('fabricated_dimensions_mismatch',
      `${containerId}: reported ${optionalTuple(reportedInner)}, computed ${intTuple(fabricated)}`));
  }
  const outer = fabricated.map((side, axis) => side + machine.allowance[axis]);
  const reportedOuter = reportedTicks(getNull(packed, 'outer_dimensions'));
  if (!matchesInts(reportedOuter, outer)) {
    issues.push(issue('outer_dimensions_mismatch', `${containerId}: reported ${optionalTuple(reportedOuter)}, computed ${intTuple(outer)}`));
  }
  const cost = spec.costMinor + perSquareMetreCeiling(machine.pricePerSquareMetreMinor, fabricated);
  const reportedCost = getNull(block, 'cost_minor');
  if (!pyEq(reportedCost, cost)) {
    issues.push(issue('made_to_measure_cost_mismatch', `${containerId}: reported ${pyStr(reportedCost)}, computed ${cost}`));
  }
  const tare = spec.tareWeight + perSquareMetreCeiling(machine.tarePerSquareMetre, fabricated);
  const reportedTare = nestedTicks(block, 'tare_weight');
  if (!pyEq(reportedTare, tare)) {
    issues.push(issue('made_to_measure_tare_mismatch', `${containerId}: reported ${pyStr(reportedTare)}, computed ${tare}`));
  }
  const gross = tare + payloadOf(list(at(packed, 'placements'), 'placements'), items);
  const reportedGross = nestedTicks(packed, 'gross_weight');
  if (!pyEq(reportedGross, gross)) {
    issues.push(issue('gross_weight_mismatch', `${containerId}: reported ${pyStr(reportedGross)}, computed ${gross}`));
  }
  return Object.freeze({ ...spec, inner: fabricated, outer, costMinor: cost, tareWeight: tare });
}

/** Every check of one packed container against its (possibly recomputed) type. */
export function checkContainer(packed, spec, items, clearance, globalSupport, issues) {
  const packedId = new Label(packed);
  const placements = list(at(packed, 'placements'), 'placements');
  const envelopes = new PyDict();
  const scope = {
    packed, packedId, spec, items, clearance, envelopes, issues, boundary: cuboid(0n, 0n, 0n, ...spec.inner),
  };
  let payload = 0n;
  for (const placement of placements) {
    const itemSpec = checkPlacement(scope, placement);
    if (itemSpec !== undefined) payload += itemSpec.weight;
  }
  const entries = envelopes.items();
  checkPairs(entries, packedId, issues);
  const graph = supportGraph(entries);
  checkSupportAndLoad(entries, graph, globalSupport, issues);
  const loads = propagateLoad(entries, graph);
  if (spec.maxStackDensity !== null) checkStackDensity(packedId, entries, loads, spec.maxStackDensity, issues);
  checkCrush(packedId, entries, loads, issues);
  checkRouteRemovalOrder(packedId, entries, graph, spec.inner, spec.accessDirections, issues);
  checkLimits(packed, packedId, placements, spec, items, payload, issues);
  checkVolumes(packed, packedId, placements, spec, items, envelopes, loads, issues);
  const totalWeight = payloadOf(placements, items);
  checkCentreOfMass(packed, packedId, placements, spec, items, totalWeight, issues);
  checkAxles(packed, packedId, placements, spec, items, totalWeight, issues);
  packedId.verify();
}

/** One placement's own checks; records its envelope and returns its item type's spec. */
function checkPlacement(scope, placement) {
  const { packed, packedId, spec, items, clearance, envelopes, issues } = scope;
  const rawId = at(placement, 'item_id');
  const itemSpec = items.get(at(placement, 'item_type'));
  const envelope = envelopeOf(placement, clearance);
  envelopes.set(rawId, { envelope, placement, spec: itemSpec });
  const itemId = pyStr(rawId);
  if (!contains(scope.boundary, envelope)) issues.push(issue('outside_container', `${itemId} in ${packedId}`));
  for (const obstacle of spec.obstacles) {
    if (intersects(envelope, obstacle) && solidsOverlap(placedHull(envelope, placement, itemSpec), vertices(obstacle))) {
      issues.push(issue('obstacle_collision', `${itemId} in ${packedId}`));
    }
  }
  if (itemSpec === undefined) return undefined;
  checkRotation(placement, itemSpec, itemId, issues);
  if (itemSpec.eligibleContainerTags.size > 0 && !intersectsTags(itemSpec.eligibleContainerTags, spec.tags)) {
    const tags = listRepr(sortedTags(itemSpec.eligibleContainerTags).map(strRepr));
    issues.push(issue('container_ineligible', `${itemId}: ${pyStr(at(packed, 'container_type'))} has none of ${tags}`));
  }
  if (itemSpec.mustBeOnFloor && envelope.z !== 0n) issues.push(issue('floor_violation', `${itemId} at z=${envelope.z}`));
  return itemSpec;
}

function checkRotation(placement, spec, itemId, issues) {
  const orientation = at(placement, 'orientation');
  if (!isRotation(orientation)) {
    issues.push(issue('unknown_orientation', `${itemId}: ${pyStr(orientation)}`));
    return;
  }
  if (!allows(spec, orientation)) issues.push(issue('forbidden_rotation', `${itemId}: ${orientation}`));
  const expected = rotated(spec, orientation);
  const dimensions = at(placement, 'dimensions');
  const actual = SIDES.map((side) => at(at(dimensions, side), 'ticks'));
  if (!matchesInts(actual, expected)) {
    issues.push(issue('dimension_mismatch',
      `${itemId}: ${orientation} of ${intTuple(spec.dimensions)} is ${intTuple(expected)}, got ${valueTuple(actual)}`));
  }
}

/** Every pair once, in the reference's `combinations` order: collisions and incompatible tags. O(p^2). */
function checkPairs(entries, packedId, issues) {
  for (let first = 0; first < entries.length; first += 1) {
    const [leftId, left] = entries[first];
    for (let second = first + 1; second < entries.length; second += 1) {
      const [rightId, right] = entries[second];
      if (intersects(left.envelope, right.envelope)
        && !validNesting(left, right)
        && solidsOverlap(placedHull(left.envelope, left.placement, left.spec), placedHull(right.envelope, right.placement, right.spec))) {
        issues.push(issue('collision', `${pyStr(leftId)} with ${pyStr(rightId)} in ${packedId}`));
      }
      if (left.spec !== undefined && right.spec !== undefined
        && (intersectsTags(left.spec.incompatibleTags, right.spec.tags) || intersectsTags(right.spec.incompatibleTags, left.spec.tags))) {
        issues.push(issue('incompatible_items', `${pyStr(leftId)} is incompatible with ${pyStr(rightId)} in ${packedId}`));
      }
    }
  }
}

function checkLimits(packed, packedId, placements, spec, items, payload, issues) {
  if (spec.maxPayload !== null && payload > spec.maxPayload) {
    issues.push(issue('payload_exceeded', `${packedId}: ${payload} > ${spec.maxPayload} ticks`));
  }
  const reported = getNull(getOr(packed, 'payload_weight', {}), 'ticks');
  if (reported !== null && !pyEq(reported, payload)) {
    issues.push(issue('payload_weight_mismatch', `${packedId}: reported ${pyStr(reported)}, computed ${payload}`));
  }
  if (spec.maxItems !== null && BigInt(placements.length) > spec.maxItems) {
    issues.push(issue('max_items_exceeded', `${packedId}: ${placements.length} > ${spec.maxItems}`));
  }
  for (const [tag, limit] of spec.tagLimits) {
    const count = placements.filter((placement) => {
      const item = items.get(at(placement, 'item_type'));
      return item !== undefined && item.tags.has(tag);
    }).length;
    if (BigInt(count) > limit) issues.push(issue('tag_count_exceeded', `${packedId}: ${tag} count ${count} > limit ${limit}`));
  }
}

/** Python's `int(value) != computed` for a reported figure that is present. */
const differs = (reported, computed) => reported !== null && pyInt(reported, 'a reported volume') !== computed;

function checkVolumes(packed, packedId, placements, spec, items, envelopes, loads, issues) {
  const entries = envelopes.items();
  // Every placement counts, through the envelope its item id resolves to -- a repeated id
  // resolves to its last placement, as the reference's dict does.
  let used = placements.reduce((total, placement) => {
    const index = envelopes.position(at(placement, 'item_id'));
    return total + occupiedVolume(entries[index][1].envelope, placement, items.get(at(placement, 'item_type')), loads[index]);
  }, 0n);
  for (let first = 0; first < entries.length; first += 1) {
    const left = entries[first][1];
    if (left.spec === undefined || left.spec.nestingHeight === null) continue;
    for (let second = first + 1; second < entries.length; second += 1) {
      if (validNesting(left, entries[second][1])) used -= left.spec.nestingHeight * left.envelope.length * left.envelope.width;
    }
  }
  const reportedVolume = getNull(packed, 'used_volume_ticks3');
  if (differs(reportedVolume, used)) {
    issues.push(issue('used_volume_mismatch', `${packedId}: reported ${pyStr(reportedVolume)}, computed ${used}`));
  }
  const volume = volumeOf(spec);
  const scaledReserve = ratioPpm(spec.voidFillReserveRatio);
  const reserved = floorDiv(volume, SCORE_SCALE) * scaledReserve + floorDiv(pyMod(volume, SCORE_SCALE) * scaledReserve, SCORE_SCALE);
  const reportedReserve = getNull(packed, 'void_fill_reserve_ticks3');
  if (differs(reportedReserve, reserved)) {
    issues.push(issue('void_fill_reserve_mismatch', `${packedId}: reported ${pyStr(reportedReserve)}, computed ${reserved}`));
  } else if (reserved !== 0n && reportedReserve === null) {
    issues.push(issue('void_fill_reserve_mismatch', `${packedId}: non-zero reserve ${reserved} is not reported`));
  }
  if (used > volume - reserved) {
    issues.push(issue('void_fill_reserve_exceeded', `${packedId}: used ${used} > usable ${volume - reserved}`));
  }
}

/** `sum(weight * (2 * position + extent))` along one axis, over declared item types. */
function doubledMoment(placements, items, axis, side) {
  return placements.reduce((total, placement) => {
    const spec = items.get(at(placement, 'item_type'));
    if (spec === undefined) return total;
    const position = int(at(at(at(placement, 'position'), axis), 'ticks'), 'placement ticks');
    const extent = int(at(at(at(placement, 'dimensions'), side), 'ticks'), 'placement ticks');
    return total + spec.weight * (2n * position + extent);
  }, 0n);
}

function checkCentreOfMass(packed, packedId, placements, spec, items, totalWeight, issues) {
  let expected = 0n;
  if (totalWeight !== 0n) {
    const offset = (doubled, side) => floorDiv(abs(doubled - totalWeight * side) * SCORE_SCALE, totalWeight * side);
    expected = max(
      offset(doubledMoment(placements, items, 'x', 'length'), spec.inner[0]),
      offset(doubledMoment(placements, items, 'y', 'width'), spec.inner[1]),
    );
  }
  const reported = getNull(packed, 'centre_of_mass_offset_ppm');
  if (!pyEq(reported, expected)) {
    issues.push(issue('centre_of_mass_mismatch', `${packedId}: reported ${pyStr(reported)}, computed ${expected}`));
  }
}

function checkAxles(packed, packedId, placements, spec, items, totalWeight, issues) {
  if (spec.axles === null) {
    if (has(packed, 'axle_reactions')) {
      issues.push(issue('axle_reaction_mismatch', `${packedId}: reactions reported without configured axles`));
    }
    return;
  }
  if (spec.axles.length !== 2) throw shape(`${packedId}: axles must name exactly a front and a rear axle`);
  const [front, rear] = spec.axles;
  const denominator = 2n * (rear.position - front.position);
  const gross = spec.tareWeight + totalWeight;
  const doubledWeightedX = spec.tareWeight * spec.inner[0] + doubledMoment(placements, items, 'x', 'length');
  const frontNumerator = 2n * gross * rear.position - doubledWeightedX;
  const rearNumerator = doubledWeightedX - 2n * gross * front.position;
  const expected = {
    basis: 'gross',
    denominator: String(denominator),
    front_numerator: String(frontNumerator),
    rear_numerator: String(rearNumerator),
  };
  const reported = getNull(packed, 'axle_reactions');
  if (!pyEq(reported, expected)) {
    issues.push(issue('axle_reaction_mismatch', `${packedId}: reported ${pyStr(reported)}, computed ${pyRepr(expected)}`));
  }
  const over = (limit, numerator) => limit !== null && numerator > limit * denominator;
  if (over(front.maxLoad, frontNumerator) || over(rear.maxLoad, rearNumerator)) {
    issues.push(issue('axle_overloaded', String(packedId)));
  }
}
