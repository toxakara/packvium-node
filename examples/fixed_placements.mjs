/**
 * Fixed placements: pack around what is already loaded.
 *
 * Run it:
 *
 *     node examples/fixed_placements.mjs
 *
 * Loading rarely starts from an empty van. A fridge is already strapped in against the
 * door, or an operator has locked a pallet where it stands, and the next solve must work
 * around it rather than move it.
 *
 * `fixed_placements` says so. Each entry names an item type, a container type and
 * instance, a position and an orientation -- the same fields a result placement reports,
 * so a placement from an earlier result can be fixed by quoting it. Fixed items are real:
 * they carry weight, count against payload and can support what is stacked on them. They
 * come back unmoved, marked `"fixed": true`.
 *
 * examples/revisions.mjs builds a full audit trail on top of this; here it is the field
 * on its own.
 */

import { FixedPlacementError, pack } from '../index.js';

const configuration = {
  // Counted work decides where the search stops; the wall clock is only a safety fuse.
  effort_budget: { max_candidates_evaluated: 1000000 },
  time_limit_ms: 60000,
};
const van = { id: 'van', quantity: 1, max_payload: '400 kg',
  inner_dimensions: { length: '2400', width: '1400', height: '1900' } };
const fridge = { id: 'fridge', quantity: 1, weight: '80 kg', keep_upright: true,
  dimensions: { length: '700', width: '700', height: '1800' } };
const box = { id: 'box', quantity: 6, weight: '12 kg',
  dimensions: { length: '500', width: '400', height: '400' } };

const print = (result) => {
  console.log(`  status ${result.status}`);
  for (const container of result.containers) {
    for (const placement of container.placements) {
      const { x, y, z } = placement.position;
      console.log(`    ${placement.item_id.padEnd(11)} at (${x.value}, ${y.value}, ${z.value}) mm` +
        `${placement.fixed ? '   fixed' : ''}`);
    }
  }
};

const rule = '='.repeat(78);
const section = (title) => console.log(`\n${rule}\n${title}\n${rule}`);

// ------------------------------------------------------------------------------------
section('1. The fridge is already in, in the far corner');

// `container_instance` counts from 1: this is the first van, reported as `van#1`.
const strappedIn = {
  item_type: 'fridge', container_type: 'van', container_instance: 1,
  position: { x: '1700', y: '700', z: '0' }, orientation: 'LWH',
};
print(pack({ units: { length: 'mm' }, configuration, items: [fridge, box], containers: [van],
  fixed_placements: [strappedIn] }));
console.log('\n  The six boxes are placed around it. The fridge is exactly where it was put,');
console.log('  and its 80 kg counts against the van\'s payload like any other item.');

// ------------------------------------------------------------------------------------
section('2. Lock half of an earlier plan, then add a late order');

// Solve once, as a morning plan.
const morning = pack({ units: { length: 'mm' }, configuration, items: [fridge, box], containers: [van] });
const loaded = morning.containers[0].placements.slice(0, 4);
console.log(`  morning plan: ${morning.summary.packed_item_count} placed; ` +
  `${loaded.length} are on the van when a late order arrives`);

// A result placement already has every field a fixed placement needs. Quote them.
const locked = loaded.map((placement) => ({
  item_type: placement.item_type,
  container_type: 'van',
  container_instance: 1,
  position: {
    x: { value: placement.position.x.value, unit: placement.position.x.unit },
    y: { value: placement.position.y.value, unit: placement.position.y.unit },
    z: { value: placement.position.z.value, unit: placement.position.z.unit },
  },
  orientation: placement.orientation,
}));
const lateOrder = { id: 'late-box', quantity: 3, weight: '8 kg',
  dimensions: { length: '400', width: '400', height: '300' } };
print(pack({ units: { length: 'mm' }, configuration, items: [fridge, box, lateOrder], containers: [van],
  fixed_placements: locked }));
console.log('\n  The four loaded items keep their places; everything else, including the late');
console.log('  order, is planned around them.');

// ------------------------------------------------------------------------------------
section('3. A fixed set that cannot hold is refused before any search');

// A box claimed to stand where the fridge already is. The request is wrong, not the
// search, so this is an error rather than an item left out.
try {
  pack({ units: { length: 'mm' }, configuration, items: [fridge, box], containers: [van],
    fixed_placements: [strappedIn, { item_type: 'box', container_type: 'van',
      position: { x: '1500', y: '700', z: '0' }, orientation: 'LWH' }] });
} catch (error) {
  if (!(error instanceof FixedPlacementError)) throw error;
  console.log(`  ${error.reason} at ${error.field}`);
  console.log(`  ${error.message}`);
}
