/**
 * Turn a packing result into instructions someone can follow on a dock.
 *
 * Run it:
 *
 *     node examples/execution.mjs
 *
 * `pack()` answers where every box goes. That answer is not yet a work order: it does not
 * say what to lift first, and it does not separate what the solver *decided* from what a
 * screen should *say*.
 *
 * The execution plan is that second document. It is derived from an already validated
 * result -- it calls no solver and no validator, and a test in each language asserts so.
 *
 * The scene is the same one `examples/execution.py` and `examples/execution.php` build,
 * and the last section is the interesting one: this engine reaches a *different* packing
 * than they do, which is allowed, and the section explains exactly which promise that
 * does and does not break.
 */

import { pack } from '../index.js';
import { buildExecutionPlan, canonicalPlanJson } from '../execution.js';

/**
 * One crate, a printer that must stay upright, four toner cartridges, and a pallet jack
 * that was never going to fit. The last one is deliberate: an execution plan has to say
 * what is *not* going on the truck as clearly as what is.
 */
const request = {
  units: { length: 'mm' },
  configuration: {
    objective: 'default',
    profile: 'balanced',
    seed: 42,
    // A safety fuse, not a target -- nothing in this scene comes close to it.
    time_limit_ms: 60000,
  },
  items: [
    { id: 'printer', quantity: 1, weight: '9 kg', keep_upright: true,
      dimensions: { length: '420', width: '340', height: '260' } },
    { id: 'toner', quantity: 4, weight: '900 g',
      dimensions: { length: '180', width: '120', height: '100' } },
    { id: 'pallet-jack', quantity: 1, weight: '80 kg',
      dimensions: { length: '1200', width: '550', height: '1200' } },
  ],
  containers: [
    { id: 'crate', quantity: 1, max_payload: '30 kg',
      inner_dimensions: { length: '600', width: '400', height: '400' } },
  ],
};

const result = pack(request);
const plan = buildExecutionPlan(request, result);
const container = plan.containers[0];
const rule = '='.repeat(78);

console.log(rule);
console.log('1. What the solver decided, kept apart from what a screen says');
console.log(rule);
console.log();

console.log(`  format:          ${plan.format}`);
console.log(`  status:          ${plan.facts.status}`);
console.log(`  containers used: ${plan.facts.container_count}`);
console.log(`  score:           [${plan.facts.score.join(', ')}]`);
console.log(`  utilization:     ${container.facts.volume_utilization}`);
console.log();
console.log("  Everything above is under `facts`. It is the solver's own answer, copied and");
console.log('  not re-derived, so a downstream system that reads only `facts` loses nothing it');
console.log('  is entitled to rely on. The score stays a vector: collapsing five axes into one');
console.log('  number is a judgement about your priorities that this document does not make.');
console.log();

console.log(rule);
console.log('2. The step order is injected, or it is honestly absent');
console.log(rule);
console.log();

console.log(`  order: ${container.order}`);
for (const step of container.steps) {
  const { item_type: itemType, orientation, position_ticks: ticks } = step.placement;
  console.log(`    ${itemType.padEnd(9)} ${orientation}  at (${ticks.x}, ${ticks.y}, ${ticks.z})`);
}
console.log();
console.log('  Every placement is listed and not one is numbered. The engines compute a safe');
console.log('  loading order from geometry this adapter never sees, so without one it says');
console.log('  `unavailable` rather than guessing.');
console.log();
console.log('  There is no third behaviour on purpose. Falling back to the order placements');
console.log('  happen to appear in would present an artifact of how the solver walked its');
console.log('  candidate points as an order that is safe to lift boxes in. It is not.');
console.log();

const reversed = container.steps.map((_, index) => index).reverse();
const ordered = buildExecutionPlan(request, result, { loadingOrders: { 0: reversed } });
console.log(`  order: ${ordered.containers[0].order}`);
for (const step of ordered.containers[0].steps) {
  console.log(`    ${step.sequence}. ${step.placement.item_type}`);
}
console.log();
console.log('  Hand it an order and each step is numbered. The order above is reversed on');
console.log('  purpose, to show that the sequence is the one you supplied and not one the');
console.log('  adapter re-derived behind your back.');
console.log();

console.log(rule);
console.log('3. Every sentence names the fields it was built from');
console.log(rule);
console.log();

for (const entry of plan.unplaced) {
  const { facts, presentation } = entry;
  console.log(`  facts:        item_type='${facts.item_type}'`);
  console.log(`                reason='${facts.reason}' proof_level='${facts.proof_level}'`);
  console.log(`  presentation: ${presentation.summary}`);
  console.log(`  cites:        ${presentation.cites.join(', ')}`);
}
console.log();
console.log('  `proven` is a claim about a search, not a summary of one: no orientation of the');
console.log('  pallet jack fits any offered crate, so nothing was tried and nothing needed to');
console.log('  be. A reason with no citation would be a sentence nobody can check, which is');
console.log('  why `cites` is part of the format rather than a convention.');
console.log();

console.log(rule);
console.log('4. Byte-identical is a promise about the adapter, not about the search');
console.log(rule);
console.log();

const canonical = canonicalPlanJson(plan);
console.log(`  canonical form: ${canonical.length} bytes, first 68 of them`);
console.log(`    ${canonical.slice(0, 68)}...`);
console.log();
console.log('  Run the Python and PHP files on this same scene and you get 1877 bytes, not');
console.log(`  ${canonical.length}. Nothing is broken. The two claims are different, and this is the`);
console.log('  clearest place to see it:');
console.log();
console.log('    * Given the *same result*, all four adapters emit the same bytes. That is what');
console.log('      the conformance run proves — it feeds every engine the committed golden');
console.log('      results and compares byte for byte.');
console.log();
console.log('    * Given the same *request*, the engines are not required to agree. Python and');
console.log('      PHP are held to identical placements; Rust and JavaScript are held to a valid');
console.log('      answer at or above the objective floor. This engine found a different one.');
console.log();
console.log('  So a plan is a faithful projection of whatever result you hand it, and the');
console.log('  question of which engine packed better is a separate one the plan never answers.');
console.log();
console.log('  Operator locks continue this story and are Python-only: a lock has no');
console.log('  representation in the request schema, so there is nothing to hand another engine.');
