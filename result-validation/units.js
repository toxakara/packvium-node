/** Measures to exact ticks, re-derived from the unit tables rather than taken from the engine. */

import { at, get, getNull, isDict, isPythonSpace, pyIntInstance, pyStrip, text } from './json.js';
import { Ratio, parseFraction } from './num.js';
import { contract, shape } from './outcome.js';
import { pyStr } from './pyfmt.js';

/** Ticks per unit, in the reference's order. One length tick is 1/16000 mm. */
export const LENGTH = Object.freeze([
  ['mm', 16000n], ['cm', 160000n], ['m', 16000000n],
  ['in', 406400n], ['inch', 406400n], ['inches', 406400n],
  ['ft', 4876800n], ['tick', 1n], ['ticks', 1n],
]);

/** One weight tick is 1/8 microgram. */
export const WEIGHT = Object.freeze([
  ['mg', 8000n], ['g', 8000000n], ['kg', 8000000000n],
  ['oz', 226796185n], ['lb', 3628738960n], ['lbs', 3628738960n],
  ['tick', 1n], ['ticks', 1n],
]);

/**
 * Every name the engines read in `units.length`, after stripping ASCII whitespace and lowering
 * ASCII case, to the `LENGTH` key it means.
 */
const REQUEST_LENGTH_UNITS = new Map([
  ...LENGTH.map(([name]) => [name, name]), ['millimeter', 'mm'], ['millimeters', 'mm'],
]);

/**
 * `units.length` as every engine reads it: `units` or `units.length` absent or null
 * is millimetres; `units` that is not an object, or a length unit the engines do not know, is
 * refused naming the field.
 */
export function lengthUnit(request) {
  const units = getNull(request, 'units');
  if (units === null) return 'mm';
  if (!isDict(units)) throw contract('units must be an object');
  const length = getNull(units, 'length');
  if (length === null) return 'mm';
  const key = typeof length === 'string'
    ? length.replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, '').replace(/[A-Z]/g, (letter) => letter.toLowerCase())
    : '';
  const found = REQUEST_LENGTH_UNITS.get(key);
  if (found === undefined) throw contract('units.length must be one of mm, cm, m, in, ft');
  return found;
}

export const TICKS_PER_MM = 16000n;
export const TICKS_PER_GRAM = 8000000n;
export const TICKS_PER_KG = 8000000000n;

/** Suffixes longest first; Python's stable sort keeps the table's order among equal lengths. */
const suffixesOf = (table) => table.map(([name]) => name).sort((left, right) => right.length - left.length);
const SUFFIXES = new Map([[LENGTH, suffixesOf(LENGTH)], [WEIGHT, suffixesOf(WEIGHT)]]);

/** `table[unit]`, an exact key. */
export function perUnit(table, unit) {
  const found = table.find(([name]) => name === unit);
  if (found === undefined) throw shape(`unknown unit ${JSON.stringify(unit)}`);
  return found[1];
}

/**
 * The longest unit suffix the text ends with, case-insensitively, that leaves a non-empty
 * number before it. The number is cut from the original text by the suffix's length in code
 * points, as Python slices it, even where lowering changed the text's length.
 */
function unitSuffix(stripped, table) {
  const lowered = stripped.toLowerCase();
  const characters = Array.from(stripped);
  for (const suffix of SUFFIXES.get(table)) {
    if (!lowered.endsWith(suffix) || characters.length < suffix.length) continue;
    const number = pyStrip(characters.slice(0, characters.length - suffix.length).join(''));
    if (number !== '') return [number, suffix];
  }
  return null;
}

/** `to_ticks`: a number, a string with an optional unit suffix, or `{value, unit}`, rounded half to even. */
export function toTicks(measure, defaultUnit, table) {
  let unit = defaultUnit;
  let raw = measure;
  if (isDict(measure)) {
    raw = at(measure, 'value');
    const stated = get(measure, 'unit');
    if (stated !== undefined) unit = text(stated, "a measure's unit");
  } else if (typeof measure === 'string') {
    const found = unitSuffix(pyStrip(measure), table);
    if (found !== null) [raw, unit] = found;
  }
  return roundHalfEven(parseRational(raw).mul(Ratio.of(perUnit(table, unit.toLowerCase()))));
}

function roundHalfEven(scaled) {
  const floor = scaled.floor();
  const twice = 2n * (scaled.numerator - floor * scaled.denominator);
  if (twice > scaled.denominator) return floor + 1n;
  if (twice < scaled.denominator) return floor;
  return floor % 2n === 0n ? floor : floor + 1n;
}

/** Python's `text.split(None, 1)` of stripped text holding whitespace: the first word and the rest. */
function splitFirstWord(stripped) {
  let end = 0;
  while (!isPythonSpace(stripped[end])) end += 1;
  let rest = end;
  while (isPythonSpace(stripped[rest])) rest += 1;
  return [stripped.slice(0, end), stripped.slice(rest)];
}

/** `parse_rational`: an integer exactly, anything else through its `str()`, mixed when it holds a space. */
export function parseRational(value) {
  const integer = pyIntInstance(value);
  if (integer !== null) return Ratio.of(integer);
  const stripped = pyStrip(pyStr(value));
  if (!stripped.includes(' ')) return parseFraction(stripped);
  const [whole, rest] = splitFirstWord(stripped);
  const fraction = parseFraction(rest);
  return parseFraction(whole).add(whole.startsWith('-') ? fraction.negate() : fraction);
}

/** `Fraction(str(value))`, the reference's reading of a ratio field. */
export const ratioOf = (value) => parseFraction(pyStr(value));

export const dimensions = (value, unit) => [
  toTicks(at(value, 'length'), unit, LENGTH),
  toTicks(at(value, 'width'), unit, LENGTH),
  toTicks(at(value, 'height'), unit, LENGTH),
];
