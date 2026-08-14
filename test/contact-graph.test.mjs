import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContactGraph } from '../contact-graph.js';

const overlapXY = (left, right) => {
  const x = Math.max(0, Math.min(left.x + left.d[0], right.x + right.d[0]) - Math.max(left.x, right.x));
  const y = Math.max(0, Math.min(left.y + left.d[1], right.y + right.d[1]) - Math.max(left.y, right.y));
  return x * y;
};

test('a regular lattice contact graph stays linear in exact overlap checks', () => {
  const boxes = [];
  for (let layer = 0; layer < 2; layer++) {
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) boxes.push({ x: x * 10, y: y * 10, z: layer * 10, d: [10, 10, 10] });
    }
  }
  const graph = buildContactGraph(boxes, overlapXY);
  assert.equal(graph.candidateChecks, 1024);
  assert.deepEqual(graph.supporters[1024], [[0, 100]]);
  assert.deepEqual(graph.children[0], [1024]);
});

test('the broad phase produces the exact same edges as a pairwise scan', () => {
  const boxes = [
    { x: 0, y: 0, z: 0, d: [10, 10, 10] },
    { x: 10, y: 0, z: 0, d: [10, 10, 10] },
    { x: 5, y: 0, z: 10, d: [10, 10, 10] },
    { x: 30, y: 0, z: 10, d: [10, 10, 10] },
  ];
  const graph = buildContactGraph(boxes, overlapXY);
  const expected = boxes.map((upper, upperIndex) => boxes.flatMap((lower, lowerIndex) => {
    const area = overlapXY(lower, upper);
    return lowerIndex !== upperIndex && lower.z + lower.d[2] === upper.z && area > 0
      ? [[lowerIndex, area]] : [];
  }));
  assert.deepEqual(graph.supporters, expected);
});
