/**
 * What rests on what, and everything that follows from it: support, top load, stacking limits,
 * load propagation, crush, stack density and route unloading order.
 *
 * Every function takes the container's placements as `entries`: `[itemId, {envelope,
 * placement, spec}]` pairs in the order of the reference's `envelopes` dict, where a repeated
 * item id keeps its first position and its last placement.
 */

import { cuboid, hullVolume, intersects, overlapAreaXY, rotateHull, vertices } from './geometry.js';
import { at, hashKey, int, pyCmp, pyEq, sortPy, text } from './json.js';
import { Ratio, ceilDiv, fixed6, floorDiv, max, ratioPpm } from './num.js';
import { issue, shape } from './outcome.js';
import { list, pyRepr, pyStr } from './pyfmt.js';
import { EXIT_DIRECTIONS, holds, rotated, rotationAxes } from './spec.js';
import { TICKS_PER_KG, TICKS_PER_MM } from './units.js';

/** One square metre in length ticks squared. */
export const SQUARE_METRE_TICKS = (TICKS_PER_MM * 1000n) ** 2n;

export const SCORE_SCALE = 1000000n;

/**
 * Exact direct-support edges, as `supporters[upper] = [[lower, area], ...]` and `directAbove[lower]
 * = Set(upper)` by entry index. Ordinary face contacts keep placement order; nested instances of
 * one column are linked only to their adjacent predecessor, which replaces any shadowed face
 * contact from the same column. O(n log n + q + e) time and O(n + e) space for `q` same-plane
 * candidates and `e` edges.
 */
export function supportGraph(entries) {
  const byTop = new Map();
  entries.forEach(([, entry], index) => {
    const tops = byTop.get(entry.envelope.z2);
    if (tops === undefined) byTop.set(entry.envelope.z2, [index]);
    else tops.push(index);
  });
  const supporters = entries.map(([, entry], upper) => (byTop.get(entry.envelope.z) || [])
    .filter((lower) => lower !== upper)
    .map((lower) => [lower, overlapAreaXY(entries[lower][1].envelope, entry.envelope)])
    .filter(([, area]) => area > 0n));
  linkNestedColumns(entries, supporters);
  const directAbove = entries.map(() => new Set());
  supporters.forEach((edges, upper) => edges.forEach(([lower]) => directAbove[lower].add(upper)));
  return { supporters, directAbove };
}

/** Each nested instance rests on its adjacent predecessor in the column, with its full base. */
function linkNestedColumns(entries, supporters) {
  const columnOf = new Map();
  const columns = new Map();
  entries.forEach(([, entry], index) => {
    const nesting = entry.spec === undefined ? null : entry.spec.nestingHeight;
    if (nesting === null) return;
    const { envelope } = entry;
    const key = [hashKey(at(entry.placement, 'item_type')), envelope.x, envelope.y, envelope.x2, envelope.y2, nesting].join('|');
    columnOf.set(index, key);
    const column = columns.get(key);
    if (column === undefined) columns.set(key, [index]);
    else column.push(index);
  });
  const predecessors = [];
  for (const column of columns.values()) {
    column.sort((left, right) => {
      const a = entries[left][1].envelope.z;
      const b = entries[right][1].envelope.z;
      return a < b ? -1 : a > b ? 1 : left - right;
    });
    for (let position = 1; position < column.length; position += 1) {
      const [lower, upper] = [column[position - 1], column[position]];
      if (entries[lower][1].envelope.z2 - entries[upper][1].envelope.z === entries[lower][1].spec.nestingHeight) {
        predecessors.push([upper, lower]);
      }
    }
  }
  for (const [upper, lower] of predecessors) {
    const key = columnOf.get(upper);
    const edges = supporters[upper].filter(([candidate]) => columnOf.get(candidate) !== key);
    const position = edges.findIndex(([candidate]) => candidate > lower);
    edges.splice(position === -1 ? edges.length : position, 0, [lower, entries[upper][1].envelope.baseArea]);
    supporters[upper] = edges;
  }
}

/** Exact `floor(base_area * ppm / 10^6)`, the least supported area the ratio allows. */
const requiredSupportArea = (baseArea, ppm) => floorDiv(baseArea * ppm, SCORE_SCALE);

export function checkSupportAndLoad(entries, graph, globalSupport, issues) {
  entries.forEach(([rawId, entry], index) => {
    const { spec, envelope } = entry;
    if (spec === undefined || envelope.z === 0n) return;
    const itemId = pyStr(rawId);
    const supporting = graph.supporters[index];
    const required = globalSupport.compare(spec.minimumSupportRatio) < 0 ? spec.minimumSupportRatio : globalSupport;
    checkGroundContact(itemId, envelope, supporting, entries, spec.groundContactRule, issues);
    if (required.compare(Ratio.of(0n)) > 0) {
      const area = supporting.reduce((total, [, contact]) => total + contact, 0n);
      if (area < requiredSupportArea(envelope.baseArea, ratioPpm(required))) {
        const ratio = new Ratio(area, envelope.baseArea);
        issues.push(issue('insufficient_support',
          `${itemId}: ${fixed6(ratio.toDouble())} < ${fixed6(required.toDouble())}`));
      }
    }
    for (const [lower] of supporting) checkResting(itemId, spec, entries[lower], issues);
  });
  entries.forEach(([rawId, entry], index) => {
    const limit = entry.spec === undefined ? null : entry.spec.maxStackedItems;
    if (limit === null) return;
    const above = countAbove(index, graph.directAbove);
    if (BigInt(above) > limit) {
      issues.push(issue('max_stacked_items_exceeded', `${pyStr(rawId)}: ${above} above > limit ${limit}`));
    }
  });
}

/** What one direct supporter allows to rest on it. */
function checkResting(itemId, spec, [lowerId, lowerEntry], issues) {
  const lowerSpec = lowerEntry.spec;
  if (lowerSpec === undefined) return;
  const lower = pyStr(lowerId);
  if (!lowerSpec.stackable) {
    issues.push(issue('non_stackable', `${itemId} rests on ${lower}`));
  } else if (lowerSpec.acceptsStackingGroups.size > 0 && !holds(lowerSpec.acceptsStackingGroups, spec.stackingGroup)) {
    issues.push(issue('stacking_group_incompatible', `${itemId} rests on ${lower}`));
  }
  if (lowerSpec.maxTopLoad !== null && spec.weight > lowerSpec.maxTopLoad) {
    issues.push(issue('top_load_exceeded', `${itemId} (${spec.weight} ticks) on ${lower} (limit ${lowerSpec.maxTopLoad})`));
  }
}

/** Everything resting on an item, however indirectly. */
function countAbove(index, directAbove) {
  const descendants = new Set();
  const pending = Array.from(directAbove[index]);
  while (pending.length > 0) {
    const above = pending.pop();
    if (descendants.has(above)) continue;
    descendants.add(above);
    pending.push(...directAbove[above]);
  }
  return descendants.size;
}

function checkGroundContact(itemId, envelope, supporting, entries, rule, issues) {
  if (rule === null || rule === 'free') return;
  if (rule === 'covered') {
    const corners = [[envelope.x, envelope.y], [envelope.x2, envelope.y], [envelope.x, envelope.y2], [envelope.x2, envelope.y2]];
    const covered = corners.every(([x, y]) => supporting.some(([lower]) => {
      const surface = entries[lower][1].envelope;
      return surface.x <= x && x <= surface.x2 && surface.y <= y && y <= surface.y2;
    }));
    if (!covered) issues.push(issue('ground_contact_violation', `${itemId}: covered requires all four base corners`));
  } else if (rule === 'single' && supporting.length !== 1) {
    issues.push(issue('ground_contact_violation', `${itemId}: single has ${supporting.length} supporters`));
  } else if (rule === 'multiple' && supporting.length < 2) {
    issues.push(issue('ground_contact_violation', `${itemId}: multiple has ${supporting.length} supporters`));
  }
}

/**
 * Cumulative weight each item bears from everything resting on it, split across supporters by
 * contact area and conserved exactly (the remainder goes to the last supporter), top-down by
 * descending envelope ceiling. O(n log n + e).
 */
export function propagateLoad(entries, graph) {
  const order = entries.map((_, index) => index).sort((left, right) => {
    const a = entries[left][1].envelope;
    const b = entries[right][1].envelope;
    if (a.z2 !== b.z2) return a.z2 > b.z2 ? -1 : 1;
    if (a.z !== b.z) return a.z > b.z ? -1 : 1;
    return pyCmp(entries[left][0], entries[right][0]);
  });
  const loads = entries.map(() => 0n);
  for (const upper of order) {
    const { spec } = entries[upper][1];
    if (spec === undefined) continue;
    const supports = graph.supporters[upper];
    const totalArea = supports.reduce((total, [, area]) => total + area, 0n);
    if (totalArea === 0n) continue;
    const downward = spec.weight + loads[upper];
    let assigned = 0n;
    supports.forEach(([lower, area], position) => {
      const share = position === supports.length - 1 ? downward - assigned : floorDiv(downward * area, totalArea);
      assigned += share;
      loads[lower] += share;
    });
  }
  return loads;
}

/** The pressure a footprint carries, in kPa, exactly: `load * g * (ticks/m)^2 / (ticks/kg * Pa/kPa * area)`. */
function pressure(load, baseArea) {
  return new Ratio(load * 980665n * SQUARE_METRE_TICKS, TICKS_PER_KG * 100000n * 1000n * baseArea);
}

/**: no `compressible` item may carry more pressure than it declared. */
export function checkCrush(packedId, entries, loads, issues) {
  entries.forEach(([rawId, entry], index) => {
    const limit = entry.spec === undefined ? null : entry.spec.maxCompressionPressureKpa;
    if (limit === null) return;
    const carried = pressure(loads[index], entry.envelope.baseArea);
    if (carried.compare(Ratio.of(limit)) > 0) {
      issues.push(issue('crush_violation',
        `${pyStr(rawId)} in ${packedId}: ${fixed6(carried.toDouble())} kPa exceeds ${limit} kPa`));
    }
  });
}

/** Occupied height under load, rounded up, never below one tick; a crushed item keeps its height. */
function compressedHeight(envelope, spec, load) {
  const limit = spec.maxCompressionPressureKpa;
  // The reference asserts the pair: a pressure limit without a ratio is not a request it reads.
  if (spec.compressionRatioPpm === null) throw shape(`${spec.id}: max_compression_pressure_kpa without compression_ratio`);
  const carried = pressure(load, envelope.baseArea);
  if (carried.compare(Ratio.of(limit)) > 0 || limit === 0n) return envelope.height;
  const divisor = limit * 1000000n * carried.denominator;
  const retained = divisor - spec.compressionRatioPpm * carried.numerator;
  return max(1n, ceilDiv(envelope.height * retained, divisor));
}

/**: weight per square metre of an item's own base, at every level of the stack. */
export function checkStackDensity(packedId, entries, loads, maxDensity, issues) {
  entries.forEach(([rawId, entry], index) => {
    if (entry.spec === undefined) return;
    const total = entry.spec.weight + loads[index];
    if (total * SQUARE_METRE_TICKS > maxDensity * entry.envelope.baseArea) {
      issues.push(issue('stack_density_exceeded', `${pyStr(rawId)} in ${packedId}: ${total} ticks over `
        + `${entry.envelope.baseArea} ticks^2 exceeds ${maxDensity} ticks/m^2`));
    }
  });
}

/** The region between the envelope's own face and the matching container wall along `direction`. */
function sweptRegion(envelope, container, direction) {
  let [x1, y1, z1, x2, y2, z2] = [envelope.x, envelope.y, envelope.z, envelope.x2, envelope.y2, envelope.z2];
  if (direction === '+x') [x1, x2] = [x2, container[0]];
  else if (direction === '-x') [x1, x2] = [0n, x1];
  else if (direction === '+y') [y1, y2] = [y2, container[1]];
  else if (direction === '-y') [y1, y2] = [0n, y1];
  else if (direction === '+z') [z1, z2] = [z2, container[2]];
  else [z1, z2] = [0n, z1];
  return cuboid(x1, y1, z1, x2 - x1, y2 - y1, z2 - z1);
}

function setSome(set, predicate) {
  for (const item of set) {
    if (predicate(item)) return true;
  }
  return false;
}

function hasClearExit(item, entries, present, container, directions) {
  return directions.some((direction) => {
    const region = sweptRegion(entries[item][1].envelope, container, direction);
    return !setSome(present, (other) => other !== item && intersects(region, entries[other][1].envelope));
  });
}

/** `min(candidates)` by item id, the first of equals. */
function lowestId(candidates, entries) {
  return candidates.reduce((best, candidate) => (pyCmp(entries[candidate][0], entries[best][0]) < 0 ? candidate : best));
}

/**
 * Items due at an earlier stop must all be removable -- unblocked from
 * above and slidable out a door (all six walls when the container names none) -- before the
 * route moves on. O(s * n^2) for `s` stops: each removal rescans the items still due.
 */
export function checkRouteRemovalOrder(packedId, entries, graph, container, doors, issues) {
  const stops = [];
  entries.forEach(([, entry], index) => {
    if (entry.spec !== undefined && entry.spec.stopIndex !== null) stops.push([index, entry.spec.stopIndex]);
  });
  if (stops.length === 0) return;
  const directions = doors.length === 0 ? EXIT_DIRECTIONS : doors;
  const present = new Set(entries.map((_, index) => index));
  const distinct = Array.from(new Set(stops.map(([, stop]) => stop))).sort((a, b) => (a < b ? -1 : 1));
  for (const stop of distinct) {
    let due = stops.filter(([index, value]) => value === stop && present.has(index)).map(([index]) => index);
    while (due.length > 0) {
      const removable = due.filter((item) => !setSome(graph.directAbove[item], (above) => present.has(above))
        && hasClearExit(item, entries, present, container, directions));
      if (removable.length === 0) {
        const names = sortPy(due.map((index) => entries[index][0])).map(pyRepr);
        issues.push(issue('unloading_order_violation',
          `${packedId}: stop ${stop} cannot fully unload ${list(names)} before the route moves on`));
        return;
      }
      const chosen = lowestId(removable, entries);
      present.delete(chosen);
      due = due.filter((item) => item !== chosen);
    }
  }
}

/**
 * Whether two stacked instances form a valid nested column: same type and footprint, and the
 * upper one sunk into the lower one by exactly the nesting height.
 */
export function validNesting(left, right) {
  if (left.spec === undefined || right.spec === undefined) return false;
  const nesting = left.spec.nestingHeight;
  if (nesting === null || left.spec.id !== right.spec.id
    || !pyEq(at(left.placement, 'item_type'), at(right.placement, 'item_type'))
    || right.spec.nestingHeight !== nesting) return false;
  const [a, b] = [left.envelope, right.envelope];
  if (a.x !== b.x || a.y !== b.y || a.x2 !== b.x2 || a.y2 !== b.y2) return false;
  const [lower, upper] = a.z <= b.z ? [a, b] : [b, a];
  return lower.z !== upper.z && lower.z2 - upper.z === nesting;
}

const orientationAxes = (placement) => rotationAxes(text(at(placement, 'orientation'), 'orientation'));

/**
 * The solid a placement occupies, as vertices in container coordinates: the exact hull when the
 * request allows it and the reported box matches, otherwise the envelope's corners.
 */
export function placedHull(envelope, placement, spec) {
  if (spec === undefined || spec.hullVertices === null || spec.shapeType !== 'convex_hull' || spec.stopIndex !== null) {
    return vertices(envelope);
  }
  const expected = rotated(spec, text(at(placement, 'orientation'), 'orientation'));
  if (envelope.length !== expected[0] || envelope.width !== expected[1] || envelope.height !== expected[2]) {
    return vertices(envelope);
  }
  return rotateHull(spec.hullVertices, orientationAxes(placement))
    .map(([x, y, z]) => [envelope.x + x, envelope.y + y, envelope.z + z]);
}

/** Space a placement actually takes: its compressed box, its hull, or its box. */
export function occupiedVolume(envelope, placement, spec, load) {
  if (spec !== undefined && spec.maxCompressionPressureKpa !== null) {
    return envelope.baseArea * compressedHeight(envelope, spec, load);
  }
  if (spec !== undefined && spec.shapeType === 'convex_hull' && spec.hullVertices !== null) {
    return hullVolume(rotateHull(spec.hullVertices, orientationAxes(placement)));
  }
  // Only an exact hull makes `_placed_hull` differ from the envelope's corners, and a hull was
  // answered above, so the reference's remaining `_hull_volume(solid)` arm is never reached.
  const dimensions = at(placement, 'dimensions');
  const side = (name) => int(at(at(dimensions, name), 'ticks'), 'a placement dimension');
  return side('length') * side('width') * side('height');
}
