/**
 * Reproducibility: stop the search by counted work, not by the clock.
 *
 * Run it:
 *
 *     node examples/reproducibility.mjs
 *
 * Every solve stops for one of two reasons. It finishes, or a limit stops it. Which limit
 * decides whether you can get the same answer again:
 *
 * - `time_limit_ms` is a wall clock. How far a search gets in a second depends on the
 *   machine and on what else it is doing, so an answer the clock cut short can differ on
 *   the next run. This package's JavaScript engine uses 1000 ms when you set nothing.
 * - `effort_budget` counts work: candidate positions evaluated, placements attempted,
 *   search nodes expanded, restarts. The same request stops at the same point on any
 *   machine, so a budget-limited answer is still reproducible.
 *
 * The pattern for anything you store, compare or audit: set an `effort_budget` that
 * bounds the work, and a `time_limit_ms` far above what that work takes, as a fuse
 * against a genuine hang rather than as a search limit.
 */

import { createHash } from 'node:crypto';

import { commerce, pack } from '../index.js';

const order = {
  units: { length: 'mm' },
  items: [
    { id: 'tv', quantity: 3, weight: '14 kg', keep_upright: true,
      dimensions: { length: '1000', width: '150', height: '620' } },
    { id: 'soundbar', quantity: 4, weight: '3 kg',
      dimensions: { length: '900', width: '120', height: '110' } },
    { id: 'speaker', quantity: 8, weight: '4 kg',
      dimensions: { length: '220', width: '200', height: '350' } },
    { id: 'cable-kit', quantity: 20, weight: '400 g',
      dimensions: { length: '200', width: '150', height: '60' } },
  ],
  containers: [
    { id: 'carton-L', max_payload: '40 kg', cost_minor: 900,
      inner_dimensions: { length: '1100', width: '500', height: '700' } },
    { id: 'carton-M', max_payload: '20 kg', cost_minor: 400,
      inner_dimensions: { length: '600', width: '400', height: '400' } },
  ],
};

const solve = (maxCandidates) => pack({
  ...order,
  configuration: {
    effort_budget: { max_candidates_evaluated: maxCandidates },
    time_limit_ms: 60000,
  },
});

/**
 * A fingerprint of everything the result says. `duration_ms` is the one field that is a
 * measurement of the run rather than part of the answer, so it is zeroed first; the rest
 * is written in canonical JSON (sorted keys, no whitespace) so equal results hash equally.
 */
const fingerprint = (result) => createHash('sha256')
  .update(commerce.canonicalJson({ ...result, algorithm: { ...result.algorithm, duration_ms: 0 } }))
  .digest('hex')
  .slice(0, 16);

const rule = '='.repeat(78);
const section = (title) => console.log(`\n${rule}\n${title}\n${rule}`);

const report = (label, result) => {
  const { algorithm, summary, termination } = result;
  console.log(`\n  ${label}`);
  console.log(`    status             ${result.status}`);
  console.log(`    termination        ${termination.code}`);
  console.log(`    effort limit hit   ${algorithm.effort_limit_reached}`);
  console.log(`    time limit hit     ${algorithm.time_limit_reached}`);
  console.log(`    candidates counted ${algorithm.candidates_evaluated}`);
  console.log(`    packed / left out  ${summary.packed_item_count} / ${summary.unpacked_item_count}` +
    ` in ${summary.container_count} carton(s)`);
};

// ------------------------------------------------------------------------------------
section('1. A budget the search never reaches');

const generous = solve(1000000);
report('max_candidates_evaluated: 1000000', generous);
console.log('\n  The search finished on its own. The budget only matters if it would run away,');
console.log('  and the 60 s clock only matters if the budget itself takes that long.');

// ------------------------------------------------------------------------------------
section('2. A budget that cuts the search short -- and still repeats exactly');

const tight = solve(50);
report('max_candidates_evaluated: 50', tight);
const reasons = new Set(tight.unpacked_items.map((unpacked) => unpacked.reason));
console.log(`    reasons            ${[...reasons].join(', ')}`);
console.log('\n  Items the search never reached are reported as `effort_limit`, not as items');
console.log('  that do not fit. The next run stops at exactly the same candidate:');

for (const [label, maxCandidates, first] of [['generous', 1000000, generous], ['tight', 50, tight]]) {
  const again = solve(maxCandidates);
  console.log(`    ${label.padEnd(9)} run 1 ${fingerprint(first)}  run 2 ${fingerprint(again)}` +
    `  identical: ${fingerprint(first) === fingerprint(again)}`);
}

// ------------------------------------------------------------------------------------
section('3. How to tell, from the result alone, whether to trust a rerun');

const verdict = (result) => {
  if (result.algorithm.time_limit_reached) {
    return 'stopped by the clock -- a rerun may differ; do not store it as the answer';
  }
  if (result.algorithm.effort_limit_reached) {
    return 'stopped by the budget -- partial, but a rerun gives the same answer';
  }
  return 'finished -- a rerun gives the same answer';
};
console.log(`  generous: ${verdict(generous)}`);
console.log(`  tight:    ${verdict(tight)}`);
console.log('\n  `algorithm.time_limit_reached` and `algorithm.effort_limit_reached` never both');
console.log('  hold. Check the first before you cache, compare or audit a result.');
