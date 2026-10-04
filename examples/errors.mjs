/**
 * Errors: a request that is wrong, and how to tell it from one that simply does not fit.
 *
 * Run it:
 *
 *     node examples/errors.mjs
 *
 * Two kinds of "no" come back from `pack`, and they must be handled differently:
 *
 * - **The request is wrong.** A value is missing, mistyped, out of range or in an unknown
 *   unit. Nothing is solved. `pack` throws `InvalidRequestError`, a `RangeError`, naming the
 *   value and the rule it broke. Retrying the same request gives the same error.
 * - **The request is fine, but not everything fits.** That is an answer, not an error: the
 *   result lists each item left out in `unpacked_items`, with a reason.
 *
 * The error's `code`, `reason`, `field` and message are the same in every Packvium engine,
 * and the same whichever backend (native or JavaScript) answered here.
 */

import {
  FixedPlacementError,
  InvalidRequestError,
  UnsupportedFeatureError,
  pack,
  packJson,
} from '../index.js';

/** A valid request; each case below breaks one thing in a fresh copy of it. */
const valid = () => ({
  units: { length: 'mm' },
  configuration: {
    // Counted work decides where the search stops; the wall clock is only a safety fuse.
    effort_budget: { max_candidates_evaluated: 1000000 },
    time_limit_ms: 60000,
  },
  items: [
    { id: 'mug', quantity: 2, weight: '400 g', dimensions: { length: '120', width: '120', height: '100' } },
  ],
  containers: [
    { id: 'box', inner_dimensions: { length: '400', width: '400', height: '400' } },
  ],
});

const rule = '='.repeat(78);
const section = (title) => console.log(`\n${rule}\n${title}\n${rule}`);

// ------------------------------------------------------------------------------------
section('1. One error type, four fields to read');

const cases = [
  ['quantity of zero', (r) => { r.items[0].quantity = 0; }],
  ['a string where a count belongs', (r) => { r.items[0].quantity = '2'; }],
  ['a missing dimension', (r) => { delete r.items[0].dimensions.height; }],
  ['a negative width', (r) => { r.containers[0].inner_dimensions.width = '-400'; }],
  ['an unknown unit', (r) => { r.units.length = 'furlong'; }],
  ['the same container id twice', (r) => { r.containers.push({ ...r.containers[0] }); }],
  ['a profile that does not exist', (r) => { r.configuration.solver_profile = 'thorough'; }],
  ['a support ratio above 1', (r) => { r.items[0].minimum_support_ratio = 1.5; }],
];

for (const [label, breakIt] of cases) {
  const request = valid();
  breakIt(request);
  try {
    pack(request);
    console.log(`${label}: accepted`);
  } catch (error) {
    if (!(error instanceof InvalidRequestError)) throw error;
    console.log(`\n${label}`);
    console.log(`  reason  ${error.reason}`);
    console.log(`  field   ${error.field}`);
    console.log(`  detail  ${error.detail}`);
    console.log(`  message ${error.message}`);
  }
}

console.log('\n  Branch on `reason` (a closed set) and `field` (a JSON Pointer into the request');
console.log('  you sent); show the message to a person. `error.code` is `invalid_request`, and');
console.log('  each is also a RangeError, so code that already catches RangeError still works.');

// ------------------------------------------------------------------------------------
section('2. JavaScript numbers: what is and is not an integer here');

// JavaScript has one number type, so an integer is judged by value, exactly as the other
// engines judge it: 2.0 is 2, while 2.5 is not an integer at all.
const counted = (quantity) => {
  const request = valid();
  request.items[0].quantity = quantity;
  try {
    return `packed ${pack(request).summary.packed_item_count}`;
  } catch (error) {
    if (!(error instanceof InvalidRequestError)) throw error;
    return `${error.reason}: ${error.detail}`;
  }
};
console.log(`  quantity 2.0      -> ${counted(2.0)}`);
console.log(`  quantity 2.5      -> ${counted(2.5)}`);

// Past 2^53 - 1 a Number stops being exact, so every engine refuses a count beyond it
// rather than one engine answering for a value another cannot even represent. It holds
// for JSON text too: JSON.parse would silently round 9007199254740993 down to ...992.
console.log(`  quantity 2 ** 53  -> ${counted(2 ** 53)}`);
try {
  packJson('{"items":[{"id":"a","quantity":9007199254740993,'
    + '"dimensions":{"length":"1","width":"1","height":"1"}}],'
    + '"containers":[{"id":"b","inner_dimensions":{"length":"1","width":"1","height":"1"}}]}');
} catch (error) {
  if (!(error instanceof InvalidRequestError)) throw error;
  console.log(`  same, as JSON text -> ${error.reason}: ${error.detail}`);
}

// A key you choose yourself -- a tag, say -- can contain '/', which a JSON Pointer
// writes as '~1'. Unescape it before looking the key up.
const tagged = valid();
tagged.containers[0].tag_limits = { 'cold/chain': 0 };
try {
  pack(tagged);
} catch (error) {
  if (!(error instanceof InvalidRequestError)) throw error;
  const key = error.field.split('/').pop().replaceAll('~1', '/').replaceAll('~0', '~');
  console.log(`\n  pointer ${error.field} names the tag '${key}'`);
}

// ------------------------------------------------------------------------------------
section('3. Fixed placements that cannot hold, and fields not implemented yet');

// `FixedPlacementError` is an `InvalidRequestError` with its own code, so one catch
// covers both. `malformed` points at the bad value; `cannot_hold` means the fixed items
// are not a valid packing on their own -- here, two mugs in the same place.
const fixed = valid();
fixed.fixed_placements = [
  { item_type: 'mug', container_type: 'box', position: { x: '0', y: '0', z: '0' }, orientation: 'LWH' },
  { item_type: 'mug', container_type: 'box', position: { x: '50', y: '0', z: '0' }, orientation: 'LWH' },
];
try {
  pack(fixed);
} catch (error) {
  if (!(error instanceof FixedPlacementError)) throw error;
  console.log(`  ${error.code} / ${error.reason} at ${error.field}`);
  console.log(`  ${error.message}`);
}

// A field the schema reserves but no engine implements yet is refused by name rather
// than silently ignored. It is a different error type, with its own code.
const ahead = valid();
ahead.containers[0].pallet_overhang_limit = { length: '50', width: '50' };
try {
  pack(ahead);
} catch (error) {
  if (!(error instanceof UnsupportedFeatureError)) throw error;
  console.log(`\n  ${error.code}: ${error.fields.join(', ')}`);
}

// ------------------------------------------------------------------------------------
section('4. Not an error: a valid request that does not fit completely');

const tooBig = valid();
tooBig.items.push({ id: 'ladder', quantity: 1, weight: '6 kg',
  dimensions: { length: '1800', width: '300', height: '100' } });
const result = pack(tooBig);
console.log(`  status ${result.status}, ${result.summary.packed_item_count} packed`);
for (const unpacked of result.unpacked_items) {
  console.log(`  ${unpacked.item_id}: ${unpacked.reason} (${unpacked.proof.level})`);
}
console.log('\n  Nothing was thrown. What was left out, and why, is part of the answer.');
