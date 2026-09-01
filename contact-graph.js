/**
 * Direct vertical-contact graph with a deterministic XY broad phase.
 *
 * Construction is expected O(n + q + e): q broad-phase candidates plus e real
 * contact edges. A physically dense graph can still have e=O(n²), which no exact
 * representation can avoid. The exact overlap function remains authoritative.
 * This module is package-internal: package.json exports only the root entry point.
 */

/**
 * The at-most-four cells `box` occupies.
 *
 * `cell` must be at least as large as the largest footprint dimension of every box
 * hashed into the index or queried against it -- not just the ones being indexed. Only
 * then is a box guaranteed to span no more than a 2x2 block, which is what makes two
 * overlapping boxes always share a cell. Sizing it from the indexed boxes alone would be
 * exactly wrong: a larger querying box could step over cells in the middle of its own
 * footprint and silently miss a real overlap.
 */
function cellsOf(box, cell) {
  const x1 = Math.floor(box.x / cell);
  const x2 = Math.floor((box.x + box.d[0] - 1) / cell);
  const y1 = Math.floor(box.y / cell);
  const y2 = Math.floor((box.y + box.d[1] - 1) / cell);
  return [...new Set([`${x1}:${y1}`, `${x2}:${y1}`, `${x1}:${y2}`, `${x2}:${y2}`])];
}

function bucketsByPlane(boxes, plane) {
  const byPlane = new Map();
  boxes.forEach((box, index) => {
    const key = plane(box);
    if (!byPlane.has(key)) byPlane.set(key, []);
    byPlane.get(key).push(index);
  });
  return byPlane;
}

const topOf = box => box.z + box.d[2];
const bottomOf = box => box.z;

function levelIndex(boxes, indices, cell) {
  const level = new Map();
  for (const index of indices) {
    for (const key of cellsOf(boxes[index], cell)) {
      if (!level.has(key)) level.set(key, []);
      level.get(key).push(index);
    }
  }
  return level;
}

/**
 * Every box in `buckets` on `plane` that really overlaps `box`, ascending by index.
 *
 * Ascending order is contract, not presentation: `topLoads` splits a conserved integer
 * across the supporter list and hands the rounding remainder to whichever edge is last.
 */
function overlapsOnPlane(graph, buckets, cache, plane, box, overlapXY) {
  const indices = buckets.get(plane);
  if (!indices) return [];
  let level = cache.get(plane);
  if (level == null) {
    level = levelIndex(graph.boxes, indices, graph.cell);
    cache.set(plane, level);
  }
  const nearby = new Set();
  for (const key of cellsOf(box, graph.cell)) {
    for (const index of level.get(key) ?? []) nearby.add(index);
  }
  const found = [];
  for (const other of [...nearby].sort((left, right) => left - right)) {
    const area = overlapXY(graph.boxes[other], box);
    if (area > 0) found.push([other, area]);
  }
  return found;
}

/**
 * `cellHint` is an upper bound on the footprint of any box that may later be appended
 * with `appendContactBox`.
 *
 * Without it the cell is sized from the boxes present now, and appending anything wider
 * has to fall back to a full rebuild -- correct, but it defeats the point, because in a
 * search the base is what is already placed and the candidate is a *new* item that may
 * well be the widest in the request. A caller that knows the item set passes its widest
 * footprint once and the delta path then always applies. Too large a hint only makes
 * each bucket coarser; too small a one cannot give a wrong answer, because the fallback
 * covers it.
 */
export function buildContactGraph(boxes, overlapXY, cellHint = 1) {
  const supporters = boxes.map(() => []);
  const children = boxes.map(() => []);
  const cell = Math.max(1, cellHint, ...boxes.map(box => Math.max(box.d[0], box.d[1])));
  const byTop = bucketsByPlane(boxes, topOf);
  const byBottom = bucketsByPlane(boxes, bottomOf);
  const topLevels = new Map();
  let candidateChecks = 0;

  boxes.forEach((upper, upperIndex) => {
    const candidates = byTop.get(upper.z);
    if (!candidates) return;
    let level = topLevels.get(upper.z);
    if (level == null) {
      level = levelIndex(boxes, candidates, cell);
      topLevels.set(upper.z, level);
    }
    const nearby = new Set();
    for (const key of cellsOf(upper, cell)) {
      for (const index of level.get(key) ?? []) nearby.add(index);
    }
    for (const lowerIndex of [...nearby].sort((left, right) => left - right)) {
      if (lowerIndex === upperIndex) continue;
      candidateChecks++;
      const area = overlapXY(boxes[lowerIndex], upper);
      if (area > 0) {
        supporters[upperIndex].push([lowerIndex, area]);
        children[lowerIndex].push(upperIndex);
      }
    }
  });
  // The downward-facing indexes stay empty here: only an append queries them, and a graph
  // built once and read once would otherwise pay for an index nothing looks at.
  return { supporters, children, candidateChecks, boxes, cell, byTop, byBottom, topLevels,
           bottomLevels: new Map() };
}

/**
 * `graph` plus one more box, appended at the next index.
 *
 * Adding a box cannot create or destroy contact between two boxes already in the graph:
 * contact is a pairwise geometric predicate over two boxes and nothing else. That is the
 * whole reason a delta is sound, and it is why only the new box's own two planes are
 * queried instead of every box being re-examined.
 *
 * The result is required to be identical to `buildContactGraph([...boxes, box])`, not
 * merely equivalent -- see `overlapsOnPlane` on why edge order is contract. The new box
 * takes the highest index, so appending it to an existing list keeps that list ascending.
 *
 * `graph` is not modified: the returned graph shares every edge list the append did not
 * touch, and copies the two or three it did.
 */
export function appendContactBox(graph, box, overlapXY) {
  const index = graph.boxes.length;
  const footprint = Math.max(box.d[0], box.d[1]);
  if (footprint > graph.cell) {
    // The broad phase is only correct while its cell covers every box hashed into it or
    // queried against it, so this is a correctness fallback, not an optimisation choice.
    return buildContactGraph([...graph.boxes, box], overlapXY, footprint);
  }

  const below = overlapsOnPlane(graph, graph.byTop, graph.topLevels, box.z, box, overlapXY);
  const above = overlapsOnPlane(graph, graph.byBottom, graph.bottomLevels, topOf(box), box, overlapXY);

  const supporters = graph.supporters.slice();
  const children = graph.children.slice();
  supporters.push(below.map(([lower, area]) => [lower, area]));
  children.push(above.map(([upper]) => upper));
  for (const [lower] of below) children[lower] = [...children[lower], index];
  for (const [upper, area] of above) supporters[upper] = [...supporters[upper], [index, area]];

  // One box joins exactly two planes, so only those two buckets change, and only the two
  // level indexes describing them are invalidated. A level index is never mutated after
  // it is built, so every other one is shared with the base rather than rebuilt.
  const byTop = new Map(graph.byTop);
  byTop.set(topOf(box), [...(byTop.get(topOf(box)) ?? []), index]);
  const byBottom = new Map(graph.byBottom);
  byBottom.set(box.z, [...(byBottom.get(box.z) ?? []), index]);
  const topLevels = new Map(graph.topLevels);
  topLevels.delete(topOf(box));
  const bottomLevels = new Map(graph.bottomLevels);
  bottomLevels.delete(box.z);

  return { supporters, children, candidateChecks: graph.candidateChecks,
           boxes: [...graph.boxes, box], cell: graph.cell, byTop, byBottom, topLevels, bottomLevels };
}
