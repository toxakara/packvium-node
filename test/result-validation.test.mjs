/**
 * `validate(request, result)`: the reference validator, through the compiled addon.
 *
 * The addon returns one JSON document, `{issues}` or `{refusal: {kind, message}}`, so a
 * refusal's `kind` survives the boundary; `validateWith` turns that into the package's own
 * `MalformedResult`. Without an addon the package's JavaScript port answers.
 * Issue-for-issue agreement with `packvium.validate` over the whole conformance corpus is
 * `conformance/result_validation/run.py`'s job; this pins the wrapper.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  MalformedResult,
  ValidatorUnavailableError,
  backend,
  pack,
  validate,
  validateWith,
} from '@packvium/engine';

const REQUEST = {
  items: [{ id: 'cube', quantity: 2, dimensions: { length: '10', width: '10', height: '10' } }],
  containers: [{ id: 'box', inner_dimensions: { length: '20', width: '10', height: '10' } }],
};

const require = createRequire(import.meta.url);

/** The compiled addon when one is loadable, else `null`. */
function loadNative() {
  // The same specifiers `force-fallback.cjs` blocks, so a run pinned to the fallback never
  // loads the addon here.
  for (const candidate of ['./packvium-native.node', '../../packvium-rust/bindings/node']) {
    try { return require(candidate); } catch { /* not built or blocked */ }
  }
  return null;
}

/** Every validator this host can run: the JavaScript port always, the addon when built. */
function validators() {
  const native = loadNative();
  return [['javascript', null], ...(native?.validateJson ? [['addon', native]] : [])];
}

const answering = (outcome) => ({ validateJson: () => JSON.stringify(outcome) });

test('the addon\'s issues are returned as they came', () => {
  const issues = [{ code: 'collision', detail: 'cube#1 with cube#2 in box#1' }];
  assert.deepEqual(validateWith(answering({ issues }), REQUEST, {}), issues);
});

test('a refusal becomes a MalformedResult carrying its kind', () => {
  const binding = answering({ refusal: { kind: 'contract', message: "result is missing 'status'" } });
  assert.throws(() => validateWith(binding, REQUEST, {}), (error) => {
    assert.ok(error instanceof MalformedResult);
    assert.equal(error.message, "result is missing 'status'");
    assert.equal(error.kind, 'contract');
    return true;
  });
});

test('without the addon, the JavaScript port answers', () => {
  const result = pack(REQUEST);
  assert.deepEqual(validateWith(null, REQUEST, result), []);
  assert.deepEqual(validateWith({}, REQUEST, result), []);
  const broken = JSON.parse(JSON.stringify(result));
  const placements = broken.containers[0].placements;
  placements[1].position = JSON.parse(JSON.stringify(placements[0].position));
  assert.deepEqual(validateWith(null, REQUEST, broken).map((issue) => issue.code), ['collision']);
  if (backend() === 'javascript') assert.deepEqual(validate(REQUEST, result), []);
});

test('the port refuses what it cannot judge as a MalformedResult carrying its kind', () => {
  assert.throws(() => validateWith(null, REQUEST, {}), (error) => {
    assert.ok(error instanceof MalformedResult);
    assert.equal(error.message, "result is missing 'status'");
    assert.equal(error.kind, 'contract');
    return true;
  });
  assert.throws(() => validateWith(null, undefined, pack(REQUEST)), (error) => error.kind === 'shape');
});

test('ValidatorUnavailableError is still exported, though nothing throws it', () => {
  const error = new ValidatorUnavailableError();
  assert.equal(error.code, 'validator_unavailable');
  assert.equal(error.name, 'ValidatorUnavailableError');
});

test('the real addon judges a packed result valid and a broken one not', (t) => {
  const native = loadNative();
  if (!native?.validateJson) {
    t.skip('no native addon exporting validateJson is loadable here');
    return;
  }
  const result = pack(REQUEST);
  assert.deepEqual(validateWith(native, REQUEST, result), []);
  const broken = structuredClone(result);
  const placements = broken.containers[0].placements;
  placements[1].position = structuredClone(placements[0].position);
  assert.deepEqual(validateWith(native, REQUEST, broken).map((issue) => issue.code), ['collision']);
});

// (audit F5): the void-fill reserve is `floor(volume * ppm / 10^6)` with the solvers'
// double conversion of the ratio. `0.0001245` is 124 ppm there where the exact decimal rounds
// to 125, so a 10^7 cubic tick container reserves 1240 ticks, not 1250.
for (const [name, native] of validators()) test(`the ${name} validator judges the void-fill reserve by the solvers' ppm rule`, () => {
  const request = {
    units: { length: 'tick' },
    items: [{ id: 'bar', quantity: 1, allowed_rotations: ['LWH'], dimensions: { length: '1', width: '1', height: '1' } }],
    containers: [{ id: 'box', void_fill_reserve_ratio: 0.0001245,
      inner_dimensions: { length: '1', width: '10000000', height: '1' } }],
  };
  const result = pack(request);
  assert.equal(result.containers[0].void_fill_reserve_ticks3, '1240');
  assert.deepEqual(validateWith(native, request, result), []);
  const widened = (width) => {
    const edited = structuredClone(result);
    const container = edited.containers[0];
    container.placements[0].dimensions.width = { ticks: width, value: String(width), unit: 'tick' };
    container.used_volume_ticks3 = String(width);
    const widenedRequest = structuredClone(request);
    widenedRequest.items[0].dimensions.width = String(width);
    return validateWith(native, widenedRequest, edited)
      .filter((issue) => issue.code.startsWith('void_fill_reserve'))
      .map((issue) => `${issue.code}: ${issue.detail}`);
  };
  assert.deepEqual(widened(9_998_760), []);
  assert.deepEqual(widened(9_998_761), ['void_fill_reserve_exceeded: box#1: used 9998761 > usable 9998760']);
});

// `compression_ratio` goes through the same conversion. A 5 kg brick holds a 1 m
// compressible pad at half its 10 kPa limit, where one ppm moves the occupied height by about
// eight ticks, so 0.0001245 must compress exactly as 0.000124 does.
for (const [name, native] of validators()) test(`the ${name} validator judges compression by the solvers' ppm rule`, () => {
  const request = (ratio) => ({
    items: [
      { id: 'pad', quantity: 1, must_be_on_floor: true, allowed_rotations: ['LWH'],
        dimensions: { length: '100', width: '100', height: '1000' },
        shape_type: 'compressible', compression_ratio: ratio, max_compression_pressure_kpa: 10 },
      { id: 'brick', quantity: 1, allowed_rotations: ['LWH'],
        dimensions: { length: '100', width: '100', height: '10' }, weight: { value: '5', unit: 'kg' } },
    ],
    containers: [{ id: 'box', inner_dimensions: { length: '100', width: '100', height: '2000' } }],
  });
  const result = pack(request(0.0001245));
  assert.equal(result.containers[0].used_volume_ticks3, pack(request(0.000124)).containers[0].used_volume_ticks3);
  assert.deepEqual(validateWith(native, request(0.0001245), result), []);
});
