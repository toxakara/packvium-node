/**
 * Visualization scenes at the unit level: exact millimetre spelling, item ids, the
 * container range, the loading sequence and the refusal of a malformed artifact.
 * visualizer/spec/tests/test_engine_scenes.py holds every golden result to scene.schema.json;
 * these pin the arithmetic the visualizer used to own.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import { pack } from '@packvium/engine';
import { buildOperationalArtifact } from '@packvium/engine/artifacts.js';
import { artifactToScene, resultToScenes, sceneItemId } from '@packvium/engine/scene.js';

const REFERENCE = { item_type: 'a', orientation: 'HLW', position_ticks: { x: 0, y: 1760000, z: 0 } };

/** One container whose inner length is `ticks`, holding one placement and no loading order. */
function artifactWithLength(ticks) {
  const cube = { length: '16000', width: '16000', height: '16000' };
  return {
    geometry: {
      containers: [{ inner_dimensions: { ...cube, length: ticks }, placements: [{ placement: REFERENCE, dimensions: cube }] }],
    },
    plan: { containers: [{ order: 'unavailable', steps: [{ placement: REFERENCE }] }] },
    work_order: { length_unit: 'mm' },
  };
}

const EXACT = [
  ['0', '0'],
  ['16000', '1'],
  ['1760000', '110'],
  ['1600000', '100'],
  ['8000', '0.5'],
  ['1600', '0.1'],
  ['1', '0.0000625'],
  ['-24000', '-1.5'],
  ['-1', '-0.0000625'],
  ['123456789012345678901234', '7716049313271604931.327125'],
  // 2^64 + 1: a float would round this long before the last digit.
  ['18446744073709551617', '1152921504606846.9760625'],
];

for (const [ticks, mm] of EXACT) {
  test(`${ticks} ticks are exactly ${mm} mm`, () => {
    assert.deepEqual(artifactToScene(artifactWithLength(ticks), 0).container.dimensions.length, { ticks, mm });
  });
}

test('an item id is spelled from the placement reference', () => {
  assert.equal(sceneItemId(REFERENCE), 'a@0,1760000,0/HLW');
  assert.deepEqual(artifactToScene(artifactWithLength('16000'), 0).items.map((item) => item.id), ['a@0,1760000,0/HLW']);
});

test('an unavailable order yields no sequence', () => {
  const scene = artifactToScene(artifactWithLength('16000'), 0);
  assert.equal('sequence' in scene, false);
  assert.equal('sequence_kind' in scene, false);
});

for (const containerIndex of [1, -1, 0.5]) {
  test(`container ${containerIndex} is a RangeError`, () => {
    assert.throws(() => artifactToScene(artifactWithLength('16000'), containerIndex), RangeError);
  });
}

/** The one-container artifact with a loading order of one step numbered `sequence`. */
function loadingArtifact(step) {
  const artifact = artifactWithLength('16000');
  return { ...artifact, plan: { containers: [{ order: 'loading', steps: [step] }] } };
}

test('a loading order replays the plan’s own step numbers', () => {
  const scene = artifactToScene(loadingArtifact({ sequence: 1, placement: REFERENCE }), 0);
  assert.equal(scene.sequence_kind, 'loading');
  assert.deepEqual(scene.sequence, [{ step: 1, item_id: 'a@0,1760000,0/HLW' }]);
});

// scene.schema.json requires an integer `step`; numbering it here from array position would
// let the picture disagree with the printed work order, so a step without one is refused.
for (const sequence of [undefined, 0, 1.5, '1']) {
  test(`a loading step whose sequence is ${JSON.stringify(sequence)} is a RangeError`, () => {
    assert.throws(
      () => artifactToScene(loadingArtifact({ sequence, placement: REFERENCE }), 0),
      { name: 'RangeError', message: 'artifact.plan.containers[0].steps[0].sequence must be a positive integer when the order is loading' },
    );
  });
}

const MALFORMED = [
  ['no artifact', () => null, 'artifact must be an object'],
  ['no geometry', (a) => ({ ...a, geometry: undefined }), 'artifact.geometry must be an object'],
  ['geometry containers not a list', (a) => ({ ...a, geometry: { containers: {} } }), 'artifact.geometry.containers must be a list'],
  ['no plan', (a) => ({ ...a, plan: undefined }), 'artifact.plan must be an object'],
  ['plan containers not a list', (a) => ({ ...a, plan: {} }), 'artifact.plan.containers must be a list'],
  ['no work order', (a) => ({ ...a, work_order: undefined }), 'artifact.work_order must be an object'],
  ['a numeric length unit', (a) => ({ ...a, work_order: { length_unit: 1 } }), 'artifact.work_order.length_unit must be a string or null'],
  ['an unknown order', (a) => ({ ...a, plan: { containers: [{ order: 'guessed', steps: [] }] } }),
    'artifact.plan.containers[0].order must be loading or unavailable'],
  ['steps not a list', (a) => ({ ...a, plan: { containers: [{ order: 'unavailable' }] } }),
    'artifact.plan.containers[0].steps must be a list'],
  ['a container that is not an object', (a) => ({ ...a, geometry: { containers: [null] } }),
    'artifact.geometry.containers[0] must be an object'],
  ['no inner dimensions', (a) => ({ ...a, geometry: { containers: [{ placements: [] }] } }),
    'artifact.geometry.containers[0].inner_dimensions must be an object'],
  ['a numeric tick string', (a) => ({ ...a, geometry: { containers: [{ ...a.geometry.containers[0], inner_dimensions: { length: 16000, width: '1', height: '1' } }] } }),
    'artifact.geometry.containers[0].inner_dimensions.length must be a tick count spelled as decimal digits'],
  ['placements not a list', (a) => ({ ...a, geometry: { containers: [{ ...a.geometry.containers[0], placements: null }] } }),
    'artifact.geometry.containers[0].placements must be a list'],
  ['a placement with no reference', (a) => ({ ...a, geometry: { containers: [{ ...a.geometry.containers[0], placements: [{ dimensions: a.geometry.containers[0].placements[0].dimensions }] }] } }),
    'artifact.geometry.containers[0].placements[0].placement must be an object'],
  ['an unknown orientation', (a) => ({ ...a, geometry: { containers: [{ ...a.geometry.containers[0], placements: [{ ...a.geometry.containers[0].placements[0], placement: { ...REFERENCE, orientation: 'XYZ' } }] }] } }),
    'artifact.geometry.containers[0].placements[0].placement.orientation must be one of LWH, LHW, WLH, WHL, HLW, HWL'],
  ['a fractional position', (a) => ({ ...a, geometry: { containers: [{ ...a.geometry.containers[0], placements: [{ ...a.geometry.containers[0].placements[0], placement: { ...REFERENCE, position_ticks: { x: 0.5, y: 0, z: 0 } } }] }] } }),
    'artifact.geometry.containers[0].placements[0].placement.position_ticks.x must be an integer'],
];

for (const [name, edit, message] of MALFORMED) {
  test(`an artifact with ${name} is a RangeError naming the field`, () => {
    assert.throws(() => artifactToScene(edit(artifactWithLength('16000')), 0), { name: 'RangeError', message });
  });
}

test('a malformed placement reference is a RangeError, not a TypeError', () => {
  assert.throws(() => sceneItemId(undefined), { name: 'RangeError', message: 'reference must be an object' });
  assert.throws(() => sceneItemId({ ...REFERENCE, position_ticks: undefined }),
    { name: 'RangeError', message: 'reference.position_ticks must be an object' });
});

test('a packing result becomes one scene per container, read through its artifact', () => {
  const request = {
    items: [{ id: 'cube', quantity: 3, dimensions: { length: '100', width: '100', height: '100' } }],
    containers: [{ id: 'box', inner_dimensions: { length: '200', width: '100', height: '100' } }],
    configuration: { solver_profile: 'fast' },
  };
  const result = pack(request);
  const scenes = resultToScenes(request, result);
  const artifact = buildOperationalArtifact(request, result);
  assert.equal(scenes.length, result.containers.length);
  assert.deepEqual(scenes, result.containers.map((_, index) => artifactToScene(artifact, index)));
});
