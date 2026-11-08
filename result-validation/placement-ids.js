/**
 * Every reported placement names itself by its `placement_id` (1.10), `_check_placement_ids` in
 * the reference: the canonical JSON text of `[container id, x, y, z, item type, orientation]`
 * with the position in ticks. Written here rather than imported from the engine, so the
 * validator shares no code with what it judges.
 */

import { at, getOr, list } from './json.js';
import { issue } from './outcome.js';
import { pyStr } from './pyfmt.js';

// `JSON.stringify` escapes exactly the reference's `_id_string` set -- `"`, `\`, the C0 controls
// (`\b \t \n \f \r` by name, the rest as lowercase `\u00xx`) and a lone surrogate as lowercase
// `\udxxx` -- and writes everything else literally.
const idString = (value) => JSON.stringify(pyStr(value));

function expectedPlacementId(containerId, placement) {
  const position = at(placement, 'position');
  const ticks = ['x', 'y', 'z'].map((axis) => pyStr(at(at(position, axis), 'ticks')));
  return `[${[idString(containerId), ...ticks, idString(at(placement, 'item_type')),
    idString(at(placement, 'orientation'))].join(',')}]`;
}

/**
 * Read from the result as reported: a lattice summary has no placement objects, so it has no
 * ids to check. A missing or non-string id is a mismatch; a repeat is reported once per repeat
 * in result order. O(placements).
 */
export function checkPlacementIds(result, issues) {
  const seen = new Set();
  for (const container of list(at(result, 'containers'), 'result.containers')) {
    const containerId = getOr(container, 'id', '');
    for (const placement of list(at(container, 'placements'), 'container.placements')) {
      const expected = expectedPlacementId(containerId, placement);
      const reported = getOr(placement, 'placement_id', null);
      const where = `${pyStr(at(placement, 'item_id'))} in ${pyStr(containerId)}`;
      if (typeof reported !== 'string') {
        issues.push(issue('placement_id_mismatch', `${where}: no placement_id, expected ${expected}`));
        continue;
      }
      if (reported !== expected) {
        issues.push(issue('placement_id_mismatch', `${where}: reported ${reported}, expected ${expected}`));
      }
      if (seen.has(reported)) issues.push(issue('duplicate_placement_id', reported));
      seen.add(reported);
    }
  }
}
