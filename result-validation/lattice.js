/**
 * Compact lattice results, expanded independently before ordinary validation.
 *
 * The wire summary is an untrusted, reconstructible representation: its lattice parameters must
 * agree with the request before they are used to synthesize placements, and every synthesized
 * placement then passes through the same checks as an explicit one.
 */

import {
  at, getNull, getOr, has, int, list, pyEq, strictInt, truthy,
} from './json.js';
import { ceilDiv, floorDiv } from './num.js';
import { Refusal, contract, issue } from './outcome.js';
import { intTuple, pyRepr, pyStr, valueTuple } from './pyfmt.js';
import { allows, isRotation, rotated } from './spec.js';

const SIDES = ['length', 'width', 'height'];

/** The result with every valid lattice summary expanded into placements; the input is not changed. */
export function materialize(coordinatesRequired, result, items, containers, clearance, issues) {
  const packedContainers = list(at(result, 'containers'), 'result.containers');
  if (!packedContainers.some((packed) => has(packed, 'lattice_summary'))) return result;
  const rewritten = packedContainers.map((packed) => {
    const placements = expand(packed, coordinatesRequired, items, containers, clearance, issues);
    return placements === null ? packed : { ...packed, placements };
  });
  return { ...result, containers: rewritten };
}

/** The placements to write into one container, or `null` to leave it untouched. */
function expand(packed, coordinatesRequired, items, containers, clearance, issues) {
  const summary = getNull(packed, 'lattice_summary');
  if (summary === null) return null;
  const containerId = pyStr(getOr(packed, 'id', '?'));
  if (coordinatesRequired) {
    issues.push(issue('unexpected_lattice_summary', `${containerId}: request requires explicit placement coordinates`));
  }
  if (truthy(getNull(packed, 'placements'))) {
    issues.push(issue('lattice_placements_conflict',
      `${containerId}: compact summary and explicit placements are mutually exclusive`));
  }
  const itemType = getNull(summary, 'item_type');
  const item = items.get(itemType);
  const container = containers.get(getNull(packed, 'container_type'));
  // The ordinary accounting and container checks report the unknown reference.
  if (item === undefined || container === undefined) return null;

  const fields = readFields(summary, containerId);
  const problems = problemsOf(fields, item, itemType, container, clearance);
  if (problems.length > 0) {
    for (const problem of problems) issues.push(issue('lattice_summary_mismatch', `${containerId}: ${problem}`));
    return [];
  }
  return synthesize(fields, summary, itemType, containerId, clearance);
}

/** The summary's canonical fields; a missing one is the reference's contract refusal. */
function readFields(summary, containerId) {
  try {
    const sides = (key) => SIDES.map((side) => at(at(at(summary, key), side), 'ticks'));
    return {
      orientation: at(summary, 'orientation'),
      physical: sides('physical_dimensions'),
      envelope: sides('envelope_dimensions'),
      nx: at(summary, 'nx'),
      ny: at(summary, 'ny'),
      layersUsed: at(summary, 'layers_used'),
      layerStep: at(at(summary, 'layer_step'), 'ticks'),
      count: at(summary, 'count'),
    };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    throw contract(`${containerId}: lattice_summary is missing a canonical field: ${error.message}`);
  }
}

const matchesInts = (values, expected) => values.every((value, index) => pyEq(value, expected[index]));

function problemsOf(fields, item, itemType, container, clearance) {
  const problems = [];
  if (!isRotation(fields.orientation)) {
    problems.push(`unknown orientation ${pyRepr(fields.orientation)}`);
  } else {
    const expected = rotated(item, fields.orientation);
    if (!matchesInts(fields.physical, expected)) {
      problems.push(`physical dimensions ${valueTuple(fields.physical)} != rotated item ${intTuple(expected)}`);
    }
    if (!allows(item, fields.orientation)) {
      problems.push(`orientation ${fields.orientation} is forbidden for ${pyStr(itemType)}`);
    }
  }
  const expectedEnvelope = fields.physical.map((side) => int(side, 'physical dimension') + 2n * clearance);
  if (!matchesInts(fields.envelope, expectedEnvelope)) {
    problems.push(`envelope dimensions ${valueTuple(fields.envelope)} != physical+clearance ${intTuple(expectedEnvelope)}`);
  }
  if (item.nestingHeight !== null) problems.push('compact lattice form is not valid for nesting items');
  if (!pyEq(fields.layerStep, fields.envelope[2])) {
    problems.push(`layer_step ${pyStr(fields.layerStep)} != envelope height ${pyStr(fields.envelope[2])}`);
  }
  for (const [name, value] of [['nx', fields.nx], ['ny', fields.ny], ['layers_used', fields.layersUsed],
    ['layer_step', fields.layerStep], ['count', fields.count]]) {
    const number = strictInt(value);
    if (number === null || number < 1n) problems.push(`${name} must be a positive integer, got ${pyRepr(value)}`);
  }
  if (problems.length === 0) independentCounts(fields, item, container, problems);
  return problems;
}

/** Only reached once every field is a positive integer and the envelope is the expected one. */
function independentCounts(fields, item, container, problems) {
  const nx = int(fields.nx, 'lattice field');
  const ny = int(fields.ny, 'lattice field');
  const layersUsed = int(fields.layersUsed, 'lattice field');
  const layerStep = int(fields.layerStep, 'lattice field');
  const count = int(fields.count, 'lattice field');
  const expectedNx = floorDiv(container.inner[0], int(fields.envelope[0], 'lattice field'));
  const expectedNy = floorDiv(container.inner[1], int(fields.envelope[1], 'lattice field'));
  const expectedLayers = ceilDiv(count, nx * ny);
  if (nx !== expectedNx) problems.push(`nx ${nx} != independently computed ${expectedNx}`);
  if (ny !== expectedNy) problems.push(`ny ${ny} != independently computed ${expectedNy}`);
  if (layersUsed !== expectedLayers) {
    problems.push(`layers_used ${layersUsed} != independently computed ${expectedLayers}`);
  }
  if (count > int(item.quantity, 'quantity')) {
    problems.push(`count ${count} exceeds requested quantity ${pyStr(item.quantity)}`);
  }
  const verticalCapacity = floorDiv(container.inner[2], layerStep);
  if (layersUsed > verticalCapacity) {
    problems.push(`layers_used ${layersUsed} exceeds vertical capacity ${verticalCapacity}`);
  }
}

function synthesize(fields, summary, itemType, containerId, clearance) {
  const nx = int(fields.nx, 'lattice field');
  const ny = int(fields.ny, 'lattice field');
  const count = int(fields.count, 'lattice field');
  const layerStep = int(fields.layerStep, 'lattice field');
  const envelope = [int(fields.envelope[0], 'lattice field'), int(fields.envelope[1], 'lattice field')];
  const perLayer = nx * ny;
  const physical = at(summary, 'physical_dimensions');
  const placements = [];
  for (let index = 0n; index < count; index += 1n) {
    placements.push({
      item_id: `${pyStr(itemType)}#lattice:${containerId}:${index + 1n}`,
      item_type: itemType,
      orientation: fields.orientation,
      position: {
        x: { ticks: (index % nx) * envelope[0] + clearance },
        y: { ticks: ((index / nx) % ny) * envelope[1] + clearance },
        z: { ticks: (index / perLayer) * layerStep + clearance },
      },
      dimensions: physical,
    });
  }
  return placements;
}
