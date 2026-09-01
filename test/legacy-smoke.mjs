import assert from 'node:assert/strict';

import { backend, pack, version } from '../index.js';

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
assert.equal(result.status, 'feasible');
assert.equal(result.complete, true);
assert.equal(result.summary.packed_item_count, 2);
assert.equal(result.summary.unpacked_item_count, 0);
assert.equal(result.containers.length, 1);

process.stdout.write('legacy Node smoke: PASS\n');
