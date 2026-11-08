/**
 * Boxes and convex hulls in ticks, written the slow, obvious way the reference writes them: a
 * validator that took the engine's shortcuts would stop being a second opinion.
 */

import { abs, gcd, max, min } from './num.js';
import { shape } from './outcome.js';

/**
 * Each of the 24 proper rotations in canonical table order (1.10): the code, the declared side
 * (length 0, width 1, height 2) each container axis takes its extent from, and the sign it
 * carries. Written out rather than derived, so the table is a second statement of the contract
 * and not a copy of an engine's. The legacy codes negate x exactly when their permutation is odd.
 */
export const ROTATIONS = Object.freeze([
  ['LWH', [0, 1, 2], [1n, 1n, 1n]], ['LHW', [0, 2, 1], [-1n, 1n, 1n]], ['WLH', [1, 0, 2], [-1n, 1n, 1n]],
  ['WHL', [1, 2, 0], [1n, 1n, 1n]], ['HLW', [2, 0, 1], [1n, 1n, 1n]], ['HWL', [2, 1, 0], [-1n, 1n, 1n]],
  ['+L-W-H', [0, 1, 2], [1n, -1n, -1n]], ['-L+W-H', [0, 1, 2], [-1n, 1n, -1n]], ['-L-W+H', [0, 1, 2], [-1n, -1n, 1n]],
  ['+L-H+W', [0, 2, 1], [1n, -1n, 1n]], ['+L+H-W', [0, 2, 1], [1n, 1n, -1n]], ['-L-H-W', [0, 2, 1], [-1n, -1n, -1n]],
  ['+W-L+H', [1, 0, 2], [1n, -1n, 1n]], ['+W+L-H', [1, 0, 2], [1n, 1n, -1n]], ['-W-L-H', [1, 0, 2], [-1n, -1n, -1n]],
  ['+W-H-L', [1, 2, 0], [1n, -1n, -1n]], ['-W+H-L', [1, 2, 0], [-1n, 1n, -1n]], ['-W-H+L', [1, 2, 0], [-1n, -1n, 1n]],
  ['+H-L-W', [2, 0, 1], [1n, -1n, -1n]], ['-H+L-W', [2, 0, 1], [-1n, 1n, -1n]], ['-H-L+W', [2, 0, 1], [-1n, -1n, 1n]],
  ['+H-W+L', [2, 1, 0], [1n, -1n, 1n]], ['+H+W-L', [2, 1, 0], [1n, 1n, -1n]], ['-H-W-L', [2, 1, 0], [-1n, -1n, -1n]],
]);

/** The six legacy codes: every box a cuboid can make, and an item's default list. */
export const BOX_ROTATIONS = Object.freeze(ROTATIONS.slice(0, 6).map(([name]) => name));

/** The codes that keep the item's own height vertical and pointing up: z takes `+H`. */
export const UPRIGHT_ROTATIONS = Object.freeze(ROTATIONS
  .filter(([, axes, signs]) => axes[2] === 2 && signs[2] === 1n).map(([name]) => name));

/** An axis-aligned box; its far corner and base area are computed once. */
export function cuboid(x, y, z, length, width, height) {
  return Object.freeze({
    x, y, z, length, width, height,
    x2: x + length, y2: y + width, z2: z + height, baseArea: length * width,
  });
}

export const intersects = (a, b) => a.x < b.x2 && b.x < a.x2 && a.y < b.y2 && b.y < a.y2 && a.z < b.z2 && b.z < a.z2;

export const contains = (outer, inner) => outer.x <= inner.x && outer.y <= inner.y && outer.z <= inner.z
  && inner.x2 <= outer.x2 && inner.y2 <= outer.y2 && inner.z2 <= outer.z2;

export function overlapAreaXY(a, b) {
  const dx = max(0n, min(a.x2, b.x2) - max(a.x, b.x));
  const dy = max(0n, min(a.y2, b.y2) - max(a.y, b.y));
  return dx * dy;
}

/** The eight corners, in the reference's `dx, dy, dz` order. */
export function vertices(box) {
  const corners = [];
  for (const x of [box.x, box.x2]) {
    for (const y of [box.y, box.y2]) {
      for (const z of [box.z, box.z2]) corners.push([x, y, z]);
    }
  }
  return corners;
}

const difference = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** -1, 0 or 1 by Python's tuple order. */
function compareVertices(a, b) {
  for (let axis = 0; axis < 3; axis += 1) {
    if (a[axis] !== b[axis]) return a[axis] < b[axis] ? -1 : 1;
  }
  return 0;
}

/** The axis reduced by its gcd and signed so its first non-zero component is positive. */
function primitiveAxis(axis) {
  const divisor = gcd(gcd(abs(axis[0]), abs(axis[1])), abs(axis[2]));
  if (divisor === 0n) return [0n, 0n, 0n];
  const reduced = axis.map((value) => value / divisor);
  const first = reduced.find((value) => value !== 0n);
  return first < 0n ? reduced.map((value) => -value) : reduced;
}

/**
 * Reorient a hull by one of the 24 proper rotations, `v'[i] = s[i] * v[src[i]]` from the row
 * `ROTATIONS` gives the code `orientation`, then translated so its bounds start at 0. Every code has
 * determinant +1, so the result is never the item's mirror image.
 */
export function rotateHull(points, orientation) {
  const row = ROTATIONS.find(([name]) => name === orientation);
  if (row === undefined) throw shape(`unknown orientation ${JSON.stringify(orientation)}`);
  const [, axes, signs] = row;
  if (points.length === 0) throw shape('min() of an empty hull');
  const turned = points.map((vertex) => [0, 1, 2].map((axis) => signs[axis] * vertex[axes[axis]]));
  const low = [0, 1, 2].map((axis) => turned.reduce((least, vertex) => min(least, vertex[axis]), turned[0][axis]));
  return turned.map((vertex) => difference(vertex, low));
}

/** Every 3-combination of `points`, in `itertools.combinations` order. */
function* triples(points) {
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      for (let third = second + 1; third < points.length; third += 1) {
        yield [points[first], points[second], points[third]];
      }
    }
  }
}

function pairDirections(points) {
  const directions = [];
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      directions.push(difference(points[second], points[first]));
    }
  }
  return directions;
}

/** A set of axes keyed by their components, in insertion order. */
function addAxis(axes, axis) {
  axes.set(axis.join(','), axis);
}

/**
 * The complete separating-axis superset: every face normal of each hull and every cross product
 * of an edge direction from one with one from the other.
 */
function hullAxes(left, right) {
  const axes = new Map();
  for (const hull of [left, right]) {
    for (const [first, second, third] of triples(hull)) {
      addAxis(axes, primitiveAxis(cross(difference(second, first), difference(third, first))));
    }
  }
  const rightDirections = pairDirections(right);
  for (const one of pairDirections(left)) {
    for (const other of rightDirections) addAxis(axes, primitiveAxis(cross(one, other)));
  }
  axes.delete('0,0,0');
  return axes.values();
}

function extent(points, axis) {
  let low = dot(points[0], axis);
  let high = low;
  for (const point of points) {
    const value = dot(point, axis);
    low = min(low, value);
    high = max(high, value);
  }
  return [low, high];
}

/** Whether two convex solids share interior volume. Touching is contact, not collision. */
export function solidsOverlap(left, right) {
  for (const axis of hullAxes(left, right)) {
    const [leftLow, leftHigh] = extent(left, axis);
    const [rightLow, rightHigh] = extent(right, axis);
    if (leftHigh <= rightLow || rightHigh <= leftLow) return false;
  }
  return true;
}

/**
 * Corners of one planar convex face in cyclic order seen from outside, by gift-wrapping from the
 * lexicographically smallest vertex; collinear candidates resolve to the farthest.
 */
function windFace(face, outward) {
  const start = face.reduce((least, vertex) => (compareVertices(vertex, least) < 0 ? vertex : least));
  const ordered = [start];
  let current = start;
  for (let step = 0; step < face.length; step += 1) {
    let following = null;
    for (const candidate of face) {
      if (compareVertices(candidate, current) === 0) continue;
      if (following === null) {
        following = candidate;
        continue;
      }
      const turn = dot(cross(difference(following, current), difference(candidate, current)), outward);
      const reach = dot(difference(candidate, current), difference(candidate, current));
      const held = dot(difference(following, current), difference(following, current));
      if (turn < 0n || (turn === 0n && reach > held)) following = candidate;
    }
    if (following === null || compareVertices(following, start) === 0) break;
    ordered.push(following);
    current = following;
  }
  return ordered;
}

/** Exact volume of a convex hull, `6V = sum of a . (b x c)` over its outward faces. */
export function hullVolume(points) {
  const normals = new Map();
  for (const [first, second, third] of triples(points)) {
    const axis = primitiveAxis(cross(difference(second, first), difference(third, first)));
    if (axis.some((value) => value !== 0n)) addAxis(normals, axis);
  }
  let sixVolumes = 0n;
  for (const axis of normals.values()) {
    for (const outward of [axis, axis.map((value) => -value)]) {
      const [, highest] = extent(points, outward);
      const face = points.filter((vertex) => dot(vertex, outward) === highest);
      if (face.length < 3) continue;
      const ordered = windFace(face, outward);
      for (let index = 1; index + 1 < ordered.length; index += 1) {
        sixVolumes += dot(ordered[0], cross(ordered[index], ordered[index + 1]));
      }
    }
  }
  return abs(sixVolumes) / 6n;
}
