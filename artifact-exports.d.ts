// Types for `@packvium/engine/artifact-exports.js` — exports of an operational artifact.
//
// Each export is a pure function of the artifact and is byte-identical across engines. Every
// one throws `OperationalArtifactError` with code `unknown_format` for a document whose
// `format` is not `packvium-operational-artifact/v1`. The CSV and HTML exports print only
// strings, integers and null: any other value in a printed position throws `invalid_value`.
import type { OperationalArtifact } from './artifacts.js';

export const CSV_COLUMNS: readonly [
  'record', 'container_index', 'container_type', 'sequence', 'item_type', 'orientation',
  'x_ticks', 'y_ticks', 'z_ticks', 'x', 'y', 'z', 'length', 'width', 'height', 'length_unit',
  'reason', 'proof_level',
];

/** The artifact's RFC 8785 canonical form. */
export function exportJson(artifact:OperationalArtifact):string;

/** RFC 4180: a header row, one `step` row per work-order line, one `unplaced` row per item, CRLF endings. */
export function exportCsv(artifact:OperationalArtifact):string;

/** One self-contained HTML work order: inline print styles, no script, no external resource. */
export function exportWorkOrderHtml(artifact:OperationalArtifact):string;
