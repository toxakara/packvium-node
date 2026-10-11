import assert from 'node:assert/strict';
import test from 'node:test';

import { __blockGroupForTests } from '../fallback.js';
import { compareCodePoints } from '../commerce-model.js';

/**
 * The block enumeration's shortcuts, held to the per-node walk they replaced.
 *
 * The block solver used to visit every lattice node of every (space, type, rotation)
 * group one by one, check the counted limits and the clock at each, and rank every node.
 * It now counts a group's nodes in closed form, finds the node a limit stops at from the
 * node indices alone, reads only each group's first largest count, and keeps a type's
 * tally per space until the type's capacity moves. Each reference below is the 1.6.0
 * code path written out plainly, and every case must agree with it exactly: the same
 * nodes, the same stop node, the same clock reads, the same leading block.
 */

const { nodes, stop, best, typeTally, space: blockSpace, subtract } = __blockGroupForTests;

// A deterministic stream of integers, so every run tries the same cases.
const stream = (seed) => {
  let state = seed >>> 0;
  return (low, high) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return low + (state % (high - low + 1));
  };
};

// A clock that has expired after its `reads`-th read, counting every read.
const clockExpiringAfter = (reads) => ({
  reads: 0,
  expired() { this.reads += 1; return this.reads > reads; },
});

// The 1.6.0 group walk: one node at a time, counted limits first, the clock every 64th.
const walkGroup = (maximumX, maximumY, maximumZ, capacity, start, stopAt, deadline) => {
  let visited = start, count = 0, bestNx = 0, bestNy = 0, bestNz = 0;
  for (let nx = 1; nx <= Math.min(maximumX, capacity); nx++) {
    for (let ny = 1; ny <= Math.min(maximumY, Math.floor(capacity / nx)); ny++) {
      if (visited >= stopAt || ((visited & 63) === 0 && deadline.expired())) return { stopped: visited };
      visited++;
      const nz = Math.min(maximumZ, Math.floor(capacity / (nx * ny)));
      if (nx * ny * nz > count) { count = nx * ny * nz; bestNx = nx; bestNy = ny; bestNz = nz; }
    }
  }
  return { stopped: -1, visited: visited - start, count, nx: bestNx, ny: bestNy, nz: bestNz };
};

test('a group is counted, stopped and ranked exactly as the per-node walk did', () => {
  const next = stream(7);
  for (let round = 0; round < 20_000; round++) {
    const maximumX = next(0, 14), maximumY = next(0, 14), maximumZ = next(0, 6), capacity = next(1, 48);
    const start = next(0, 300), stopAt = next(0, 3) === 0 ? Infinity : start + next(0, 120);
    const reads = next(0, 3) === 0 ? Infinity : next(0, 3);
    const referenceClock = clockExpiringAfter(reads);
    const reference = walkGroup(maximumX, maximumY, maximumZ, capacity, start, stopAt, referenceClock);
    const maximumNx = Math.min(maximumX, capacity), groupNodes = nodes(maximumNx, maximumY, capacity);
    const clock = clockExpiringAfter(reads), stoppedAt = stop(start, groupNodes, stopAt, clock);
    const where = { maximumX, maximumY, maximumZ, capacity, start, stopAt, reads };
    assert.equal(stoppedAt, reference.stopped, JSON.stringify(where));
    assert.equal(clock.reads, referenceClock.reads, JSON.stringify(where));
    if (reference.stopped >= 0) continue;
    assert.equal(groupNodes, reference.visited, JSON.stringify(where));
    const upper = Math.min(capacity, maximumNx * maximumY * maximumZ);
    if (upper === 0) { assert.equal(reference.count, 0, JSON.stringify(where)); continue; }
    const { count, nx, ny, nz } = best(maximumNx, maximumY, maximumZ, capacity, upper);
    assert.deepEqual([count, nx, ny, nz], [reference.count, reference.nx, reference.ny, reference.nz], JSON.stringify(where));
  }
});

test('a stop across many groups lands on the node one long walk would reach', () => {
  // Group boundaries do not matter: a run of groups stops where one walk over all of
  // their nodes stops, so a type or a space can be counted in one step.
  const next = stream(11);
  for (let round = 0; round < 2000; round++) {
    const sizes = Array.from({ length: next(1, 6) }, () => next(0, 90));
    const start = next(0, 200), stopAt = next(0, 2) === 0 ? Infinity : start + next(0, 300), reads = next(0, 4);
    const whole = stop(start, sizes.reduce((total, size) => total + size, 0), stopAt, clockExpiringAfter(reads));
    const clock = clockExpiringAfter(reads);
    let at = start, piecewise = -1;
    for (const size of sizes) {
      piecewise = stop(at, size, stopAt, clock);
      if (piecewise >= 0) break;
      at += size;
    }
    assert.equal(piecewise, whole, JSON.stringify({ sizes, start, stopAt, reads }));
  }
});

// The exact ranking key of the 1.6.0 block solver, for one block in one space.
const exactKey = (space, itemId, rotation, volume, count, nx, ny, nz, volumeFirst) => {
  const used = BigInt(count) * volume, fill = used * 1_000_000n / space.volume;
  const lead = volumeFirst ? [-used, -fill, -BigInt(count)] : [-BigInt(count), -fill, -used];
  return [...lead, space.z, space.y, space.x, itemId, rotation, nx, ny, nz];
};
const compareKeys = (left, right) => {
  for (let index = 0; index < left.length; index++) {
    const a = left[index], b = right[index];
    const difference = typeof a === 'string' ? compareCodePoints(a, b) : a < b ? -1 : a > b ? 1 : 0;
    if (difference) return difference;
  }
  return 0;
};
const ROTATIONS = { LWH: [0, 1, 2], WLH: [1, 0, 2], LHW: [0, 2, 1], HLW: [2, 0, 1], WHL: [1, 2, 0], HWL: [2, 1, 0] };

test('a type tally leads with the block the exact key ranks first, in either mode', () => {
  const next = stream(23);
  for (let round = 0; round < 3000; round++) {
    const d = [next(1, 9), next(1, 9), next(1, 9)], clear = next(0, 1);
    const names = Object.keys(ROTATIONS).filter(() => next(0, 2) > 0);
    if (!names.length) names.push('HWL');
    const lattices = names.map((rotation) => {
      const pd = ROTATIONS[rotation].map((axis) => d[axis]);
      return { rotation, pd, ed: pd.map((edge) => edge + 2 * clear), volume: BigInt(pd[0] * pd[1] * pd[2]) };
    });
    const space = blockSpace(next(0, 5), next(0, 5), next(0, 5), [next(1, 40), next(1, 40), next(1, 30)]);
    const capacity = next(1, 60), tally = new Array(7).fill(-1);
    typeTally(space, lattices, capacity, tally, 0);
    for (const volumeFirst of [false, true]) {
      let total = 0, leader = null, leaderLattice = -1, leaderGroup = null;
      lattices.forEach((lattice, index) => {
        if (lattice.ed[0] > space.d[0] || lattice.ed[1] > space.d[1]) return;
        const maximumX = Math.floor(space.d[0] / lattice.ed[0]), maximumY = Math.floor(space.d[1] / lattice.ed[1]);
        const maximumZ = Math.floor(space.d[2] / lattice.ed[2]);
        for (let nx = 1; nx <= Math.min(maximumX, capacity); nx++) {
          for (let ny = 1; ny <= Math.min(maximumY, Math.floor(capacity / nx)); ny++) {
            total++;
            const nz = Math.min(maximumZ, Math.floor(capacity / (nx * ny)));
            if (nz <= 0) continue;
            const key = exactKey(space, 'type', lattice.rotation, lattice.volume, nx * ny * nz, nx, ny, nz, volumeFirst);
            if (leader === null || compareKeys(key, leader) < 0) {
              leader = key; leaderLattice = index; leaderGroup = [nx * ny * nz, nx, ny, nz];
            }
          }
        }
      });
      const where = JSON.stringify({ d, clear, names, space: geometry([space]), capacity, volumeFirst });
      assert.equal(tally[0], capacity, where);
      assert.equal(tally[1], total, where);
      if (leader === null) { assert.equal(tally[2], 0, where); continue; }
      assert.deepEqual([tally[2], tally[3], tally[4], tally[5], tally[6]], [leaderGroup[0], leaderLattice, ...leaderGroup.slice(1)], where);
    }
  }
});

// The 1.6.0 carve: every survivor and slab keyed, repeats dropped through a Map.
const carveReference = (spaces, box) => {
  const volume = (d) => BigInt(d[0]) * BigInt(d[1]) * BigInt(d[2]);
  const intersects = (a, b) => a.x < b.x + b.d[0] && a.x + a.d[0] > b.x && a.y < b.y + b.d[1] && a.y + a.d[1] > b.y
    && a.z < b.z + b.d[2] && a.z + a.d[2] > b.z;
  const contains = (outer, inner) => outer.x <= inner.x && outer.y <= inner.y && outer.z <= inner.z
    && outer.x + outer.d[0] >= inner.x + inner.d[0] && outer.y + outer.d[1] >= inner.y + inner.d[1]
    && outer.z + outer.d[2] >= inner.z + inner.d[2];
  const out = [], fresh = new Set();
  const push = (x, y, z, X, Y, Z) => {
    if (X > x && Y > y && Z > z) { const part = { x, y, z, d: [X - x, Y - y, Z - z] }; out.push(part); fresh.add(part); }
  };
  for (const space of spaces) {
    const X = space.x + space.d[0], Y = space.y + space.d[1], Z = space.z + space.d[2];
    const bX = box.x + box.d[0], bY = box.y + box.d[1], bZ = box.z + box.d[2];
    if (!intersects(space, box)) { out.push(space); continue; }
    push(space.x, space.y, space.z, Math.min(X, box.x), Y, Z); push(Math.max(space.x, bX), space.y, space.z, X, Y, Z);
    push(space.x, space.y, space.z, X, Math.min(Y, box.y), Z); push(space.x, Math.max(space.y, bY), space.z, X, Y, Z);
    push(space.x, space.y, space.z, X, Y, Math.min(Z, box.z)); push(space.x, space.y, Math.max(space.z, bZ), X, Y, Z);
  }
  const unique = new Map(out.map((space) => [[space.x, space.y, space.z, ...space.d].join(':'), space]));
  const kept = [...unique.values()].sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x || (volume(a.d) > volume(b.d) ? -1 : 1));
  let result = kept.filter((space, index) => !fresh.has(space)
    || !kept.some((other, otherIndex) => index !== otherIndex && contains(other, space)));
  if (result.length > 256) {
    result = result.sort((a, b) => (volume(a.d) > volume(b.d) ? -1 : volume(a.d) < volume(b.d) ? 1 : a.z - b.z || a.y - b.y || a.x - b.x))
      .slice(0, 256).sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x);
  }
  return result;
};
const geometry = (spaces) => spaces.map((space) => [space.x, space.y, space.z, ...space.d].join(':'));

// The block scan writes this tally itself, without a call, for a space narrower than every
// rotation's footprint on one axis; it must be the tally `typeTally` would have written.
test('a space narrower than every rotation on one axis tallies as no nodes and no block', () => {
  const next = stream(29);
  let narrow = 0;
  for (let round = 0; round < 3000; round++) {
    const d = [next(1, 9), next(1, 9), next(1, 9)], clear = next(0, 1);
    const names = Object.keys(ROTATIONS).filter(() => next(0, 2) > 0);
    if (!names.length) names.push('HWL');
    const lattices = names.map((rotation) => {
      const pd = ROTATIONS[rotation].map((axis) => d[axis]);
      return { rotation, pd, ed: pd.map((edge) => edge + 2 * clear), volume: BigInt(pd[0] * pd[1] * pd[2]) };
    });
    const minimumX = Math.min(...lattices.map((lattice) => lattice.ed[0]));
    const minimumY = Math.min(...lattices.map((lattice) => lattice.ed[1]));
    const space = blockSpace(0, 0, 0, [next(1, 12), next(1, 12), next(1, 30)]);
    if (space.d[0] >= minimumX && space.d[1] >= minimumY) continue;
    narrow++;
    const capacity = next(1, 60), tally = new Array(7).fill(-1);
    typeTally(space, lattices, capacity, tally, 0);
    assert.deepEqual(tally, [capacity, 0, 0, -1, 0, 0, 0], JSON.stringify({ d, clear, names, d2: space.d }));
  }
  assert.ok(narrow > 500, `only ${narrow} narrow spaces drawn`);
});

test('carving keys only the slabs and keeps the spaces, and their order, it always kept', () => {
  const next = stream(41);
  for (let scene = 0; scene < 300; scene++) {
    const container = [next(10, 60), next(10, 60), next(10, 60)];
    let reference = [{ x: 0, y: 0, z: 0, d: container }], spaces = [blockSpace(0, 0, 0, container.slice())];
    for (let step = 0; step < 40 && spaces.length; step++) {
      // A block anchored at a space's origin, as the solver anchors every block.
      const anchor = spaces[next(0, spaces.length - 1)];
      const box = { x: anchor.x, y: anchor.y, z: anchor.z, d: anchor.d.map((edge) => next(1, edge)) };
      const metrics = { space_partitions: 0 };
      spaces = subtract(spaces, box, metrics);
      reference = carveReference(reference, box);
      assert.deepEqual(geometry(spaces), geometry(reference), JSON.stringify({ scene, step }));
      assert.ok(spaces.every((space) => space.volume === BigInt(space.d[0]) * BigInt(space.d[1]) * BigInt(space.d[2])));
      assert.ok(metrics.space_partitions > 0);
    }
  }
});
