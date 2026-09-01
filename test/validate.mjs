/**
 * An independent check of a packing result.
 *
 * It shares no code with the solver: everything is re-derived from the reported
 * placements and the original request, so a result that claims to honour a rule it
 * ignored is caught here. This is the JavaScript counterpart of
 * the independent cross-language reference validator; the codes it returns are the
 * same contract.
 * See docs/VALIDATION-CONTRACT.md.
 */

const SCORE_SCALE = 1_000_000n;

const ticks = (measure) => measure.ticks;
const size = (dimensions) => [ticks(dimensions.length), ticks(dimensions.width), ticks(dimensions.height)];
const corner = (position) => [ticks(position.x), ticks(position.y), ticks(position.z)];

const volume = ([length, width, height]) => BigInt(length) * BigInt(width) * BigInt(height);
const LENGTH_TICKS = {mm:16000,cm:160000,m:16000000,in:406400,ft:4876800,tick:1,ticks:1};
const WEIGHT_TICKS = {mg:8000,g:8000000,kg:8000000000,oz:226796185,lb:3628738960};

function requestLengthTicks(measure, defaultUnit) {
  const raw = measure && typeof measure === 'object' ? measure.value : measure;
  const unit = measure && typeof measure === 'object' ? (measure.unit ?? defaultUnit) : defaultUnit;
  return Math.round(Number(raw) * LENGTH_TICKS[unit]);
}

/** A request weight in ticks, defaulting to grams the way the schema does. */
function requestWeightTicks(measure) {
  const raw = measure && typeof measure === 'object' ? measure.value : measure;
  const unit = measure && typeof measure === 'object' ? (measure.unit ?? 'g') : 'g';
  return Math.round(Number(raw ?? 0) * WEIGHT_TICKS[unit]);
}

function overlaps(one, other) {
  return one.at.every((start, axis) =>
    start < other.at[axis] + other.size[axis] && start + one.size[axis] > other.at[axis]);
}

function validNesting(one, other, itemsById, lengthUnit) {
  if (one.type !== other.type) return false;
  const nesting = itemsById.get(one.type)?.nesting_height;
  if (nesting == null) return false;
  if (one.at[0] !== other.at[0] || one.at[1] !== other.at[1]
    || one.at[0] + one.size[0] !== other.at[0] + other.size[0]
    || one.at[1] + one.size[1] !== other.at[1] + other.size[1]) return false;
  const [lower, upper] = one.at[2] <= other.at[2] ? [one, other] : [other, one];
  return lower.at[2] !== upper.at[2]
    && lower.at[2] + lower.size[2] - upper.at[2] === requestLengthTicks(nesting, lengthUnit);
}

function boxesOf(container, latticeSequences = new Map()) {
  const boxes = container.placements.map((placement) => ({
    id: placement.item_id,
    type: placement.item_type,
    at: corner(placement.position),
    size: size(placement.dimensions),
    orientation: placement.orientation,
  }));
  const summary = container.lattice_summary;
  if (summary == null) return boxes;
  const physical = size(summary.physical_dimensions);
  const envelope = size(summary.envelope_dimensions);
  const clearance = physical.map((edge, axis) => (envelope[axis] - edge) / 2);
  let sequence = latticeSequences.get(summary.item_type) ?? 0;
  for (let index = 0; index < summary.count; index++) {
    const x = index % summary.nx;
    const y = Math.floor(index / summary.nx) % summary.ny;
    const z = Math.floor(index / (summary.nx * summary.ny));
    sequence++;
    boxes.push({
      id: `${summary.item_type}#${sequence}`,
      type: summary.item_type,
      orientation: summary.orientation,
      at: [
        x * envelope[0] + clearance[0],
        y * envelope[1] + clearance[1],
        z * ticks(summary.layer_step) + clearance[2],
      ],
      size: physical,
    });
  }
  latticeSequences.set(summary.item_type, sequence);
  return boxes;
}

/**
 * @returns {string[]} one code per violation, empty when the result is sound.
 */

// ---------------------------------------------------------------- irregular geometry
//
// The engine's counterpart of this file must not be imported: an independent recompute is the
// whole point, so the separating-axis rule and the pressure model are written here from
// docs/IRREGULAR-ITEMS.md. Every product is a `BigInt` -- a projection reaches 2.4e25 while a
// JavaScript number is exact only to 2^53.
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vkey = (v) => `${v[0]},${v[1]},${v[2]}`;
const vcompare = (left, right) => {
  for (let axis = 0; axis < 3; axis++) {
    if (left[axis] < right[axis]) return -1;
    if (left[axis] > right[axis]) return 1;
  }
  return 0;
};
function vgcd(a, b) { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) { const t = a % b; a = b; b = t; } return a; }
function vprimitive(v) {
  const g = vgcd(vgcd(v[0], v[1]), v[2]);
  if (g === 0n) return null;
  const r = [v[0] / g, v[1] / g, v[2] / g];
  const lead = r.find((x) => x !== 0n);
  return lead > 0n ? r : [-r[0], -r[1], -r[2]];
}
/** The rotation applied to a hull, as a proper rotation: three of the six orientations are odd
 *  permutations, and a bare permutation would return the item's mirror image. */
function rotateHull(vertices, orientation) {
  const axes = { LWH: [0, 1, 2], LHW: [0, 2, 1], WLH: [1, 0, 2], WHL: [1, 2, 0], HLW: [2, 0, 1], HWL: [2, 1, 0] }[orientation];
  let inversions = 0;
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) if (axes[i] > axes[j]) inversions++;
  const sign = inversions % 2 ? -1n : 1n;
  const turned = vertices.map((v) => [sign * v[axes[0]], v[axes[1]], v[axes[2]]]);
  const low = [0, 1, 2].map((a) => turned.reduce((m, v) => (v[a] < m ? v[a] : m), turned[0][a]));
  return turned.map((v) => [v[0] - low[0], v[1] - low[1], v[2] - low[2]]);
}
/** The solid a placement occupies, in container coordinates: its hull, or its eight box
 *  corners. Collision replay can deliberately request the route-safe box fallback; physical
 *  volume never does, because a route changes reachability rather than the authored solid. */
function solidOf(box, item, lengthUnit, collisionReplay = true) {
  const corners = [];
  for (const x of [0n, BigInt(box.size[0])]) for (const y of [0n, BigInt(box.size[1])]) for (const z of [0n, BigInt(box.size[2])]) {
    corners.push([BigInt(box.at[0]) + x, BigInt(box.at[1]) + y, BigInt(box.at[2]) + z]);
  }
  if (item?.shape_type !== 'convex_hull'
    || (collisionReplay && item.stop_index != null)
    || item.hull_vertices == null) return corners;
  const local = item.hull_vertices.map((v) => [
    BigInt(requestLengthTicks(v.x, lengthUnit)),
    BigInt(requestLengthTicks(v.y, lengthUnit)),
    BigInt(requestLengthTicks(v.z, lengthUnit)),
  ]);
  return rotateHull(local, box.orientation).map((v) =>
    [v[0] + BigInt(box.at[0]), v[1] + BigInt(box.at[1]), v[2] + BigInt(box.at[2])]);
}
/** Whether two convex solids share interior volume. Touching is contact, not collision. */
function solidsOverlap(left, right) {
  const axes = new Map();
  for (const hull of [left, right]) {
    for (let i = 0; i < hull.length; i++) for (let j = i + 1; j < hull.length; j++) for (let k = j + 1; k < hull.length; k++) {
      const axis = vprimitive(vcross(vsub(hull[j], hull[i]), vsub(hull[k], hull[i])));
      if (axis) axes.set(vkey(axis), axis);
    }
  }
  const directions = (hull) => {
    const out = [];
    for (let i = 0; i < hull.length; i++) for (let j = i + 1; j < hull.length; j++) out.push(vsub(hull[j], hull[i]));
    return out;
  };
  for (const a of directions(left)) for (const b of directions(right)) {
    const axis = vprimitive(vcross(a, b));
    if (axis) axes.set(vkey(axis), axis);
  }
  for (const axis of axes.values()) {
    const span = (hull) => hull.reduce((acc, v) => {
      const value = vdot(v, axis);
      return [value < acc[0] ? value : acc[0], value > acc[1] ? value : acc[1]];
    }, [vdot(hull[0], axis), vdot(hull[0], axis)]);
    const [ll, lh] = span(left); const [rl, rh] = span(right);
    if (lh <= rl || rh <= ll) return false;
  }
  return true;
}
/** Occupied volume: the hull's own, or the compressed box, or the box. */
function occupiedVolumeOf(box, item, lengthUnit, loadTicks) {
  if (item?.shape_type === 'convex_hull' && item.hull_vertices != null) {
    const solid = solidOf(box, item, lengthUnit, false);
    let six = 0n;
    const axes = new Map();
    for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) for (let k = j + 1; k < solid.length; k++) {
      const axis = vprimitive(vcross(vsub(solid[j], solid[i]), vsub(solid[k], solid[i])));
      if (!axis) continue;
      const offset = vdot(solid[i], axis);
      const sides = solid.map((v) => vdot(v, axis) - offset);
      if (sides.every((x) => x <= 0n) || sides.every((x) => x >= 0n)) axes.set(vkey(axis), axis);
    }
    for (const axis of axes.values()) for (const outward of [axis, [-axis[0], -axis[1], -axis[2]]]) {
      const extreme = solid.reduce((m, v) => { const value = vdot(v, outward); return value > m ? value : m; }, vdot(solid[0], outward));
      const face = solid.filter((v) => vdot(v, outward) === extreme);
      if (face.length < 3) continue;
      const sorted = [...face].sort(vcompare);
      const ordered = [sorted[0]]; let current = sorted[0];
      for (let step = 0; step < sorted.length; step++) {
        let next = null;
        for (const candidate of sorted) {
          if (vkey(candidate) === vkey(current)) continue;
          if (next === null) { next = candidate; continue; }
          const turn = vdot(vcross(vsub(next, current), vsub(candidate, current)), outward);
          const reach = vdot(vsub(candidate, current), vsub(candidate, current));
          const held = vdot(vsub(next, current), vsub(next, current));
          if (turn < 0n || (turn === 0n && reach > held)) next = candidate;
        }
        if (next === null || vkey(next) === vkey(sorted[0])) break;
        ordered.push(next); current = next;
      }
      for (let i = 1; i + 1 < ordered.length; i++) six += vdot(ordered[0], vcross(ordered[i], ordered[i + 1]));
    }
    const magnitude = six < 0n ? -six : six;
    return magnitude / 6n;
  }
  if (item?.max_compression_pressure_kpa == null) return volume(box.size);
  const footprint = BigInt(box.size[0]) * BigInt(box.size[1]);
  const metre = 16000n * 1000n;
  const numerator = BigInt(loadTicks) * 980665n * metre * metre;
  const denominator = 8000000000n * 100000n * 1000n * footprint;
  const g = vgcd(numerator, denominator) || 1n;
  const pressure = { n: numerator / g, d: denominator / g };
  const limit = BigInt(item.max_compression_pressure_kpa);
  if (pressure.n > limit * pressure.d) return volume(box.size);
  if (limit === 0n) return volume(box.size);
  const ratioPpm = BigInt(Math.floor(item.compression_ratio * 1000000 + 0.5));
  const divisor = limit * 1000000n * pressure.d;
  const retained = divisor - ratioPpm * pressure.n;
  const height = (BigInt(box.size[2]) * retained + divisor - 1n) / divisor;
  return footprint * (height > 1n ? height : 1n);
}

export function validate(request, result) {
  const issues = [];
  const itemsById = new Map(request.items.map((item) => [item.id, item]));
  const containersById = new Map(request.containers.map((container) => [container.id, container]));
  const lengthUnit = request.units?.length ?? 'mm';

  const seen = new Set();
  const inventory = new Map();
  const groupHomes = new Map();
  const latticeSequences = new Map();

  for (const container of result.containers) {
    const template = containersById.get(container.container_type);
    if (!template) {
      issues.push('unknown_container');
      continue;
    }
    inventory.set(container.container_type, (inventory.get(container.container_type) ?? 0) + 1);

    const inner = size(container.inner_dimensions);
    const boxes = boxesOf(container, latticeSequences);

    if (template.max_items != null && boxes.length > template.max_items) issues.push('max_items_exceeded');

    boxes.forEach((box, index) => {
      if (seen.has(box.id)) issues.push('duplicate_item');
      seen.add(box.id);

      const item = itemsById.get(box.type);
      if (!item) {
        issues.push('unknown_item');
        return;
      }
      if (box.at.some((start, axis) => start < 0 || start + box.size[axis] > inner[axis])) {
        issues.push('outside_container');
      }
      if (item.must_be_on_floor && box.at[2] !== 0) issues.push('must_be_on_floor');
      if (item.group != null) {
        groupHomes.set(item.group, (groupHomes.get(item.group) ?? new Set()).add(container.id));
      }

      for (const other of boxes.slice(index + 1)) {
        // The axis-aligned test is the broad phase; the exact test refines it only when a hull
        // is one of the two solids, so an ordinary box pair reaches the same verdict it always
        // did.
        if (overlaps(box, other) && !validNesting(box, other, itemsById, lengthUnit)
          && solidsOverlap(solidOf(box, item, lengthUnit),
            solidOf(other, itemsById.get(other.type), lengthUnit))) {
          issues.push('collision');
        }
      }

      // Stacking is a relation, not a direction: check both who rests on whom.
      for (const other of boxes) {
        if (other === box) continue;
        const sharesFootprint = [0, 1].every((axis) =>
          box.at[axis] < other.at[axis] + other.size[axis] && box.at[axis] + box.size[axis] > other.at[axis]);
        if (!sharesFootprint) continue;
        const otherItem = itemsById.get(other.type);
        if (other.at[2] + other.size[2] === box.at[2] && otherItem?.stackable === false) {
          issues.push('non_stackable');
        }
      }

      const incompatible = new Set(item.incompatible_tags ?? []);
      for (const other of boxes) {
        if (other === box) continue;
        const otherItem = itemsById.get(other.type);
        const otherTags = otherItem?.tags ?? [];
        const otherIncompatible = otherItem?.incompatible_tags ?? [];
        if (otherTags.some((tag) => incompatible.has(tag))
          || (item.tags ?? []).some((tag) => otherIncompatible.includes(tag))) {
          issues.push('incompatible_items');
        }
      }
    });
  }

  for (const [id, count] of inventory) {
    const template = containersById.get(id);
    if (template?.quantity != null && count > template.quantity) issues.push('container_inventory_exceeded');
  }

  const maxContainers = request.configuration?.max_containers;
  if (maxContainers != null && result.containers.length > maxContainers) issues.push('max_containers_exceeded');

  for (const [, homes] of groupHomes) {
    if (homes.size > 1) issues.push('group_split');
  }

  const expected = new Set();
  for (const item of request.items) {
    for (let sequence = 1; sequence <= (item.quantity ?? 1); sequence++) expected.add(`${item.id}#${sequence}`);
  }
  const reported = new Set([...seen, ...result.unpacked_items.map((entry) => entry.item_id)]);
  if (reported.size !== expected.size || [...expected].some((id) => !reported.has(id))) {
    issues.push('items_lost_or_invented');
  }

  return issues;
}

/**
 * A billed weight past the last bracket, or a container with no tariff at all, has no
 * published price. The engines rank it worst rather than free, so that a packing the
 * caller cannot ship can never win; this reproduces that rather than reporting a
 * mismatch against it.
 */
const UNPRICEABLE = Number.MAX_SAFE_INTEGER;

/**
 * One container's carrier charge, accumulated.
 *
 * Deliberately a second implementation of the tariff rather than an import from the
 * engine. A validator that priced the shipment with the solver's own arithmetic would
 * agree with it by construction -- including when both are wrong, which is the case it
 * exists to catch. It reads only what the result and request declare: the
 * reported gross weight, the declared outer dimensions and the published rate card.
 *
 * @returns {number}
 */
function addCharge(total, container, billedTicks) {
  if (total === UNPRICEABLE) return total;
  const table = container?.rate_table;
  if (!table) return UNPRICEABLE;
  // Whole grams, rounded up: a carrier reads a shipment fractionally over a bracket as
  // being in the next one.
  const grams = (billedTicks + BigInt(WEIGHT_TICKS.g) - 1n) / BigInt(WEIGHT_TICKS.g);
  for (let index = 0; index < table.weight_brackets_g.length; index += 1) {
    if (grams > BigInt(table.weight_brackets_g[index])) continue;
    const base = Math.max(table.prices_minor[index], table.minimum_charge_minor ?? 0);
    const surcharge = (BigInt(base) * BigInt(table.fuel_surcharge_permille ?? 0) + 999n) / 1000n;
    return total + base + Number(surcharge);
  }
  return UNPRICEABLE;
}

/**
 * The objective vector recomputed from the reported placements.
 *
 * Only meaningful when no clearance was configured: the score is measured on
 * envelopes, and the result reports physical boxes.
 *
 * @returns {number[]}
 */
export function objective(request, result) {
  const containersById = new Map(request.containers.map((container) => [container.id, container]));
  const itemsById = new Map(request.items.map((item) => [item.id, item]));
  const lengthUnit = request.units?.length ?? 'mm';
  let cost = 0;
  let unused = 0;
  let height = 0;
  let billable = 0;
  let landed = 0;
  let achievedHeight = 0;
  const latticeSequences = new Map();

  for (const container of result.containers) {
    cost += containersById.get(container.container_type)?.cost_minor ?? 0;

    const inner = size(container.inner_dimensions);
    const total = volume(inner);
    const boxes = boxesOf(container, latticeSequences);
    // Occupied volume follows the shape: a hull's own volume, a compressible item's height
    // after the load above it, otherwise the box. Counting boxes would put two interlocking
    // wedges at 200% of a crate and would never show a compressible item giving up height.
    const loadsFor = boxes.some((box) => itemsById.get(box.type)?.max_compression_pressure_kpa != null)
      ? boxes.map((box) => {
        let carried = 0n;
        for (const other of boxes) {
          if (other === box) continue;
          const restsAbove = other.at[2] === box.at[2] + box.size[2]
            && other.at[0] < box.at[0] + box.size[0] && box.at[0] < other.at[0] + other.size[0]
            && other.at[1] < box.at[1] + box.size[1] && box.at[1] < other.at[1] + other.size[1];
          if (restsAbove) carried += BigInt(requestWeightTicks(itemsById.get(other.type)?.weight ?? 0));
        }
        return carried;
      })
      : boxes.map(() => 0n);
    let used = boxes.reduce((sum, box, index) =>
      sum + occupiedVolumeOf(box, itemsById.get(box.type), lengthUnit, loadsFor[index]), 0n);
    boxes.forEach((box, index) => {
      for (const other of boxes.slice(index + 1)) {
        if (validNesting(box, other, itemsById, lengthUnit)) {
          used -= BigInt(requestLengthTicks(itemsById.get(box.type).nesting_height, lengthUnit))
            * BigInt(box.size[0]) * BigInt(box.size[1]);
        }
      }
    });
    if (total > 0n) unused += Number(((total - used) * SCORE_SCALE) / total);

    const top = boxes.reduce(
      (highest, box) => Math.max(highest, box.at[2] + box.size[2]), 0);
    achievedHeight += top;
    if (inner[2] > 0) height += Number((BigInt(top) * SCORE_SCALE) / BigInt(inner[2]));

    const objectiveName = request.configuration?.objective;
    if (objectiveName === 'shipping_cost' || objectiveName === 'lowest_landed_cost') {
      const lengthTicks = BigInt(LENGTH_TICKS[request.configuration.dimensional_weight_length_unit ?? 'in']);
      const weightTicks = BigInt(WEIGHT_TICKS[request.configuration.dimensional_weight_weight_unit ?? 'lb']);
      const divisor = BigInt(request.configuration.dimensional_weight_divisor);
      const dimensional = volume(size(container.outer_dimensions)) * weightTicks
        / (lengthTicks ** 3n * divisor);
      const billed = BigInt(ticks(container.gross_weight)) > dimensional
        ? BigInt(ticks(container.gross_weight)) : dimensional;
      if (objectiveName === 'shipping_cost') billable += Number(billed);
      else landed = addCharge(landed, containersById.get(container.container_type), billed);
    }
  }

  const standard = [result.unpacked_items.length, result.containers.length, cost, unused, height];
  const selected = request.configuration?.objective ?? 'default';
  if (selected === 'lowest_cost') {
    return [standard[0], standard[2], standard[1], standard[3], standard[4]];
  }
  if (selected === 'shipping_cost') {
    return [standard[0], billable, standard[1], standard[3], standard[4]];
  }
  if (selected === 'lowest_landed_cost') {
    return [standard[0], landed, standard[1], standard[3], standard[4]];
  }
  if (selected === 'open_dimension_height') {
    return [standard[0], achievedHeight, standard[1], standard[2], standard[3]];
  }
  if (selected === 'maximum_value') {
    const valueForgone = result.unpacked_items.reduce(
      (sum, item) => sum + (itemsById.get(item.item_type)?.value ?? 0), 0);
    return [standard[0], valueForgone, standard[1], standard[2], standard[3]];
  }
  return standard;
}
