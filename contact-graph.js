/**
 * Direct vertical-contact graph with a deterministic XY broad phase.
 *
 * Construction is expected O(n + q + e): q broad-phase candidates plus e real
 * contact edges. A physically dense graph can still have e=O(n²), which no exact
 * representation can avoid. The exact overlap function remains authoritative.
 * This module is package-internal: package.json exports only the root entry point.
 */
export function buildContactGraph(boxes, overlapXY) {
  const supporters = boxes.map(() => []);
  const children = boxes.map(() => []);
  if (boxes.length === 0) return { supporters, children, candidateChecks: 0 };

  const cell = Math.max(1, ...boxes.map(box => Math.max(box.d[0], box.d[1])));
  const byTop = new Map();
  const levels = new Map();
  const cells = box => {
    const x1 = Math.floor(box.x / cell);
    const x2 = Math.floor((box.x + box.d[0] - 1) / cell);
    const y1 = Math.floor(box.y / cell);
    const y2 = Math.floor((box.y + box.d[1] - 1) / cell);
    return [...new Set([`${x1}:${y1}`, `${x2}:${y1}`, `${x1}:${y2}`, `${x2}:${y2}`])];
  };

  boxes.forEach((box, index) => {
    const top = box.z + box.d[2];
    if (!byTop.has(top)) byTop.set(top, []);
    byTop.get(top).push(index);
  });

  let candidateChecks = 0;
  boxes.forEach((upper, upperIndex) => {
    const candidates = byTop.get(upper.z);
    if (!candidates) return;
    let level = levels.get(upper.z);
    if (level == null) {
      level = new Map();
      for (const index of candidates) {
        for (const key of cells(boxes[index])) {
          if (!level.has(key)) level.set(key, []);
          level.get(key).push(index);
        }
      }
      levels.set(upper.z, level);
    }
    const nearby = new Set();
    for (const key of cells(upper)) {
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
  return { supporters, children, candidateChecks };
}
