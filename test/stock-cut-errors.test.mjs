import assert from 'node:assert/strict';
import test from 'node:test';
import { packFallback } from '../fallback.js';
import { buildOperationalArtifact } from '../artifacts.js';
import { deriveRevision, rootRevision, stockCutBoxes, PlanRevisionError } from '../revisions.js';

test('replacement and lock refuse unreadable stock fields through the revision error API', () => {
  const sides = { length: '10', width: '10', height: '10' };
  const request = { items: [{ id: 'cube', dimensions: sides }], containers: [
    { id: 'machine', inner_dimensions: sides, made_to_measure: { minimum: sides, increment: sides } },
  ] };
  const artifact = buildOperationalArtifact(request, packFallback(request));
  for (const [field, value, detail] of [
    ['made_to_measure', true, 'made_to_measure is not an object'],
    ['cost_minor', 'price', 'cost_minor is not an integer'],
    ['tare_weight', 'heavy', 'tare_weight is not a measure'],
  ]) {
    const replacement = { ...request.containers[0], [field]: value };
    const events = [
      { sequence: 1, type: 'container_substituted', container_type: 'machine', replacement },
      { sequence: 2, type: 'placement_locked', placement: { item_type: 'cube', container_type: 'machine', orientation: 'LWH' } },
    ];
    assert.throws(() => deriveRevision(rootRevision(request), artifact, events),
      (error) => error instanceof PlanRevisionError && error.code === 'invalid_revision'
        && error.message === `a made-to-measure container's ${detail}`);
  }
  const revision = deriveRevision(rootRevision(request), artifact, [{ sequence: 1, type: 'placement_locked',
    placement: { item_type: 'cube', container_type: 'machine', orientation: 'LWH', position: { x: '999999' } } }]);
  assert.equal(revision.request.fixed_placements[0].position.x, '999999');
  for (const [units, detail] of [[[], 'units is not an object'], [{ length: [] }, 'units.length is not a string']]) {
    const fixed = { ...request, units, fixed_placements: [{ container_type: 'machine' }] };
    assert.throws(() => stockCutBoxes(fixed, artifact, 1),
      (error) => error instanceof PlanRevisionError && error.message === `a made-to-measure container's ${detail}`);
  }
  for (const cost of [null, 0, 1, 1.0, -1]) {
    const fixed = { ...request, containers: [{ ...request.containers[0], cost_minor: cost }],
      fixed_placements: [{ container_type: 'machine' }] };
    assert.equal(stockCutBoxes(fixed, artifact, 1).containers[1].cost_minor, cost ?? 0);
  }
});
