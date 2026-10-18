import assert from 'node:assert/strict';
import test from 'node:test';

import { __resultWriterForTests } from '../fallback.js';

/**
 * Two result-writer shortcuts, held to the paths they bypass.
 *
 * `decimalString` renders a safe-integer tick count in Number arithmetic; the BigInt long
 * division it skips (written out below as it stood in 1.6.0) must give the same text for
 * every value, unit and rounding tie, whether the count arrives as a Number or a BigInt.
 * `usedVolume` scans only nesting placements for overlapping pairs; the every-pair scan it
 * replaced must give the same exact volume.
 */

const { decimalString, usedVolume, validNesting, occupiedVolume } = __resultWriterForTests;

const stream = (seed) => {
  let state = seed >>> 0;
  return (low, high) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return low + (state % (high - low + 1));
  };
};

// The 1.6.0 BigInt long division, written out plainly: the reference for every value.
const bigIntDecimalString = (ticks, divisor, places = 8) => {
  const negative = ticks < 0n; if (negative) ticks = -ticks; const div = BigInt(divisor);
  let whole = ticks / div, remainder = ticks % div, digits = '';
  for (let i = 0; i < places; i++) { remainder *= 10n; digits += (remainder / div).toString(); remainder %= div; }
  const lastOdd = digits.length ? Number(digits[digits.length - 1]) % 2 === 1 : whole % 2n === 1n;
  if (remainder * 2n > div || (remainder * 2n === div && lastOdd)) {
    const chars = digits.split(''); let i = chars.length - 1;
    for (; i >= 0 && chars[i] === '9'; i--) chars[i] = '0';
    if (i >= 0) chars[i] = String(Number(chars[i]) + 1); else whole += 1n;
    digits = chars.join('');
  }
  digits = digits.replace(/0+$/, '');
  const text = digits === '' ? whole.toString() : `${whole}.${digits}`;
  return text === '0' ? '0' : (negative ? '-' : '') + text;
};

// Every divisor the unit tables hold: lengths, then weights.
const DIVISORS = [1, 8000, 16000, 160000, 406400, 4876800, 16000000, 226796185, 8000000, 3628738960, 8000000000];

test('the Number path of decimalString renders every safe integer as the BigInt path does', () => {
  const next = stream(20261004);
  const values = [0, -0, 1, -1, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 2 ** 52, 2 ** 52 + 1];
  for (const divisor of DIVISORS) {
    // Exact ties at the eighth place, both parities, and their neighbours.
    for (const whole of [0, 1, 2, 7, 1234567]) for (const k of [1, 2, 3, 5, 15]) {
      const tie = whole * divisor + (k * divisor) / 2e8;
      if (Number.isSafeInteger(tie)) values.push(tie, tie - 1, tie + 1, -tie);
    }
    for (let index = 0; index < 400; index++) {
      const magnitude = next(0, 52);
      const value = Math.floor((next(0, 2 ** 30) / 2 ** 30) * 2 ** magnitude) * (next(0, 1) ? 1 : -1);
      values.push(value, value * divisor, value * divisor + Math.floor(divisor / 2));
    }
    for (const value of values) {
      if (!Number.isSafeInteger(value)) continue;
      const expected = bigIntDecimalString(BigInt(value), divisor);
      assert.equal(decimalString(value, divisor), expected, `${value} / ${divisor}`);
      assert.equal(decimalString(BigInt(value), divisor), expected, `${value}n / ${divisor}`);
    }
  }
  // A fractional tick count is truncated first on both paths.
  for (const value of [0.5, -0.5, 12.75, -16000.999]) assert.equal(decimalString(value, 16000), bigIntDecimalString(BigInt(Math.trunc(value)), 16000));
  // Past the safe range only the BigInt path applies, and it is still the reference.
  const large = 2n ** 60n;
  for (const divisor of [8000000, 8000000000]) {
    const div = BigInt(divisor);
    // Plain, rounding to even on a tie, rounding up, and a carry into the whole part.
    for (const value of [large * div, large * div + div - 1n, large * div + div / 2n, -(large * div + div - 1n), 2n ** 53n, -(2n ** 53n), 2n ** 70n + 12345n])
      assert.equal(decimalString(value, divisor), bigIntDecimalString(value, divisor), `${value}n / ${divisor}`);
  }
});

// The every-pair scan `usedVolume` ran before it skipped placements that cannot nest.
const everyPairVolume = (placements) => {
  let total = placements.reduce((sum, placement) => sum + occupiedVolume(placement), 0n), overlap = 0n;
  for (let i = 0; i < placements.length; i++) for (let j = i + 1; j < placements.length; j++)
    if (validNesting(placements[i], placements[j]))
      overlap += BigInt(placements[i].item.nesting) * BigInt(placements[i].ed[0]) * BigInt(placements[i].ed[1]);
  return total - overlap;
};

test('usedVolume over nesting placements alone equals the every-pair scan', () => {
  const next = stream(1600);
  for (let scene = 0; scene < 300; scene++) {
    const types = Array.from({ length: next(1, 3) }, (_, index) => ({
      raw: { id: `t${index}` }, shapeType: 'rigid_cuboid', maxCompressionKpa: null,
      nesting: next(0, 2) === 0 ? null : next(1, 4),
    }));
    const placements = [];
    for (let index = next(0, 24); index > 0; index--) {
      const item = types[next(0, types.length - 1)], pd = [next(2, 5), next(2, 5), next(3, 6)];
      placements.push({ x: next(0, 2) * 5, y: next(0, 2) * 5, z: next(0, 6), pd, ed: pd, r: 'LWH', item });
    }
    assert.equal(usedVolume(placements), everyPairVolume(placements));
  }
});

// --------------------------------------------------------------------------------

test('six-place ratios round an exact half to even, from the exact fraction (S13)', async () => {
  const { __ratiosForTests: { sixPlaces, doubleFraction } } = await import('../fallback.js');
  assert.equal(sixPlaces(1, 128), '0.007812');       // 0.0078125: toFixed gives 0.007813
  assert.equal(sixPlaces(3, 128), '0.023438');       // 0.0234375: the half rounds up to even
  assert.equal(sixPlaces(1, 1), '1.000000');
  assert.equal(sixPlaces(0, 7), '0.000000');
  assert.equal(sixPlaces(2, 3), '0.666667');
  // Past 2^53 a Number division is already wrong in the sixth place; the fraction is not.
  const huge = 2n ** 60n;
  assert.equal(sixPlaces(huge - 1n, huge), '1.000000');
  assert.equal(sixPlaces(huge / 3n, huge), '0.333333');
  const equals = ([numerator, denominator], [n, d]) => numerator * d === n * denominator;
  assert.ok(equals(doubleFraction(0.0078125), [1n, 128n]));
  assert.ok(equals(doubleFraction(3), [3n, 1n]));
  assert.ok(equals(doubleFraction(0), [0n, 1n]));
  assert.equal(sixPlaces(...doubleFraction(0.0078125)), '0.007812');
  assert.equal(sixPlaces(...doubleFraction(0.1)), (0.1).toFixed(6));
  assert.ok(equals(doubleFraction(Number.MIN_VALUE), [1n, 2n ** 1074n]));
});

test('support_ratio and volume_utilization are written half to even (S13)', async () => {
  const { packFallback } = await import('../fallback.js');
  const mm = (side) => ({ length: side, width: side, height: side });
  // 1 / 128 of the box: a utilization of exactly 0.0078125.
  const result = packFallback({
    units: { length: 'mm' }, configuration: { solver_profile: 'fast' },
    items: [{ id: 'cube', dimensions: mm('10') }],
    containers: [{ id: 'box', quantity: 1, inner_dimensions: { length: '80', width: '40', height: '40' } }],
  });
  assert.equal(result.containers[0].volume_utilization, '0.007812');
});
