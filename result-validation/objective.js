/**
 * The objective vector recomputed from the result alone, and the request-level rules that only
 * the whole result can answer: fixed placements, groups and solver selection.
 */

import { achievedExtent } from './container.js';
import {
  PyDict, at, compareCodePoints, getNull, getOr, has, hashKey, int, list, pyCmp, pyEq, pyInt, sortPy, text, truthy,
} from './json.js';
import { ceilDiv, floorDiv, max } from './num.js';
import { contract, issue, shape } from './outcome.js';
import { intList, pyRepr, pyStr, valueTuple } from './pyfmt.js';
import { volumeOf } from './spec.js';
import { SCORE_SCALE } from './stacking.js';
import { LENGTH, TICKS_PER_GRAM, WEIGHT, perUnit, toTicks } from './units.js';

/** `floor(volume * weight ticks per unit / (length ticks per unit ^ 3 * divisor))`. */
function dimensionalWeight(size, divisor, lengthUnit, weightUnit) {
  const length = perUnit(LENGTH, lengthUnit);
  const weight = perUnit(WEIGHT, weightUnit);
  return floorDiv(size[0] * size[1] * size[2] * weight, length ** 3n * divisor);
}

/**
 * One container's carrier charge from the request's own rate card: billed weight up to whole
 * grams, the minimum charge, then the fuel surcharge rounded up.
 */
function landedCharge(spec, billed) {
  if (spec.rateTable === null) {
    throw contract(`container ${pyRepr(spec.id)} has no rate_table, so lowest_landed_cost cannot price it`);
  }
  const table = spec.rateTable;
  const brackets = list(at(table, 'weight_brackets_g'), 'weight_brackets_g').map((bound) => pyInt(bound, 'bracket'));
  const prices = list(at(table, 'prices_minor'), 'prices_minor').map((price) => pyInt(price, 'price'));
  const grams = ceilDiv(billed, TICKS_PER_GRAM);
  for (let index = 0; index < Math.min(brackets.length, prices.length); index += 1) {
    if (grams <= brackets[index]) {
      const base = max(prices[index], pyInt(getOr(table, 'minimum_charge_minor', 0), 'minimum_charge_minor'));
      const permille = pyInt(getOr(table, 'fuel_surcharge_permille', 0), 'fuel_surcharge_permille');
      return base + ceilDiv(base * permille, 1000n);
    }
  }
  if (brackets.length === 0) throw shape('an empty rate table');
  throw contract(`container ${pyRepr(spec.id)} bills at ${grams} g, above its rate table's last bracket `
    + `(${brackets[brackets.length - 1]} g); the shipment has no published price`);
}

/** The highest envelope top over a container's placements, 0 when it holds none. */
function topOf(packed, clearance) {
  const tops = list(at(packed, 'placements'), 'placements').map((placement) => {
    const z = int(at(at(at(placement, 'position'), 'z'), 'ticks'), 'placement ticks');
    const height = int(at(at(at(placement, 'dimensions'), 'height'), 'ticks'), 'placement ticks');
    return z + height + clearance;
  });
  return tops.length === 0 ? 0n : tops.reduce(max);
}

/** What one container is billed at under `shipping_cost` and `lowest_landed_cost`. */
function billedWeight(packed, spec, inputs, billing) {
  const divisor = int(billing.divisor, 'dimensional_weight_divisor');
  const gross = pyInt(getOr(getOr(packed, 'gross_weight', {}), 'ticks', 0), 'gross_weight');
  const size = spec.flatBag ? achievedExtent(packed, inputs.clearance) : spec.outer ?? spec.inner;
  const dimensional = dimensionalWeight(size, divisor, text(billing.lengthUnit, 'dimensional_weight_length_unit'),
    text(billing.weightUnit, 'dimensional_weight_weight_unit'));
  return max(gross, dimensional);
}

/** The per-container sums every objective draws on. */
function containerTotals(containers, inputs, name, billing) {
  const totals = { cost: 0n, unused: 0n, height: 0n, billable: 0n, achievedHeight: 0n, landed: 0n };
  const billed = (name === 'shipping_cost' || name === 'lowest_landed_cost') && billing.divisor !== null;
  for (const packed of containers) {
    const spec = inputs.fabricated.get(getNull(packed, 'id')) ?? inputs.containers.get(at(packed, 'container_type'));
    if (spec === undefined) continue;
    totals.cost += spec.costMinor;
    const volume = volumeOf(spec);
    if (volume === 0n) continue;
    const used = pyInt(at(packed, 'used_volume_ticks3'), 'used_volume_ticks3');
    totals.unused += floorDiv((volume - used) * SCORE_SCALE, volume);
    const top = topOf(packed, inputs.clearance);
    totals.height += floorDiv(top * SCORE_SCALE, spec.inner[2]);
    totals.achievedHeight += top;
    if (!billed) continue;
    const weight = billedWeight(packed, spec, inputs, billing);
    totals.billable += weight;
    if (name === 'lowest_landed_cost') totals.landed += landedCharge(spec, weight);
  }
  return totals;
}

/** `sum(nominal volume)` over the unpacked items whose type the request declares. */
function unpackedSum(unpackedItems, items, measure) {
  return unpackedItems.reduce((total, unpacked) => {
    const spec = items.get(at(unpacked, 'item_type'));
    return spec === undefined ? total : total + measure(spec);
  }, 0n);
}

const nominalVolume = (spec) => spec.dimensions[0] * spec.dimensions[1] * spec.dimensions[2];

/** The objective vector of `result` under the objective `name`. */
function objective(result, inputs, name, billing) {
  const containers = list(at(result, 'containers'), 'result.containers');
  const totals = containerTotals(containers, inputs, name, billing);
  const unpackedItems = list(at(result, 'unpacked_items'), 'result.unpacked_items');
  const unpacked = BigInt(unpackedItems.length);
  const opened = BigInt(containers.length);
  const unknown = () => contract(`unknown requested objective ${pyRepr(name)}`);
  if (typeof name !== 'string') throw unknown();
  const requiresDivisor = () => {
    if (billing.divisor === null) throw contract(`${name} objective requires configuration.dimensional_weight_divisor`);
  };
  switch (name) {
    case 'default': return [unpacked, opened, totals.cost, totals.unused, totals.height];
    case 'lowest_cost': return [unpacked, totals.cost, opened, totals.unused, totals.height];
    case 'shipping_cost':
      requiresDivisor();
      return [unpacked, totals.billable, opened, totals.unused, totals.height];
    case 'lowest_landed_cost':
      requiresDivisor();
      return [unpacked, totals.landed, opened, totals.unused, totals.height];
    case 'open_dimension_height': return [unpacked, totals.achievedHeight, opened, totals.cost, totals.unused];
    case 'maximum_value': {
      const forgone = unpackedSum(unpackedItems, inputs.items, (spec) => (truthy(spec.value) ? int(spec.value, 'value') : 0n));
      return [unpacked, forgone, opened, totals.cost, totals.unused];
    }
    case 'maximum_volume': {
      const unpackedVolume = unpackedSum(unpackedItems, inputs.items, nominalVolume);
      const requested = inputs.items.values()
        .reduce((total, spec) => total + nominalVolume(spec) * int(spec.quantity, 'quantity'), 0n);
      const unpackedPpm = requested === 0n ? 0n : ceilDiv(unpackedVolume * SCORE_SCALE, requested);
      return [unpackedPpm, unpacked, opened, totals.cost, totals.unused];
    }
    default: throw unknown();
  }
}

/** Checks the reported score against the recomputed one, and returns the reported score. */
export function checkObjective(request, result, inputs, issues) {
  const configuration = getOr(request, 'configuration', {});
  const selected = getOr(configuration, 'objective', 'default');
  const reportedName = getNull(result, 'objective');
  if ((has(configuration, 'objective') || reportedName !== null) && !pyEq(reportedName, selected)) {
    issues.push(issue('objective_mismatch', `reported ${pyRepr(reportedName)}, requested ${pyRepr(selected)}`));
  }
  const reported = list(at(result, 'score'), 'score').map((component) => pyInt(component, 'score'));
  const billing = {
    divisor: getNull(configuration, 'dimensional_weight_divisor'),
    lengthUnit: getOr(configuration, 'dimensional_weight_length_unit', 'in'),
    weightUnit: getOr(configuration, 'dimensional_weight_weight_unit', 'lb'),
  };
  const recomputed = objective(result, inputs, selected, billing);
  if (reported.length !== recomputed.length || reported.some((value, index) => value !== recomputed[index])) {
    issues.push(issue('score_mismatch', `reported ${intList(reported)}, recomputed ${intList(recomputed)}`));
  }
  return reported;
}

export function checkSolverSelection(request, result, issues) {
  const selected = getOr(getOr(request, 'configuration', {}), 'solvers', []);
  if (!truthy(selected)) return;
  const solvers = list(selected, 'configuration.solvers');
  const reported = getNull(at(result, 'algorithm'), 'solver');
  const base = typeof reported === 'string' ? reported.split(':', 1)[0] : reported;
  if (!solvers.some((solver) => pyEq(solver, base))) {
    issues.push(issue('solver_selection_mismatch', `reported ${pyRepr(reported)}, requested one of ${pyRepr(selected)}`));
  }
}

/** A group travels together or not at all: one container, and never half-packed. */
export function checkGroups(request, result, issues) {
  const rawItems = list(at(request, 'items'), 'request.items');
  const groups = new PyDict();
  for (const raw of rawItems) {
    if (getNull(raw, 'group') !== null) groups.set(at(raw, 'id'), at(raw, 'group'));
  }
  if (groups.size === 0) return;
  const located = new PyDict();
  const packed = new PyDict();
  for (const container of list(at(result, 'containers'), 'result.containers')) {
    for (const placement of list(at(container, 'placements'), 'placements')) {
      const group = groups.get(at(placement, 'item_type'));
      if (group === undefined) continue;
      if (!located.has(group)) located.set(group, new PyDict());
      located.get(group).set(at(container, 'id'), true);
      packed.set(group, (packed.get(group) ?? 0n) + 1n);
    }
  }
  const expected = new PyDict();
  for (const raw of rawItems) {
    const group = getNull(raw, 'group');
    if (group !== null) expected.set(group, (expected.get(group) ?? 0n) + int(getOr(raw, 'quantity', 1), 'quantity'));
  }
  for (const group of sortPy(located.keys())) {
    const places = located.get(group).keys();
    if (places.length > 1) {
      const where = places.map((place) => text(place, 'a container id')).sort(compareCodePoints);
      issues.push(issue('group_split', `${pyStr(group)}: ${where.join(', ')}`));
    }
    const placed = packed.get(group) ?? 0n;
    const wanted = expected.get(group) ?? 0n;
    if (placed !== wanted) issues.push(issue('group_partially_packed', `${pyStr(group)}: ${placed} of ${wanted} placed`));
  }
}

/** A fixed placement's identity, `[container id, item type, x, y, z, orientation]`, hashed whole. */
const keyHash = (key) => key.map(hashKey).join('\u0000');

/** `set.add(key)`: an equal key already present stays, as Python's set keeps it. */
function keepFirst(keys, key) {
  const hash = keyHash(key);
  if (!keys.has(hash)) keys.set(hash, key);
}

function sortedKeys(keys) {
  return keys.slice().sort(pyCmp);
}

/** Every fixed placement is reported where the request put it, and nothing else claims to be. */
export function checkFixedPlacements(request, result, unit, issues) {
  const requested = new Map();
  for (const entry of list(getOr(request, 'fixed_placements', []), 'fixed_placements')) {
    const containerId = `${pyStr(at(entry, 'container_type'))}#${pyStr(getOr(entry, 'container_instance', 1))}`;
    const position = getOr(entry, 'position', {});
    const key = [containerId, at(entry, 'item_type'),
      ...['x', 'y', 'z'].map((axis) => toTicks(getOr(position, axis, 0), unit, LENGTH)), at(entry, 'orientation')];
    keepFirst(requested, key);
  }
  const reported = new Map();
  const containerTypes = new PyDict();
  for (const container of list(at(result, 'containers'), 'result.containers')) {
    const containerId = getOr(container, 'id', '');
    containerTypes.set(containerId, at(container, 'container_type'));
    for (const placement of list(at(container, 'placements'), 'placements')) {
      if (getNull(placement, 'fixed') !== true) continue;
      const position = at(placement, 'position');
      const key = [containerId, at(placement, 'item_type'),
        ...['x', 'y', 'z'].map((axis) => at(at(position, axis), 'ticks')), at(placement, 'orientation')];
      keepFirst(reported, key);
    }
  }
  for (const key of sortedKeys(Array.from(requested.values()))) {
    const containerId = text(key[0], 'container id');
    const hash = containerId.lastIndexOf('#');
    const declaredType = hash === -1 ? containerId : containerId.slice(0, hash);
    if (containerTypes.get(containerId) !== declaredType) {
      issues.push(issue('fixed_container_missing', containerId));
    } else if (!reported.has(keyHash(key))) {
      issues.push(issue('fixed_placement_moved',
        `${pyStr(key[1])} fixed in ${containerId} at ${valueTuple(key.slice(2, 5))} ${pyStr(key[5])}`));
    }
  }
  const unexpected = Array.from(reported.entries()).filter(([hash]) => !requested.has(hash)).map(([, key]) => key);
  for (const key of sortedKeys(unexpected)) {
    issues.push(issue('unexpected_fixed_placement',
      `${pyStr(key[1])} in ${pyStr(key[0])} at ${valueTuple(key.slice(2, 5))} ${pyStr(key[5])}`));
  }
}
