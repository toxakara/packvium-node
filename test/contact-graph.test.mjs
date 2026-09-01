import test from 'node:test';
import assert from 'node:assert/strict';
import { appendContactBox, buildContactGraph } from '../contact-graph.js';

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

// ----------------------------------------------------- incremental append

/**
 * A scene whose boxes actually touch each other, from a replayable generator.
 *
 * What is under test is that a delta reproduces edges, so a corpus of scenes that mostly
 * have no edges at all would pass with the delta returning nothing. Snapping every
 * coordinate and extent to one coarse lattice makes shared planes the norm.
 */
const lcg = seed => {
  let state = BigInt(seed);
  return bound => {
    state = (state * 6364136223846793005n + 1n) & 0xffffffffffffffffn;
    return Number((state >> 33n) % BigInt(bound));
  };
};

const touchingScene = (next, count) => {
  const extents = [10, 20, 30];
  return Array.from({ length: count }, () => ({
    x: next(6) * 10, y: next(6) * 10, z: next(4) * 10,
    d: [extents[next(3)], extents[next(3)], extents[next(3)]],
  }));
};

const widestFootprint = boxes => Math.max(1, ...boxes.map(box => Math.max(box.d[0], box.d[1])));
const edges = graph => [graph.supporters, graph.children];

test('appending a box matches building the whole scene at once', () => {
  // The base carries the widest footprint in the scene as its hint, which is what a
  // solver knows before it starts placing: the candidate about to be appended may be
  // larger than anything already placed, and sizing the broad phase from the placed boxes
  // alone would send every append into the fallback.
  for (let seed = 0; seed < 40; seed++) {
    const next = lcg(2000 + seed);
    const boxes = touchingScene(next, 2 + next(13));
    const split = Math.max(1, Math.floor(boxes.length / 2));
    const hint = widestFootprint(boxes);
    const base = buildContactGraph(boxes.slice(0, split), overlapXY, hint);
    let graph = base;
    for (const box of boxes.slice(split)) graph = appendContactBox(graph, box, overlapXY);
    // A full rebuild recounts its broad-phase probes; the delta path carries the base's
    // count forward untouched. So an unchanged count is what says the delta ran -- without
    // it, an assertion that the two graphs match is equally satisfied by an append that
    // quietly rebuilds everything, which is none of the point.
    assert.equal(graph.candidateChecks, base.candidateChecks, `seed ${seed} fell back`);
    assert.deepEqual(edges(graph), edges(buildContactGraph(boxes, overlapXY)), `seed ${seed}`);
  }
});

test('a box wider than the hint rebuilds and is still correct', () => {
  // The hint is an optimisation; being wrong about it may cost time, never an answer.
  const small = [
    { x: 0, y: 0, z: 0, d: [10, 10, 10] },
    { x: 10, y: 0, z: 0, d: [10, 10, 10] },
  ];
  const wide = { x: 0, y: 0, z: 10, d: [40, 10, 10] };
  const base = buildContactGraph(small, overlapXY);
  const graph = appendContactBox(base, wide, overlapXY);
  assert.notEqual(graph.candidateChecks, base.candidateChecks);
  assert.deepEqual(graph.supporters[2].map(([index]) => index), [0, 1]);
  assert.deepEqual(edges(graph), edges(buildContactGraph([...small, wide], overlapXY)));
});

test('an appended box lands last in the lists it joins', () => {
  // The new box always takes the highest index, so appending it to an existing supporter
  // list keeps that list ascending -- but only because it is appended and not inserted,
  // which a from-scratch comparison on random scenes can miss when no scene happens to
  // produce the collision.
  const scene = [
    { x: 0, y: 0, z: 0, d: [10, 10, 10] },
    { x: 0, y: 0, z: 10, d: [20, 10, 10] },
    { x: 10, y: 0, z: 0, d: [10, 10, 10] },
  ];
  const graph = appendContactBox(
    buildContactGraph(scene, overlapXY, 20), { x: 0, y: 0, z: 20, d: [10, 10, 10] }, overlapXY);
  assert.deepEqual(graph.supporters[1].map(([index]) => index), [0, 2]);
  assert.deepEqual(graph.children[1], [3]);
});

test('appending leaves the base graph untouched', () => {
  // The base is shared across every candidate evaluated against one search state, so an
  // append that wrote through to it would corrupt each candidate for the next.
  const base = buildContactGraph([{ x: 0, y: 0, z: 0, d: [10, 10, 10] }], overlapXY, 10);
  appendContactBox(base, { x: 0, y: 0, z: 10, d: [10, 10, 10] }, overlapXY);
  assert.equal(base.boxes.length, 1);
  assert.deepEqual(base.children[0], []);
});

test('the delta matches a rebuild across scene shapes', () => {
  // The property test above asserts the base's candidateChecks is carried forward, which
  // proves the delta ran rather than quietly rebuilding -- and therefore never exercises a
  // run where the fallback and the delta interleave. A cell hint of one produces exactly
  // that, several times per scene.
  //
  // Three axes vary independently. Tight coordinates make shared planes and zero-area edge
  // contacts the norm; coordinates at 1e9 push the broad phase's cell arithmetic somewhere
  // a lattice never goes; a huge hint collapses every box into one cell, which is the
  // degenerate case the hash exists to avoid and therefore the one most likely to be wrong.
  const tight = [0, 1, 2, 5, 10];
  const wide = [0, 10, 100, 1e9];
  const tiny = [1, 2, 3];
  const mixed = [1, 5, 10, 40];
  const shapes = [
    ['tight/tiny/exact', tight, tiny, 'exact'],
    ['tight/tiny/one', tight, tiny, 'one'],
    ['tight/mixed/one', tight, mixed, 'one'],
    ['tight/mixed/huge', tight, mixed, 'huge'],
    ['wide/mixed/exact', wide, mixed, 'exact'],
    ['wide/mixed/one', wide, mixed, 'one'],
    ['wide/tiny/huge', wide, tiny, 'huge'],
  ];

  shapes.forEach(([name, coordinates, extents, hintMode], shapeIndex) => {
    const next = lcg(7000 + shapeIndex);
    for (let trial = 0; trial < 60; trial++) {
      const count = 1 + next(10);
      const boxes = Array.from({ length: count }, () => ({
        x: coordinates[next(coordinates.length)],
        y: coordinates[next(coordinates.length)],
        z: coordinates[next(coordinates.length)],
        d: [extents[next(extents.length)], extents[next(extents.length)], extents[next(extents.length)]],
      }));
      const widest = widestFootprint(boxes);
      const hint = hintMode === 'exact' ? widest : hintMode === 'one' ? 1 : widest * 100;
      const split = Math.max(1, Math.floor(count / 2));
      let graph = buildContactGraph(boxes.slice(0, split), overlapXY, hint);
      for (const box of boxes.slice(split)) graph = appendContactBox(graph, box, overlapXY);
      assert.deepEqual(edges(graph), edges(buildContactGraph(boxes, overlapXY)),
        `${name} trial ${trial}`);
    }
  });
});

