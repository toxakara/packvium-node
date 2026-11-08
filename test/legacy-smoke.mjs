import assert from 'node:assert/strict';

import { backend, pack, packNested, version } from '../index.js';

const result = pack({
  items: [
    { id: 'a', quantity: 2, dimensions: { length: '10', width: '10', height: '10' } },
  ],
  containers: [
    { id: 'c', inner_dimensions: { length: '20', width: '10', height: '10' } },
  ],
});

assert.ok(['rust', 'javascript'].includes(backend()));
assert.equal(typeof version(), 'string');
// Two cubes fill the container exactly, so the 1.8 optimality check proves the answer optimal.
assert.equal(result.status, 'optimal');
assert.equal(result.optimality.code, 'proven_optimal');
assert.equal(result.complete, true);
assert.equal(result.summary.packed_item_count, 2);
assert.equal(result.summary.unpacked_item_count, 0);
assert.equal(result.containers.length, 1);

// The cheaper carton set is the only one the tower takes; a beam of two finds it.
const cube = { id: 'cube', quantity: 2, dimensions: { length: '100', width: '100', height: '100' } };
const box = (id, length, height) => ({ id, inner_dimensions: { length, width: '100', height } });
const nested = packNested({
  levelBeamWidth: 2,
  levels: [
    { name: 'carton', request: { items: [cube], containers: [box('long', '200', '100'), box('single', '100', '100')] } },
    { name: 'pallet', request: { items: [], containers: [box('tower', '100', '200')] } },
  ],
});
assert.deepEqual(nested.levels.map((level) => [level.name, level.result.complete]), [['carton', true], ['pallet', true]]);
assert.deepEqual(nested.levels[0].result.containers.map((container) => container.container_type), ['single', 'single']);

process.stdout.write('legacy Node smoke: PASS\n');
