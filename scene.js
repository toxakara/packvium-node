/**
 * Visualization scenes (`packvium-visualization-scene/v1`, visualizer/spec/scene.md) from a
 * packing result, so a caller can draw one without writing the conversion.
 *
 * A scene is read from the operational artifact (docs/OPERATIONAL-ARTIFACTS.md), never from a
 * solver, a request or a clock: sizes from its `geometry`, the sequence from its `plan`. One
 * scene is one container. The visualizer's viewer draws through `artifactToScene` and admits
 * artifacts by `sceneItemId`, so this module is the only scene converter.
 */

import { buildOperationalArtifact } from './artifacts.js';

export const SCENE_FORMAT = 'packvium-visualization-scene/v1';

const TICKS_PER_MM = 16000n;
const DISPLAY_UNITS = new Set(['mm', 'cm', 'm', 'in', 'ft']);

/**
 * Every container of a packing result as a scene, in the result's container order. The result
 * must be the one `pack` returned for this request. O(P) for P placements.
 */
export function resultToScenes(request, result) {
  const artifact = buildOperationalArtifact(request, result);
  return artifact.geometry.containers.map((_, index) => artifactToScene(artifact, index));
}

/**
 * One container of an operational artifact as a scene. O(P) for the container's P placements.
 *
 * - Item ids come from the plan's placement reference; the artifact carries no `item_id`.
 * - A sequence exists only when the plan's order is `loading`. An `unavailable` order yields
 *   no sequence rather than one inferred from array position, which would present the order
 *   the solver walked its candidates in as a safe order to lift boxes in.
 * - `step` is the plan's own `sequence`, the number the printed work order shows. A loading
 *   step without one is refused, not numbered here: the scene must replay the sheet's numbers.
 * - Obstacles are empty: the artifact's geometry states none, and reconstructing them from
 *   `provenance.request` would draw geometry the artifact itself does not assert.
 *
 * Every departure from the fields `SceneSource` documents is a `RangeError` naming the path of
 * the bad value, as is an index the artifact has no container for.
 */
export function artifactToScene(artifact, containerIndex) {
  const source = requireObject(artifact, 'artifact');
  const geometries = requireList(requireObject(source.geometry, 'artifact.geometry').containers, 'artifact.geometry.containers');
  const plans = requireList(requireObject(source.plan, 'artifact.plan').containers, 'artifact.plan.containers');
  if (!Number.isInteger(containerIndex) || containerIndex < 0 || containerIndex >= geometries.length
    || containerIndex >= plans.length) {
    throw new RangeError(`container ${containerIndex} is not one of the artifact's ${geometries.length} containers`);
  }
  const unit = lengthUnit(source.work_order);
  const geometry = requireObject(geometries[containerIndex], `artifact.geometry.containers[${containerIndex}]`);
  const scene = {
    format: SCENE_FORMAT,
    ...(DISPLAY_UNITS.has(unit) ? { display_unit: unit } : {}),
    container: { id: String(containerIndex), dimensions: sceneDimensions(geometry.inner_dimensions, `artifact.geometry.containers[${containerIndex}].inner_dimensions`) },
    items: sceneItems(geometry.placements, `artifact.geometry.containers[${containerIndex}].placements`),
    obstacles: [],
  };
  const sequence = loadingSequence(plans[containerIndex], `artifact.plan.containers[${containerIndex}]`);
  return sequence === null ? scene : { ...scene, sequence_kind: 'loading', sequence };
}

function lengthUnit(workOrder) {
  const unit = requireObject(workOrder, 'artifact.work_order').length_unit;
  if (unit !== null && typeof unit !== 'string') {
    throw new RangeError('artifact.work_order.length_unit must be a string or null');
  }
  return unit;
}

function sceneItems(placements, path) {
  return requireList(placements, path).map((entry, index) => {
    const at = `${path}[${index}]`;
    const { placement, dimensions } = requireObject(entry, at);
    const reference = readReference(placement, `${at}.placement`);
    const { x, y, z } = reference.position_ticks;
    return {
      id: spellItemId(reference),
      position: { x: lengthValue(x), y: lengthValue(y), z: lengthValue(z) },
      dimensions: sceneDimensions(dimensions, `${at}.dimensions`),
      rotation: reference.orientation,
    };
  });
}

/** The plan's loading steps as scene steps, or `null` when the plan established no order. */
function loadingSequence(raw, path) {
  const plan = requireObject(raw, path);
  if (plan.order !== 'loading' && plan.order !== 'unavailable') {
    throw new RangeError(`${path}.order must be loading or unavailable`);
  }
  const steps = requireList(plan.steps, `${path}.steps`);
  if (plan.order === 'unavailable') return null;
  return steps.map((entry, index) => {
    const at = `${path}.steps[${index}]`;
    const step = requireObject(entry, at);
    if (!Number.isSafeInteger(step.sequence) || step.sequence < 1) {
      throw new RangeError(`${at}.sequence must be a positive integer when the order is loading`);
    }
    return { step: step.sequence, item_id: spellItemId(readReference(step.placement, `${at}.placement`)) };
  });
}

function sceneDimensions(raw, path) {
  const sides = requireObject(raw, path);
  return {
    length: lengthValue(tickString(sides.length, `${path}.length`)),
    width: lengthValue(tickString(sides.width, `${path}.width`)),
    height: lengthValue(tickString(sides.height, `${path}.height`)),
  };
}

/**
 * The scene item id for a plan placement reference, `<item_type>@<x>,<y>,<z>/<orientation>`.
 * Injective within a container even when `item_type` contains `@` or `/`: read from the right,
 * the orientation is one of six letter triples and the coordinates hold only digits, commas and
 * minus signs (docs/EXECUTION-PLAN.md). Exported so a caller can match a scene item to its step.
 * A reference without those fields is a `RangeError`.
 */
export function sceneItemId(reference) {
  return spellItemId(readReference(reference, 'reference'));
}

/** The id of a reference `readReference` has already admitted. */
function spellItemId({ item_type: itemType, orientation, position_ticks: { x, y, z } }) {
  return `${itemType}@${x},${y},${z}/${orientation}`;
}

const ROTATIONS = new Set(['LWH', 'LHW', 'WLH', 'WHL', 'HLW', 'HWL']);

/** A placement reference holding every field a scene reads, or a `RangeError` naming the first that is not. */
function readReference(raw, path) {
  const reference = requireObject(raw, path);
  if (typeof reference.item_type !== 'string') throw new RangeError(`${path}.item_type must be a string`);
  if (!ROTATIONS.has(reference.orientation)) {
    throw new RangeError(`${path}.orientation must be one of ${[...ROTATIONS].join(', ')}`);
  }
  const position = requireObject(reference.position_ticks, `${path}.position_ticks`);
  for (const axis of ['x', 'y', 'z']) {
    if (!Number.isInteger(position[axis])) throw new RangeError(`${path}.position_ticks.${axis} must be an integer`);
  }
  return reference;
}

const TICKS = /^-?[0-9]+$/;

function tickString(value, path) {
  if (typeof value !== 'string' || !TICKS.test(value)) {
    throw new RangeError(`${path} must be a tick count spelled as decimal digits`);
  }
  return value;
}

function requireObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RangeError(`${path} must be an object`);
  }
  return value;
}

function requireList(value, path) {
  if (!Array.isArray(value)) throw new RangeError(`${path} must be a list`);
  return value;
}

/**
 * The exact `lengthValue` for a tick count: `mm` is the decimal quotient with no rounding and
 * no trailing zeros. BigInt, never a float: a float would render 0.1 mm as
 * 0.09999999999999999. The loop runs at most seven times, because 16000 = 2^7 * 5^3 makes
 * every quotient terminate within seven decimal places.
 */
function lengthValue(ticks) {
  const exact = BigInt(ticks);
  const negative = exact < 0n;
  const magnitude = negative ? -exact : exact;
  let remainder = magnitude % TICKS_PER_MM;
  let fraction = '';
  while (remainder !== 0n) {
    remainder *= 10n;
    fraction += String(remainder / TICKS_PER_MM);
    remainder %= TICKS_PER_MM;
  }
  const whole = String(magnitude / TICKS_PER_MM);
  return { ticks: String(exact), mm: `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}` };
}
