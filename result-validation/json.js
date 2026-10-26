/**
 * The JSON documents the validator reads, with the semantics Python's `json.loads` values have.
 *
 * The reference computes on plain dicts, lists, `int`, `float`, `str`, `bool` and `None`, and
 * several of its outcomes depend on how Python treats them: a boolean is an `int`, `1 == 1.0 ==
 * True` and all three are one dict key, strings order by code point, a list orders element by
 * element. These helpers give a JavaScript value exactly that reading, so the checks above them
 * can be written as the reference writes them.
 *
 * A document arrives as JavaScript holds it after `JSON.parse(JSON.stringify(value))`, the
 * same text the compiled addon is handed: a number is an integer when it is integral and
 * `JSON.stringify` writes it without an exponent (below 1e21), as Python would then read that
 * text. The port's own integers are `BigInt`, so no arithmetic here is bounded by 2^53.
 */

import { contract, shape } from './outcome.js';

const hasOwn = Object.prototype.hasOwnProperty;

export const isDict = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The exact integer `value` is, or `null` when Python would not read it as an `int` literal. */
function integerOf(value) {
  if (typeof value === 'bigint') return value;
  // Read the decimal JSON literal, not the double's exact binary integer (which can
  // differ above 2^53 even though the serialized literal has no exponent).
  if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) < 1e21) return BigInt(String(value));
  return null;
}

export function kind(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'a boolean';
  if (integerOf(value) !== null) return 'an integer';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'string') return 'a string';
  return Array.isArray(value) ? 'a list' : 'an object';
}

/** Python's `d.get(key)`, `undefined` when the key is absent. A non-object has no `.get`. */
export function get(value, key) {
  if (!isDict(value)) throw shape(`expected an object holding ${JSON.stringify(key)}, got ${kind(value)}`);
  return hasOwn.call(value, key) ? value[key] : undefined;
}

/** Python's `d.get(key, default)`: a key present as `null` still reads as `null`. */
export function getOr(value, key, fallback) {
  const found = get(value, key);
  return found === undefined ? fallback : found;
}

export const getNull = (value, key) => getOr(value, key, null);

/**
 * A field the request schema types boolean: absent or null is its default, and any other
 * non-boolean is refused, as every engine refuses it, rather than read by truthiness.
 */
export function flag(value, key, fallback, owner) {
  const found = getNull(value, key);
  if (found === null) return fallback;
  if (typeof found !== 'boolean') throw contract(`${owner}.${key} must be a boolean`);
  return found;
}

/** Python's `d[key]`. */
export function at(value, key) {
  const found = get(value, key);
  if (found === undefined) throw shape(`missing ${JSON.stringify(key)}`);
  return found;
}

/** Python's `key in value` for an object; anything else reads as not holding it. */
export const has = (value, key) => isDict(value) && hasOwn.call(value, key);

/** Something the reference iterates. Only a list is admitted. */
export function list(value, what) {
  if (!Array.isArray(value)) throw shape(`${what} must be a list, got ${kind(value)}`);
  return value;
}

export function text(value, what) {
  if (typeof value !== 'string') throw shape(`${what} must be a string, got ${kind(value)}`);
  return value;
}

/**
 * An integer the reference does arithmetic on. A boolean is Python's `int`; a float would
 * carry the reference into float arithmetic this port does not follow, so it is refused.
 */
export function int(value, what) {
  const found = pyIntInstance(value);
  if (found === null) throw shape(`${what} must be an integer, got ${kind(value)}`);
  return found;
}

export const optInt = (value, what) => (value === null ? null : int(value, what));

/** `isinstance(value, int)`, which a boolean satisfies: the integer, or `null`. */
export function pyIntInstance(value) {
  if (typeof value === 'boolean') return value ? 1n : 0n;
  return integerOf(value);
}

/** `isinstance(value, int) and not isinstance(value, bool)`: the integer, or `null`. */
export const strictInt = (value) => integerOf(value);

/** Python's `int(value)`: a number truncates, a string parses as a base-10 literal. */
export function pyInt(value, what) {
  const found = pyIntInstance(value);
  if (found !== null) return found;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string') {
    const parsed = parseIntLiteral(value);
    if (parsed === null) throw shape(`${what}: invalid literal for int(): ${JSON.stringify(value)}`);
    return parsed;
  }
  throw shape(`${what}: int() cannot convert ${kind(value)}`);
}

/** The characters Python's `str.isspace` accepts, which `str.strip()` and `split()` cut on. */
const PYTHON_SPACE = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/;

export const isPythonSpace = (character) => PYTHON_SPACE.test(character);

/** Python's `str.strip()` with no argument. */
export function pyStrip(value) {
  let start = 0;
  let end = value.length;
  while (start < end && isPythonSpace(value[start])) start += 1;
  while (end > start && isPythonSpace(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

/** `int(text)`: surrounding whitespace, an optional sign, ASCII digits with single underscores. */
function parseIntLiteral(value) {
  const match = /^([+-]?)(\d+(?:_\d+)*)$/.exec(pyStrip(value));
  if (match === null) return null;
  const magnitude = BigInt(match[2].replace(/_/g, ''));
  return match[1] === '-' ? -magnitude : magnitude;
}

/** Python truthiness. */
export function truthy(value) {
  if (value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value !== 0n;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string' || Array.isArray(value)) return value.length > 0;
  return Object.keys(value).length > 0;
}

/** A value as a number Python would compare, or `null` when it is not one. */
function numberOf(value) {
  if (typeof value === 'boolean') return { integer: value ? 1n : 0n };
  const integer = integerOf(value);
  if (integer !== null) return { integer };
  return typeof value === 'number' ? { float: value } : null;
}

const sign = (difference) => (difference < 0n ? -1 : difference > 0n ? 1 : 0);

/** An integer against a finite float, exactly, as Python compares `int` with `float`. */
function compareIntegerToFloat(integer, float) {
  if (Number.isInteger(float)) return sign(integer - BigInt(float));
  return integer <= BigInt(Math.floor(float)) ? -1 : 1;
}

function compareNumbers(left, right) {
  if (left.integer !== undefined && right.integer !== undefined) return sign(left.integer - right.integer);
  if (left.integer !== undefined) return compareIntegerToFloat(left.integer, right.float);
  if (right.integer !== undefined) return 0 - compareIntegerToFloat(right.integer, left.float) || 0;
  return left.float < right.float ? -1 : left.float > right.float ? 1 : 0;
}

/** Strings by code point, as Python, PHP and Rust order them; UTF-16 order differs past the BMP. */
export function compareCodePoints(left, right) {
  if (left === right) return 0;
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const a = left.codePointAt(leftIndex);
    const b = right.codePointAt(rightIndex);
    if (a !== b) return a < b ? -1 : 1;
    leftIndex += a > 0xffff ? 2 : 1;
    rightIndex += b > 0xffff ? 2 : 1;
  }
  return leftIndex === left.length ? (rightIndex === right.length ? 0 : -1) : 1;
}

/** Python `==`: numbers by value whatever their type, containers element-wise, objects by key. */
export function pyEq(left, right) {
  const a = numberOf(left);
  const b = numberOf(right);
  if (a !== null || b !== null) return a !== null && b !== null && compareNumbers(a, b) === 0;
  if (left === null || right === null) return left === right;
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((element, index) => pyEq(element, right[index]));
  }
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => hasOwn.call(right, key) && pyEq(left[key], right[key]));
}

/** Python's `<` ordering for values it can order; anything else is its `TypeError`. */
export function pyCmp(left, right) {
  const a = numberOf(left);
  const b = numberOf(right);
  if (a !== null && b !== null) return compareNumbers(a, b);
  if (typeof left === 'string' && typeof right === 'string') return compareCodePoints(left, right);
  if (Array.isArray(left) && Array.isArray(right)) {
    const shared = Math.min(left.length, right.length);
    for (let index = 0; index < shared; index += 1) {
      if (!pyEq(left[index], right[index])) return pyCmp(left[index], right[index]);
    }
    return sign(BigInt(left.length - right.length));
  }
  throw shape(`cannot order ${kind(left)} against ${kind(right)}`);
}

/** `sorted(values)`: a stable sort by Python's ordering. */
export function sortPy(values) {
  return values.slice().sort(pyCmp);
}

/**
 * The identity Python hashes a set member or dict key by, so `1`, `1.0` and `True` share one.
 * A list or an object is unhashable, as in Python.
 */
export function hashKey(value) {
  if (typeof value === 'boolean') return value ? 'n1' : 'n0';
  if (typeof value === 'bigint') return `n${value}`;
  if (typeof value === 'number') return Number.isInteger(value) ? `n${integerOf(value) ?? BigInt(value)}` : `f${value}`;
  if (value === null) return 'null';
  if (typeof value === 'string') return `s${value}`;
  throw shape(`${kind(value)} is unhashable`);
}

/**
 * Insertion-ordered map keyed the way a Python dict is: assigning an existing key replaces its
 * value in place and keeps the key first written, as Python keeps it.
 */
export class PyDict {
  constructor() {
    this.entries = new Map();
  }

  set(key, value) {
    const hashed = hashKey(key);
    const existing = this.entries.get(hashed);
    if (existing === undefined) {
      this.entries.set(hashed, { key, value, index: this.entries.size });
    } else {
      existing.value = value;
    }
  }

  get(key) {
    const entry = this.entries.get(hashKey(key));
    return entry === undefined ? undefined : entry.value;
  }

  has(key) {
    return this.entries.has(hashKey(key));
  }

  /** The entry's position in insertion order. */
  position(key) {
    return this.entries.get(hashKey(key)).index;
  }

  get size() {
    return this.entries.size;
  }

  keys() {
    return Array.from(this.entries.values(), (entry) => entry.key);
  }

  values() {
    return Array.from(this.entries.values(), (entry) => entry.value);
  }

  items() {
    return Array.from(this.entries.values(), (entry) => [entry.key, entry.value]);
  }
}
