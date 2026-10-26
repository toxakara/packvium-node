/**
 * Python's `str()` and `repr()` for the values an issue detail prints.
 *
 * The reference builds every detail with an f-string, so a detail carries Python's spelling of
 * whatever it names: `None`, `True`, `'quoted'`, `(1, 2, 3)`, `1e-05`. Matching it is what lets
 * one issue list be compared across languages byte for byte.
 */

import { strictInt } from './json.js';
import { nonPrintable } from './nonprintable.js';

/** `str(value)`: a string as itself, anything else as its `repr`. */
export const pyStr = (value) => (typeof value === 'string' ? value : pyRepr(value));

export function pyRepr(value) {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  const integer = strictInt(value);
  if (integer !== null) return integer.toString();
  if (typeof value === 'number') return floatRepr(value);
  if (typeof value === 'string') return strRepr(value);
  if (Array.isArray(value)) return list(value.map(pyRepr));
  return `{${Object.keys(value).map((key) => `${strRepr(key)}: ${pyRepr(value[key])}`).join(', ')}}`;
}

export const boolRepr = (flag) => (flag ? 'True' : 'False');

/** `[a, b]` from already-formatted elements. */
export const list = (elements) => `[${elements.join(', ')}]`;

/** `(a, b)` from already-formatted elements; a one-element tuple keeps its trailing comma. */
export const tuple = (elements) => (elements.length === 1 ? `(${elements[0]},)` : `(${elements.join(', ')})`);

/** A tuple of document values, each as its `repr`. */
export const valueTuple = (values) => tuple(values.map(pyRepr));

/** A tuple of the port's own `BigInt`s. */
export const intTuple = (values) => tuple(values.map(String));

export const intList = (values) => list(values.map(String));

/**
 * `repr(float)`: the shortest digits that round-trip -- the digits `toExponential()` gives --
 * in fixed notation for decimal exponents from -4 to 15 and scientific (`1e-05`, `1e+16`)
 * outside that.
 */
export function floatRepr(value) {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  const [mantissa, power] = Math.abs(value).toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const exponent = Number(power);
  if (exponent >= -4 && exponent < 16) {
    const point = exponent + 1;
    if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
    if (digits.length <= point) return `${sign}${digits}${'0'.repeat(point - digits.length)}.0`;
    return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  const fraction = digits.length > 1 ? `.${digits.slice(1)}` : '';
  const magnitude = String(Math.abs(exponent)).padStart(2, '0');
  return `${sign}${digits[0]}${fraction}e${exponent < 0 ? '-' : '+'}${magnitude}`;
}

const hex = (code, width) => code.toString(16).padStart(width, '0');

/** One code point as `repr` writes it inside quotes of kind `quote`. */
function escaped(code, quote) {
  if (code === 0x5c) return '\\\\';
  if (code === 0x09) return '\\t';
  if (code === 0x0a) return '\\n';
  if (code === 0x0d) return '\\r';
  const character = String.fromCodePoint(code);
  if (character === quote) return `\\${quote}`;
  if (code < 0x20 || code === 0x7f) return `\\x${hex(code, 2)}`;
  if (code < 0x7f || !nonPrintable(code)) return character;
  if (code <= 0xff) return `\\x${hex(code, 2)}`;
  if (code <= 0xffff) return `\\u${hex(code, 4)}`;
  return `\\U${hex(code, 8)}`;
}

/**
 * `repr(str)`: single quotes unless the text holds a single quote and no double quote, with
 * Python's escapes for the backslash, the quote, `\t`, `\n`, `\r` and every code point
 * `str.isprintable` rejects. Walked by code point, so a lone surrogate is one escape.
 */
export function strRepr(value) {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (let index = 0; index < value.length;) {
    const code = value.codePointAt(index);
    out += escaped(code, quote);
    index += code > 0xffff ? 2 : 1;
  }
  return out + quote;
}
