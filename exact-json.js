/**
 * JSON text for results whose integers can pass 2^53 - 1 (R19-01).
 *
 * A weight is admitted up to `2^63 - 1` ticks, and a `Number` holds only 2^53 - 1 exactly, so a
 * result carries such a weight's `ticks`, and a score position that sums weights, as a `BigInt`.
 * `JSON.stringify` refuses a `BigInt` and `JSON.parse` rounds a long integer, so this package
 * moves results through text with these two instead: a `BigInt` is written as the integer it
 * is, and an integer past the safe range is read back as a `BigInt`; every other value is what
 * `JSON` would make of it. O(text).
 */

const MARK = '\u0000packvium-exact-integer:';
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MARKED = /"\\u0000packvium-exact-integer:(-?\d+)"/g;
const LONG_INTEGER = /-?\d{16,}(?![.\deE])/y;

/** An integer as this package returns it: a `Number` while exact, a `BigInt` past 2^53 - 1. */
export function exactInteger(digits) {
  const value = BigInt(digits);
  return value <= SAFE && value >= -SAFE ? Number(value) : value;
}

export function stringifyExact(value) {
  return JSON.stringify(value, (_, member) => (typeof member === 'bigint' ? MARK + member : member))
    .replace(MARKED, '$1');
}

export function parseExact(text) {
  return JSON.parse(markLongIntegers(text), (_, member) =>
    typeof member === 'string' && member.startsWith(MARK) ? exactInteger(member.slice(MARK.length)) : member);
}

/**
 * `text` with every integer literal of 16 or more digits outside a string turned into a marked
 * string, which the reviver above reads back exactly. The mark is written escaped: JSON text may
 * not hold a raw control character. One pass, skipping string contents and their escapes.
 */
function markLongIntegers(text) {
  let marked = '';
  let copied = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      for (index++; index < text.length && text[index] !== '"'; index++) {
        if (text[index] === '\\') index++;
      }
      continue;
    }
    if (character !== '-' && (character < '0' || character > '9')) continue;
    LONG_INTEGER.lastIndex = index;
    const match = LONG_INTEGER.exec(text);
    if (match === null) {
      while (index + 1 < text.length && /[-+.\deE]/.test(text[index + 1])) index++;
      continue;
    }
    marked += `${text.slice(copied, index)}"\\u0000packvium-exact-integer:${match[0]}"`;
    copied = index + match[0].length;
    index = copied - 1;
  }
  return marked + text.slice(copied);
}
