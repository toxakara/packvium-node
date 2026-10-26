/**
 * Exact integer and rational arithmetic with Python's semantics, in `BigInt`.
 *
 * The reference computes on unbounded integers and `Fraction`, and so does this port: a
 * trailer's volume in cubic ticks is about 4e32, far past 2^53, and its products with a weight
 * unit or a million are larger still. Floats appear only where the reference itself converts a
 * ratio to a double (`float(fraction)`, `int(float(ratio) * 10^6 + 0.5)`, `%.6f`), and those
 * conversions are reproduced bit for bit.
 */

import { shape } from './outcome.js';
import { pyStrip } from './json.js';

export const max = (left, right) => (left > right ? left : right);
export const min = (left, right) => (left < right ? left : right);
export const abs = (value) => (value < 0n ? -value : value);

/** Python's `left // right`: rounds toward negative infinity. */
export function floorDiv(left, right) {
  if (right === 0n) throw shape('division by zero');
  const quotient = left / right;
  return left % right !== 0n && (left < 0n) !== (right < 0n) ? quotient - 1n : quotient;
}

/** Python's `left % right`: takes the sign of the divisor. */
export const pyMod = (left, right) => left - floorDiv(left, right) * right;

/** `-(-left // right)`, the reference's ceiling division. */
export const ceilDiv = (left, right) => -floorDiv(-left, right);

export function gcd(left, right) {
  let a = abs(left);
  let b = abs(right);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

const bitLength = (value) => value.toString(2).length;

/** Python's `Fraction`: always reduced, the denominator always positive. */
export class Ratio {
  constructor(numerator, denominator) {
    if (denominator === 0n) throw shape('Fraction with a zero denominator');
    const divisor = gcd(numerator, denominator);
    const flip = denominator < 0n ? -1n : 1n;
    this.numerator = (flip * numerator) / divisor;
    this.denominator = (flip * denominator) / divisor;
    Object.freeze(this);
  }

  static of(integer) {
    return new Ratio(integer, 1n);
  }

  add(other) {
    return new Ratio(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  mul(other) {
    return new Ratio(this.numerator * other.numerator, this.denominator * other.denominator);
  }

  negate() {
    return new Ratio(-this.numerator, this.denominator);
  }

  /** -1, 0 or 1 as `this` is below, equal to or above `other`. */
  compare(other) {
    const difference = this.numerator * other.denominator - other.numerator * this.denominator;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }

  /** `numerator // denominator`. */
  floor() {
    return floorDiv(this.numerator, this.denominator);
  }

  /**
   * Python's `float(fraction)`: the nearest double, ties to even, by exact division to more
   * bits than a double holds plus a sticky remainder bit. A ratio no double can hold is
   * Python's `OverflowError`.
   */
  toDouble() {
    if (this.numerator === 0n) return 0;
    const magnitude = abs(this.numerator);
    // A quotient of 66 or 67 bits: 13 or more below the 53 a double keeps, for the rounding.
    const shift = 66 - (bitLength(magnitude) - bitLength(this.denominator));
    const dividend = shift >= 0 ? magnitude << BigInt(shift) : magnitude;
    const divisor = shift >= 0 ? this.denominator : this.denominator << BigInt(-shift);
    let mantissa = dividend / divisor;
    const sticky = dividend % divisor !== 0n;
    const dropped = bitLength(mantissa) - 53;
    const remainder = mantissa & ((1n << BigInt(dropped)) - 1n);
    const half = 1n << BigInt(dropped - 1);
    mantissa >>= BigInt(dropped);
    if (remainder > half || (remainder === half && (sticky || (mantissa & 1n) === 1n))) mantissa += 1n;
    // Exact for every normal double; no ratio the validator converts is subnormal.
    const value = Number(mantissa) * 2 ** (dropped - shift);
    if (!Number.isFinite(value)) throw shape('integer division result too large for a float');
    return this.numerator < 0n ? -value : value;
  }
}

/** A run of `\d+(_\d+)*` (possibly empty) at the start of `text`, and what follows it. */
function digitGroup(text) {
  const match = /^(?:\d+(?:_\d+)*)?/.exec(text)[0];
  return [match.replace(/_/g, ''), text.slice(match.length)];
}

/**
 * `Fraction(text)`, by the grammar of CPython 3.11's `fractions._RATIONAL_FORMAT`: optional
 * whitespace and sign, then `n/d`, or a decimal with an optional exponent; digit groups may be
 * split by single underscores. Only ASCII digits are read, as the other ports read them.
 */
export function parseFraction(text) {
  const invalid = () => shape(`Invalid literal for Fraction: ${JSON.stringify(text)}`);
  let body = pyStrip(text);
  const negative = body.startsWith('-');
  if (negative || body.startsWith('+')) body = body.slice(1);
  if (!/^(?:\d|\.\d)/.test(body)) throw invalid();
  const [whole, rest] = digitGroup(body);
  let numerator = whole === '' ? 0n : BigInt(whole);
  let denominator = 1n;
  if (rest.startsWith('/')) {
    const [digits, tail] = digitGroup(rest.slice(1));
    if (digits === '' || tail !== '') throw invalid();
    denominator = BigInt(digits);
  } else {
    let tail = rest;
    if (tail.startsWith('.')) {
      const [decimals, afterDecimals] = digitGroup(tail.slice(1));
      if (decimals !== '') {
        const scale = 10n ** BigInt(decimals.length);
        numerator = numerator * scale + BigInt(decimals);
        denominator = scale;
      }
      tail = afterDecimals;
    }
    const exponent = /^[eE]([+-]?)/.exec(tail);
    if (exponent !== null) {
      const [digits, afterExponent] = digitGroup(tail.slice(exponent[0].length));
      if (digits === '') throw invalid();
      const factor = 10n ** BigInt(digits);
      if (exponent[1] === '-') denominator *= factor;
      else numerator *= factor;
      tail = afterExponent;
    }
    if (tail !== '') throw invalid();
  }
  return new Ratio(negative ? -numerator : numerator, denominator);
}

const DOUBLE_VIEW = new DataView(new ArrayBuffer(8));

/** The exact value of a finite double, as `[negative, mantissa, exponent]` with |v| = m * 2^e. */
function exactDouble(value) {
  DOUBLE_VIEW.setFloat64(0, value);
  const high = DOUBLE_VIEW.getUint32(0);
  const low = DOUBLE_VIEW.getUint32(4);
  const biased = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  const negative = high >>> 31 === 1;
  if (biased === 0) return [negative, fraction, -1074];
  return [negative, fraction | (1n << 52n), biased - 1075];
}

/**
 * `f"{value:.6f}"`: the exact binary value rounded half to even at six decimals, as Python
 * formats it. `toFixed` rounds an exact tie up, and 1/128 is one.
 */
export function fixed6(value) {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  const [negative, mantissa, exponent] = exactDouble(value);
  const scaled = mantissa * 1000000n;
  let units;
  if (exponent >= 0) {
    units = scaled << BigInt(exponent);
  } else {
    const divisor = 1n << BigInt(-exponent);
    units = scaled / divisor;
    const twice = (scaled % divisor) * 2n;
    if (twice > divisor || (twice === divisor && units % 2n === 1n)) units += 1n;
  }
  const digits = units.toString().padStart(7, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -6)}.${digits.slice(-6)}`;
}

/** Python's `int(float(ratio) * 1_000_000 + 0.5)`, the solvers' ppm rule. */
export function ratioPpm(ratio) {
  return BigInt(Math.trunc(ratio.toDouble() * 1000000 + 0.5));
}
