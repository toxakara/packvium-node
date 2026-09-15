/**
 * RFC 8785 canonical JSON: the one spelling four engines can agree on byte for byte.
 *
 * Held to `packvium._canonical_json`. RFC 8785 follows JavaScript, so most of the rules are
 * what `JSON.stringify` already does for a well-formed string and a finite number; what this
 * module adds is the key sort (`JSON.stringify` keeps insertion order) and the refusals.
 *
 * - Object keys are sorted by UTF-16 code units, which is what `Array.prototype.sort` compares.
 * - Strings escape `"`, `\` and U+0000..U+001F (`\b \t \n \f \r` by name, the rest as
 *   lowercase `\u00xx`); everything else is literal.
 * - Numbers are written as ECMAScript's `Number::toString` writes them. No whitespace.
 *
 * Refused, with the code the other engines use: a number beyond 2^53 - 1 or not finite
 * (`number_out_of_range`), a string carrying a lone surrogate (`invalid_string`), and any value
 * JSON cannot spell (`invalid_value`).
 *
 * The traversal order is Python's on purpose: every key of an object is spelled before any of
 * its values, then values are written in sorted key order. When a document breaks two rules,
 * that order decides which code is reported, and the code is compared across engines.
 */

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A value has no canonical spelling. `code` names which rule it broke. */
export class CanonicalJsonError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CanonicalJsonError';
    this.code = code;
  }
}

/** O(N + sum of k log k) for a document of N nodes whose objects have k keys each. */
export function canonicalJson(value) {
  const parts = [];
  write(value, parts);
  return parts.join('');
}

function write(value, parts) {
  if (value === null) {
    parts.push('null');
  } else if (value === true || value === false) {
    parts.push(value ? 'true' : 'false');
  } else if (typeof value === 'string') {
    parts.push(spellString(value));
  } else if (typeof value === 'number') {
    parts.push(spellNumber(value));
  } else if (Array.isArray(value)) {
    writeArray(value, parts);
  } else if (isPlainObject(value)) {
    writeObject(value, parts);
  } else {
    throw new CanonicalJsonError('invalid_value', `a ${describe(value)} has no JSON spelling`);
  }
}

function writeArray(value, parts) {
  parts.push('[');
  // An index loop rather than `forEach`: a hole in a sparse array is `undefined` here and is
  // refused, where `forEach` would skip it silently.
  for (let index = 0; index < value.length; index += 1) {
    if (index) parts.push(',');
    write(value[index], parts);
  }
  parts.push(']');
}

function writeObject(value, parts) {
  if (Object.getOwnPropertySymbols(value).length) {
    throw new CanonicalJsonError('invalid_value', 'an object key is a symbol, not a string');
  }
  const keys = Object.keys(value);
  const spelled = new Map();
  for (const key of keys) spelled.set(key, spellString(key));
  parts.push('{');
  keys.sort().forEach((key, index) => {
    if (index) parts.push(',');
    parts.push(spelled.get(key), ':');
    write(value[key], parts);
  });
  parts.push('}');
}

function spellString(text) {
  if (LONE_SURROGATE.test(text)) {
    throw new CanonicalJsonError('invalid_string', 'a string carries a lone UTF-16 surrogate');
  }
  // For a well-formed string `JSON.stringify` escapes exactly the RFC 8785 set, with
  // lowercase hex, and writes `/`, U+007F, U+2028 and U+2029 literally.
  return JSON.stringify(text);
}

function spellNumber(value) {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new CanonicalJsonError('number_out_of_range',
      `${value} is beyond what every engine holds exactly`);
  }
  // `String(-0)` is `0`, as RFC 8785 requires.
  return String(value);
}

function isPlainObject(value) {
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describe(value) {
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return typeof value;
  return value.constructor?.name ?? 'object';
}
