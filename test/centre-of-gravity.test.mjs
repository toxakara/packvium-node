import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FixedPlacementError,
  __centreOfGravitySupportedForTests as supported,
  packFallback,
} from '../fallback.js';

// The same centroid-in-hull rule Python's and PHP's SupportConstraint apply.
const box = (x, y, length, width) => ({ x, y, z: 0, d: [length, width, 10] });

test('a centroid beyond a single end support is unsupported', () => {
  assert.equal(supported(box(0, 0, 100, 10), [box(0, 0, 30, 10)]), false);
});

test('supports at both ends carry the centroid', () => {
  assert.equal(supported(box(0, 0, 100, 10), [box(0, 0, 20, 10), box(80, 0, 20, 10)]), true);
});

test('an odd extent keeps the centroid exact', () => {
  assert.equal(supported(box(0, 0, 101, 10), [box(0, 0, 51, 10)]), true);
  assert.equal(supported(box(0, 0, 101, 10), [box(0, 0, 50, 10)]), false);
});

test('a supporter that only touches an edge carries nothing', () => {
  assert.equal(supported(box(0, 0, 10, 10), [box(10, 0, 10, 10)]), false);
});

test('duplicate corners from adjacent supporters collapse', () => {
  assert.equal(supported(box(0, 0, 20, 10), [box(0, 0, 10, 10), box(10, 0, 10, 10)]), true);
});

test('a one-tick knife edge under the centroid carries the box', () => {
  assert.equal(supported(box(0, 0, 10, 10), [box(5, 0, 1, 10)]), true);
  assert.equal(supported(box(0, 0, 10, 10), [box(6, 0, 1, 10)]), false);
});

test('a supporter wider than the footprint is clipped to it', () => {
  assert.equal(supported(box(10, 10, 10, 10), [box(0, 0, 100, 100)]), true);
});

test('a corner square whose inner corner is the centroid carries it', () => {
  assert.equal(supported(box(0, 0, 40, 40), [box(0, 0, 20, 20)]), true);
  assert.equal(supported(box(0, 0, 40, 40), [box(0, 0, 20, 19)]), false);
});

const legsOnACircle = (keep) => Array.from({ length: 360 }, (_, degree) => degree * Math.PI / 180)
  .filter(keep)
  .map((angle) => box(Math.round(500 + 400 * Math.cos(angle)), Math.round(500 + 400 * Math.sin(angle)), 1, 1));

test('three hundred and sixty legs on a circle carry the centroid', () => {
  assert.equal(supported(box(0, 0, 1000, 1000), legsOnACircle(() => true)), true);
});

test('legs on half a circle leave the centroid hanging', () => {
  assert.equal(supported(box(0, 0, 1000, 1000), legsOnACircle((angle) => Math.sin(angle) > 0.1)), false);
});

test('repeated and reordered supporters give the same answer', () => {
  const legs = [box(0, 0, 5, 5), box(35, 0, 5, 5), box(0, 35, 5, 5)];
  for (const order of [legs, [...legs].reverse(), [...legs, ...legs]]) {
    assert.equal(supported(box(0, 0, 40, 40), order), true);
  }
});

test('the largest safe integers keep a half-tick centroid exact', () => {
  const far = Number.MAX_SAFE_INTEGER - 1000;
  assert.equal(supported(box(far, far, 101, 10), [box(far, far, 51, 10)]), true);
  assert.equal(supported(box(far, far, 101, 10), [box(far, far, 50, 10)]), false);
});

test('safe translations preserve an exact half-tick centroid', () => {
  const fixture = JSON.parse(readFileSync(new URL(
    './fixtures/centre-of-gravity-safe-integer-frontier.json', import.meta.url,
  ), 'utf8'));
  for (const [dx, dy] of fixture.translations) {
    for (const entry of fixture.cases) {
      const translate = ([x, y, length, width]) => box(x + dx, y + dy, length, width);
      const candidate = translate(entry.probe);
      assert.ok([candidate.x, candidate.y, candidate.x + candidate.d[0],
        candidate.y + candidate.d[1]].every(Number.isSafeInteger));
      assert.equal(supported(candidate, entry.supporters.map(translate)), entry.supported,
        `translation ${dx},${dy}; probe ${entry.probe}; supports ${entry.supporters}`);
    }
  }
});

test('fixed placement admission refuses an overhanging centre of gravity', () => {
  const request = {
    configuration: { minimum_support_ratio: 0.25 },
    items: [{
      id: 'cube',
      quantity: 2,
      dimensions: { length: '100', width: '100', height: '100' },
    }],
    containers: [{
      id: 'box',
      inner_dimensions: { length: '200', width: '200', height: '200' },
    }],
    fixed_placements: [
      { item_type: 'cube', container_type: 'box', orientation: 'LWH', position: { x: '0', y: '0', z: '0' } },
      { item_type: 'cube', container_type: 'box', orientation: 'LWH', position: { x: '60', y: '0', z: '100' } },
    ],
  };
  assert.throws(
    () => packFallback(request),
    (error) => error instanceof FixedPlacementError
      && error.message.startsWith('invalid_fixed_placement: centre_of_gravity_unsupported: cube#2:'),
  );
});
