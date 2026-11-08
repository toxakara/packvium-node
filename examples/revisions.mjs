/**
 * Replan a half-loaded job without losing what was already done, or the record of why.
 *
 * Run it:
 *
 *     node examples/revisions.mjs
 *
 * A plan is approved, and the dock starts loading. Then something changes: a slab is missing
 * from the shelf, and a cube that is already in the tote must stay exactly where it is. The next
 * plan has to keep the cube in place and pack around it, and anyone auditing the job later has
 * to see what changed, in what order, and which approved plan each change was recorded against.
 *
 * A plan revision is that record. It is append-only and hash-chained: each revision names its
 * parent and the artifact it replaced by SHA-256, and carries the request the events produce.
 * The replan is an ordinary solve of that request. Every Packvium engine computes the same
 * revision bytes from the same inputs -- though this engine may reach a different, equally valid
 * packing than Python does, and then the artifact it approves describes that packing.
 */

import { pack } from '../index.js';
import { buildOperationalArtifact } from '../artifacts.js';
import { PlanRevisionError, deriveRevision, rootRevision, verifyRevisionChain } from '../revisions.js';

const request = {
  units: { length: 'mm' },
  configuration: {
    // Counted work decides where the search stops, not a clock: a plan the clock stopped
    // could not be replayed, and its revision would say `replay: not_guaranteed`. The time
    // limit is only a fuse, far above what this needs even on a slow or emulated host.
    effort_budget: { max_search_nodes: 20000 },
    time_limit_ms: 60000,
  },
  items: [
    { id: 'cube', quantity: 4, weight: '1 kg', dimensions: { length: '100', width: '100', height: '100' } },
    { id: 'slab', quantity: 2, weight: '2 kg', dimensions: { length: '200', width: '100', height: '50' } },
  ],
  containers: [
    { id: 'tote', quantity: 2, inner_dimensions: { length: '200', width: '200', height: '150' } },
  ],
};
const rule = '='.repeat(78);

function section(title) {
  console.log();
  console.log(rule);
  console.log(title);
  console.log(rule);
}

// Solve a request and wrap the answer as the artifact the dock works from.
function approve(approvedRequest) {
  return buildOperationalArtifact(approvedRequest, pack(structuredClone(approvedRequest)));
}

// --------------------------------------------------------------------------------------
section('1. The approved plan, and the revision that records it');

const root = rootRevision(request);
const approved = approve(root.request);
const firstStep = approved.plan.containers[0].steps[0].placement;
console.log(`  revision ${root.revision}, parent ${root.parent}`);
console.log(`  first step: a ${firstStep.item_type} at x=${firstStep.position_ticks.x} in container 0`);
console.log(`
  The root records nothing against the request. It exists so the first change has a
  parent to name.`);

// --------------------------------------------------------------------------------------
section('2. What happened on the dock, recorded against that plan');

const loaded = pack(structuredClone(root.request)).containers[0].placements[0];
const events = [
  { sequence: 1, type: 'placement_locked', placement: {
    item_type: 'cube', container_type: 'tote', container_instance: 1,
    position: { x: loaded.position.x.value, y: loaded.position.y.value, z: loaded.position.z.value },
    orientation: loaded.orientation,
  } },
  { sequence: 2, type: 'item_missing', item_type: 'slab', quantity: 1 },
];
const revision = deriveRevision(root, approved, events);
console.log(`  revision ${revision.revision}, parent ${revision.parent.slice(0, 23)}...`);
console.log(`  approved artifact ${revision.approved.artifact.slice(0, 23)}..., replay ${revision.approved.replay.level}`);
console.log(`  slabs still to pack: ${revision.request.items[1].quantity}`);
console.log(`  fixed placements:    ${revision.request.fixed_placements.length}`);
console.log(`
  The events are applied to the request, not to the result: one slab fewer, and the
  cube becomes a fixed placement. The revision names its parent and the artifact it
  replaces by SHA-256 over their RFC 8785 bytes, so every engine computes the same
  digest.`);

// --------------------------------------------------------------------------------------
section('3. The replan keeps the cube where it is');

const replanned = pack(structuredClone(revision.request));
const fixed = replanned.containers.flatMap((container) => container.placements
  .filter((placement) => placement.fixed)
  .map((placement) => `${placement.item_id} in ${container.id}`));
const placed = replanned.containers.reduce((sum, container) => sum + container.placements.length, 0);
console.log(`  fixed in the answer: ${fixed.join(', ')}`);
console.log(`  items placed:        ${placed}`);
console.log(`
  An ordinary solve of the derived request, with nothing remembered from the first
  one. The fixed cube is marked \`fixed: true\`, and the validator refuses any answer
  that moves it.`);

// --------------------------------------------------------------------------------------
section('4. An audit that notices tampering, and a refusal instead of a guess');

const codes = (issues) => issues.map((issue) => issue.code).join(', ') || 'no issues';
console.log(`  intact chain: ${codes(verifyRevisionChain([root, revision], [null, approved]))}`);
const edited = structuredClone(revision);
edited.request.items[1].quantity = 2;
console.log(`  edited chain: ${codes(verifyRevisionChain([root, edited]))}`);
try {
  deriveRevision(revision, approve(revision.request),
    [{ sequence: 3, type: 'item_missing', item_type: 'pallet', quantity: 1 }]);
} catch (error) {
  if (!(error instanceof PlanRevisionError)) throw error;
  console.log(`  a pallet that was never requested: refused with ${error.code}`);
}
console.log(`
  An edited request no longer equals what its parent's request and its own events
  produce, and any later revision would stop naming it as a parent. An event that
  contradicts the request is refused by name rather than applied as a best guess.`);

// --------------------------------------------------------------------------------------
section('5. A box already cut to measure becomes stock');

// A box machine cuts each carton to its load. `void_fill_reserve_ratio` keeps a share of
// the box free for dunnage: when the box cut tight to the load would break it, the
// machine cuts a larger one instead.
const machine = (reserve) => ({
  id: 'machine', quantity: 3, cost_minor: 40,
  inner_dimensions: { length: '610', width: '610', height: '610' },
  made_to_measure: {
    minimum: { length: '60', width: '60', height: '60' },
    increment: { length: '25', width: '25', height: '25' },
    cost_per_square_metre_minor: 1000,
    outer_allowance: { length: '3', width: '3', height: '3' },
  },
  void_fill_reserve_ratio: reserve,
});
const cutRequest = (reserve) => ({
  ...request,
  items: [{ id: 'cube', quantity: 4, weight: '1 kg', dimensions: { length: '100', width: '100', height: '100' } }],
  containers: [machine(reserve)],
});
const cutSize = (result) => {
  const { length, width, height } = result.containers[0].inner_dimensions;
  return `${length.value} x ${width.value} x ${height.value} mm`;
};
console.log(`  no reserve:  cut ${cutSize(pack(cutRequest(0)))}`);
const cutRoot = rootRevision(cutRequest(0.3));
const cutResult = pack(structuredClone(cutRoot.request));
console.log(`  30% reserve: cut ${cutSize(cutResult)}`);

// The box is cut and a cube is already in it when the order changes. A revision that
// locks the cube cannot ask the machine to cut that box again: it turns the box into a
// stock container named `<type>@<revision>#<instance>`, at the size, price and tare the
// approved artifact recorded, and takes it from the machine's stock.
const cutApproved = buildOperationalArtifact(cutRoot.request, cutResult);
const inBox = cutResult.containers[0].placements[0];
const cutRevision = deriveRevision(cutRoot, cutApproved, [{ sequence: 1, type: 'placement_locked', placement: {
  item_type: 'cube', container_type: 'machine', container_instance: 1,
  position: { x: inBox.position.x.value, y: inBox.position.y.value, z: inBox.position.z.value },
  orientation: inBox.orientation, placement_id: inBox.placement_id,
} }]);
for (const container of cutRevision.request.containers) {
  console.log(`  container ${container.id.padEnd(11)} quantity ${container.quantity}` +
    `${container.made_to_measure ? ', cut to measure' : ''}`);
}
const restocked = pack(structuredClone(cutRevision.request));
console.log(`  replan: ${restocked.containers.map((container) => `${container.id} holding ` +
  `${container.placements.length}, ${container.placements.filter((placement) => placement.fixed).length} fixed`).join('; ')}`);
console.log(`  audit with the artifact:    ${codes(verifyRevisionChain([cutRoot, cutRevision], [null, cutApproved]))}`);
console.log(`  audit without the artifact: ${codes(verifyRevisionChain([cutRoot, cutRevision]))}`);
console.log(`
  The size of a box already cut is read from the approved artifact, so the audit can
  only confirm that revision when it is given the artifact, and says so by name rather
  than passing it unchecked. \`stockCutBoxes\` is the same step on its own.`);
