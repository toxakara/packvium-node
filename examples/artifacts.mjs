/**
 * Hand a packing result to a warehouse system that has no engine.
 *
 * Run it:
 *
 *     node examples/artifacts.mjs
 *
 * An execution plan says what to lift first. A warehouse or transport system needs more than
 * that before it can act on its own: how big each box is, what the load weighs, a sheet to
 * print for the dock, and a record of which request and solver produced it.
 *
 * The operational artifact is that one document. It wraps the plan unchanged and adds geometry,
 * display values and provenance, and it exports to JSON, CSV and a printable HTML work order
 * without calling a solver, a renderer or a clock. Every Packvium engine builds the same bytes
 * from the same request and result -- though this engine may reach a different, equally valid
 * packing than Python does, and then the artifact describes that packing.
 */

import { pack } from '../index.js';
import { buildOperationalArtifact, OperationalArtifactError } from '../artifacts.js';
import { exportCsv, exportJson, exportWorkOrderHtml } from '../artifact-exports.js';

const request = {
  units: { length: 'mm' },
  configuration: {
    // A safety fuse far above what this solve needs, so the answer never depends on load.
    time_limit_ms: 60000,
  },
  items: [
    { id: 'printer', quantity: 1, weight: '12 kg',
      dimensions: { length: '420', width: '300', height: '250' },
      metadata: { sales_order: 'SO-1042' } },
    { id: 'toner', quantity: 3, weight: '1.5 kg',
      dimensions: { length: '300', width: '100', height: '100' } },
  ],
  containers: [
    { id: 'crate', quantity: 1, inner_dimensions: { length: '800', width: '400', height: '400' } },
  ],
};

const result = pack(request);
const rule = '='.repeat(78);

function section(title) {
  console.log();
  console.log(rule);
  console.log(title);
  console.log(rule);
}

section('1. One document that carries everything a consumer needs');

// No loading order is passed, so the plan lists every placement unnumbered. An engine's
// sequence API supplies a safe order; the artifact never invents one.
const artifact = buildOperationalArtifact(request, result);
console.log(`  format:          ${artifact.format}`);
console.log(`  plan steps:      ${artifact.plan.containers[0].steps.length}`);
console.log(`  crate inside:    ${artifact.geometry.containers[0].inner_dimensions.length} ticks long`);
console.log(`  order:           ${artifact.plan.containers[0].order}`);
console.log(`  sales order:     ${artifact.provenance.request.items[0].metadata.sales_order}`);
console.log();
console.log('  The request is inside the artifact, not a hash of it: only the request itself lets');
console.log('  someone replay the artifact without a lookup. The order is `unavailable` because');
console.log('  none was supplied, and the work order says so instead of numbering boxes by');
console.log('  accident.');

section('2. A CSV a warehouse system can import');

for (const row of exportCsv(artifact).split('\r\n').slice(0, 3)) console.log(`  ${row}`);
console.log();
console.log('  One row per step, then one per item that was not packed. The tick columns are the');
console.log('  identifiers a system matches on; the rendered columns are for people.');

section('3. A work order to print');

const html = exportWorkOrderHtml(artifact);
console.log(`  ${Buffer.byteLength(html)} bytes of HTML, one section per container, one checkbox per step`);
console.log(`  contains a script or an external resource: ${html.includes('<script') || html.includes('http') ? 'yes' : 'no'}`);

section('4. The same bytes in every engine, and a refusal instead of a guess');

const canonical = exportJson(artifact);
console.log(`  canonical JSON: ${Buffer.byteLength(canonical)} bytes, starting ${canonical.slice(0, 40)}...`);
try {
  exportCsv({ ...artifact, format: 'packvium-operational-artifact/v2' });
} catch (error) {
  if (!(error instanceof OperationalArtifactError)) throw error;
  console.log(`  a v2 document: refused with ${error.code}`);
}
console.log();
console.log('  The canonical form is RFC 8785, so Python, PHP and Rust build these exact bytes');
console.log('  from the same request and result. A reader that meets a format it does not know');
console.log('  refuses it by name rather than printing half of it.');
