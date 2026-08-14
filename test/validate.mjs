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
        if (overlaps(box, other) && !validNesting(box, other, itemsById, lengthUnit)) {
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
    let used = boxes.reduce((sum, box) => sum + volume(box.size), 0n);
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
