import assert from 'node:assert/strict';
import test from 'node:test';

import { packFallback } from '../fallback.js';

/**
 * `container.access_directions` at its boundaries.
 *
 * The field was reserved at the 1.1.0 freeze and implemented in all four engines in one
 * change. What shipped beside the packing rule is a validate-and-canonicalise step per
 * engine, and coverage showed that step untested in every one of them: the shared corpus
 * exercises one well-formed door list and nothing else.
 *
 * Canonicalisation is the half a fixture cannot assert. Every fixture states its doors
 * once, in one order, so a normalisation that quietly stopped working leaves all 399
 * fixtures green while making this engine order-sensitive — a determinism break, which is
 * a correctness failure here rather than a preference.
 *
 * This engine is also the one with no configuration object to hang a default on, so a
 * container states its doors or the rule stays inert. That makes the decode path the only
 * way in, and therefore the only place these rules can be checked at all.
 */

const request = (doors) => {
  const container = {
    id: 'van',
    inner_dimensions: { length: '200', width: '100', height: '100' },
  };
  if (doors !== undefined) container.access_directions = doors;
  return {
    units: { length: 'mm' },
    items: [{
      id: 'cube', quantity: 1,
      dimensions: { length: '100', width: '100', height: '100' },
    }],
    containers: [container],
  };
};

/**
 * Everything the contract promises to reproduce.
 *
 * `algorithm.duration_ms` is wall clock and is the one field a determinism assertion must
 * not read: comparing whole documents passes or fails on how busy the machine is, which
 * reports the host rather than the engine.
 */
const withoutWallClock = (doors) => {
  const result = packFallback(request(doors));
  const { duration_ms: _ignored, ...algorithm } = result.algorithm;
  return { ...result, algorithm };
};

const refusal = (doors) => {
  try {
    packFallback(request(doors));
  } catch (error) {
    return error;
  }
  return null;
};

// ------------------------------------------------------------------ canonicalisation

test('doors are deduplicated into the canonical order', () => {
  assert.deepEqual(withoutWallClock(['+z', '-x', '+z', '-x']), withoutWallClock(['-x', '+z']));
});

test('a request naming doors in either order gives one answer', () => {
  assert.deepEqual(withoutWallClock(['-x', '+z']), withoutWallClock(['+z', '-x']));
});

test('every legal direction is accepted', () => {
  assert.ok(packFallback(request(['-z', '+z', '-y', '+y', '-x', '+x'])).status);
});

// A container that names no doors is the pre-default: the rule is inert, not the
// container sealed. `[]` is a caller saying "no doors stated" rather than a malformed
// request, so it has to behave exactly like the absent field — otherwise the two spellings
// of one default diverge.
test('an empty door list is accepted and matches the absent field', () => {
  assert.deepEqual(withoutWallClock([]), withoutWallClock(undefined));
});

// ------------------------------------------------------------------------- refusals

// Refused, not filtered out. Silently discarding an unrecognised door would leave a
// container with fewer exits than the caller believes it has, and the packing would then
// be legal for a vehicle that does not exist.
test('an unknown direction is refused rather than dropped', () => {
  for (const direction of ['north', 'x', '+X', '+w', '', '-x ']) {
    const error = refusal([direction]);
    assert.ok(error, `${JSON.stringify(direction)} should be refused, not dropped`);
    assert.equal(error.code, 'invalid_direction');
    assert.match(error.message, /unknown movement direction/);
  }
});

// A partially honoured list is the worst outcome available: it validates and means
// something the caller did not write.
test('one bad direction refuses the whole list', () => {
  const error = refusal(['-x', 'sideways', '+z']);
  assert.ok(error);
  assert.equal(error.code, 'invalid_direction');
});

test('a non-string entry is refused', () => {
  for (const entry of [1, null, ['-x'], {}]) {
    const error = refusal([entry]);
    assert.ok(error, `${JSON.stringify(entry)} should be refused`);
    assert.equal(error.code, 'invalid_direction');
  }
});
