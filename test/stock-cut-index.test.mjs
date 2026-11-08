import assert from 'node:assert/strict';
import test from 'node:test';
import { stockCutBoxes } from '../revisions.js';

test('stocking reads artifact rows once and keeps the first lock order', () => {
  const count = 100;
  const request = {
    containers: [{ id: 'machine', quantity: count, made_to_measure: {} }],
    fixed_placements: Array.from({ length: count }, (_, i) => ({ container_type: 'machine', container_instance: count - i })),
  };
  let reads = 0;
  const artifact = {
    work_order: { containers: Array.from({ length: count }, () => ({ get container_type() { reads += 1; return 'machine'; } })) },
    geometry: { containers: Array.from({ length: count }, (_, i) => ({ inner_dimensions: { length: String(i + 1), width: '2', height: '3' } })) },
  };
  const stocked = stockCutBoxes(request, artifact, 7);
  assert.ok(reads <= count * 2, `${reads} artifact row reads`);
  assert.deepEqual(stocked.containers.map((box) => box.id), Array.from({ length: count }, (_, i) => `machine@7#${count - i}`));
  assert.equal(stocked.containers[0].inner_dimensions.length.value, '100');
  assert.equal(stocked.containers[count - 1].inner_dimensions.length.value, '1');
});

test('stocking joins mixed types and leaves unselected malformed geometry unread', () => {
  const request = {
    containers: [{ id: 'machine', made_to_measure: {}, cost_minor: 1 }, { id: 'machine', made_to_measure: {}, cost_minor: 9 }],
    fixed_placements: [{ container_type: 'machine', container_instance: 2 }],
  };
  const artifact = {
    work_order: { containers: [{ container_type: 'machine' }, { container_type: 'other' }, { container_type: 'machine' }, { container_type: 'machine' }] },
    geometry: { containers: [null, null, { inner_dimensions: { length: '1', width: '2', height: '3' } }] },
  };
  const stocked = stockCutBoxes(request, artifact, 1);
  assert.equal(stocked.containers[1].cost_minor, 9);
  assert.equal(stocked.containers[1].inner_dimensions.length.value, '1');
});
