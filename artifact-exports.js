/**
 * JSON, CSV and print-ready work orders from an operational artifact.
 *
 * Held to `packvium.artifact_exports`. Each export is a pure function of the artifact: no
 * solver, carrier, renderer or clock, so an export is replayable from the artifact it came
 * from and four engines emit the same bytes.
 *
 * - JSON is the artifact's RFC 8785 canonical form.
 * - CSV has one row per packing step and one per unplaced item. It is RFC 4180: a header row,
 *   CRLF after every row, and a field quoted only when it holds a comma, quote, CR or LF.
 * - The work order is one self-contained HTML document: inline print styles, no script, no
 *   external resource, ASCII source with entities for the few typographic characters.
 *
 * Values are copied, never re-rendered or reinterpreted. That includes a CSV field beginning
 * with `=`: prefixing it would change an identifier a warehouse system matches on.
 */

import { FORMAT, OperationalArtifactError, canonicalArtifactJson } from './artifacts.js';

export const CSV_COLUMNS = Object.freeze([
  'record', 'container_index', 'container_type', 'sequence', 'item_type', 'orientation',
  'x_ticks', 'y_ticks', 'z_ticks', 'x', 'y', 'z', 'length', 'width', 'height', 'length_unit',
  'reason', 'proof_level',
]);

const CSV_SPECIAL = /[,"\r\n]/;

const STYLE = 'body{font-family:system-ui,sans-serif;margin:24px;color:#111}'
  + 'h1{font-size:20px}h2{font-size:16px;margin-top:24px}'
  + 'table{border-collapse:collapse;width:100%;margin:8px 0 16px}'
  + 'th,td{border:1px solid #999;padding:4px 6px;text-align:left;font-size:12px;vertical-align:top}'
  + 'th{background:#eee}'
  + '.facts td:first-child{width:28%;font-weight:600}'
  + '@media print{body{margin:0}section.container{break-after:page}tr{break-inside:avoid}}';

const DASH = '&mdash;';

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function exportJson(artifact) {
  return canonicalArtifactJson(requireArtifact(artifact));
}

export function exportCsv(artifact) {
  const document = requireArtifact(artifact);
  const workOrder = document.work_order;
  const rows = [CSV_COLUMNS];
  for (const container of workOrder.containers) {
    for (const line of container.lines) {
      const reference = line.placement;
      const ticks = reference.position_ticks;
      const { position, dimensions } = line;
      rows.push([
        'step', reference.container_index, container.container_type, get(line, 'sequence'),
        reference.item_type, reference.orientation, ticks.x, ticks.y, ticks.z,
        position.x, position.y, position.z,
        dimensions.length, dimensions.width, dimensions.height, workOrder.length_unit,
        null, null,
      ]);
    }
  }
  for (const unplaced of document.plan.unplaced) {
    const { facts } = unplaced;
    rows.push(['unplaced', null, null, null, facts.item_type, null, null, null, null,
      null, null, null, null, null, null, null, facts.reason, facts.proof_level]);
  }
  return rows.map((row) => `${row.map(csvField).join(',')}\r\n`).join('');
}

export function exportWorkOrderHtml(artifact) {
  const document = requireArtifact(artifact);
  const { plan, work_order: workOrder, provenance } = document;
  const lines = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>Packing work order</title>',
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<h1>Packing work order</h1>',
    '<table class="facts">',
    ...factRows(document, plan, provenance),
    '</table>',
  ];
  // Python's `zip`: the shorter of the two lists decides how many sections there are.
  const count = Math.min(plan.containers.length, workOrder.containers.length);
  for (let index = 0; index < count; index += 1) {
    lines.push(...containerSection(plan.containers[index], workOrder.containers[index], workOrder));
  }
  lines.push(...unplacedSection(plan.unplaced), '</body>', '</html>');
  return `${lines.join('\n')}\n`;
}

// ------------------------------------------------------------------------------------ HTML

function factRows(document, plan, provenance) {
  const { facts } = plan;
  const { replay, solver } = provenance;
  const { feasibility } = facts;
  const replayText = escape(replay.level) + (replay.because ? ` (${escape(replay.because)})` : '');
  const solverText = solver
    ? `${escape(solver.profile)} / ${escape(solver.solver)} / seed ${escape(solver.seed)}`
    : DASH;
  const catalogs = provenance.catalog_versions_used
    .map((catalog) => `${escape(get(catalog, 'catalog_id'))} v${escape(get(catalog, 'version'))}`)
    .join(', ');
  const rows = [
    ['Status', escape(facts.status)],
    ['Objective', orDash(plan.objective)],
    ['Containers', escape(facts.container_count)],
    ['Score', `[${facts.score.map(escape).join(', ')}]`],
    ['Feasibility', orDash(get(feasibility, 'code'))],
    ['Replay', replayText],
    ['Solver', solverText],
    ['Catalogs', catalogs || DASH],
    ['Packvium', escape(document.suite_version)],
  ];
  return rows.map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`);
}

function containerSection(planContainer, container, workOrder) {
  const { facts } = planContainer;
  const weightUnit = escape(workOrder.weight_unit);
  const lengthUnit = escape(workOrder.length_unit);
  const lines = [
    '<section class="container">',
    `<h2>Container ${ordinal(container.container_index)}: ${orDash(container.container_type)}</h2>`,
    `<p>Payload ${escape(container.payload_weight)} ${weightUnit} &middot; `
      + `Gross ${escape(container.gross_weight)} ${weightUnit} &middot; `
      + `Utilization ${orDash(facts.volume_utilization)}</p>`,
    planContainer.order === 'loading'
      ? '<p>Order: loading. Follow the steps in sequence.</p>'
      : '<p>Order: unavailable. No safe loading order was supplied, so the steps are not numbered.</p>',
    '<table>',
    `<thead><tr><th>Step</th><th>Item</th><th>Orientation</th><th>Position x, y, z (${lengthUnit})</th>`
      + `<th>Size l &times; w &times; h (${lengthUnit})</th><th>Done</th></tr></thead>`,
    '<tbody>',
  ];
  for (const line of container.lines) {
    const { placement: reference, position, dimensions: size } = line;
    lines.push(
      `<tr><td>${escape(get(line, 'sequence'))}</td><td>${escape(reference.item_type)}</td>`
      + `<td>${escape(reference.orientation)}</td>`
      + `<td>${escape(position.x)}, ${escape(position.y)}, ${escape(position.z)}</td>`
      + `<td>${escape(size.length)} &times; ${escape(size.width)} &times; ${escape(size.height)}</td>`
      + '<td>&#9744;</td></tr>',
    );
  }
  lines.push('</tbody>', '</table>', '</section>');
  return lines;
}

function unplacedSection(entries) {
  const lines = ['<section>', '<h2>Not packed</h2>'];
  if (entries.length === 0) {
    lines.push('<p>Every item was packed.</p>', '</section>');
    return lines;
  }
  lines.push('<table>', '<thead><tr><th>Item</th><th>Reason</th><th>Proof</th></tr></thead>', '<tbody>');
  for (const { facts } of entries) {
    lines.push(`<tr><td>${orDash(facts.item_type)}</td><td>${orDash(facts.reason)}</td>`
      + `<td>${orDash(facts.proof_level)}</td></tr>`);
  }
  lines.push('</tbody>', '</table>', '</section>');
  return lines;
}

/**
 * A container's 1-based number on the sheet. Computed, so it is checked like `text`:
 * `0.5 + 1` would print `1.5` in one engine and be refused in another.
 */
function ordinal(index) {
  if (typeof index !== 'number' || !Number.isInteger(index)) {
    throw new OperationalArtifactError('invalid_value', `container index ${String(index)} is not an integer`);
  }
  return text(index + 1);
}

function escape(value) {
  return text(value).replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
}

function orDash(value) {
  return value === null || value === undefined ? DASH : escape(value);
}

// ------------------------------------------------------------------------------------- CSV

function csvField(value) {
  const spelled = text(value);
  return CSV_SPECIAL.test(spelled) ? `"${spelled.replace(/"/g, '""')}"` : spelled;
}

/**
 * The one rendering every engine shares: a string as itself, an integer in decimal, null as
 * nothing. Anything else -- a boolean, a fractional number, an object or array -- has a
 * different default spelling in each language, so it is refused rather than printed four ways.
 */
function text(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new OperationalArtifactError('invalid_value',
      `a ${describe(value)} has no single rendering in a work order`);
  }
  // Beyond 2^53 - 1 the parser has already rounded the integer, so its decimal would differ.
  if (!Number.isSafeInteger(value)) {
    throw new OperationalArtifactError('number_out_of_range',
      `${value} is beyond what every engine holds exactly`);
  }
  return String(value);
}

function describe(value) {
  if (Array.isArray(value)) return 'list';
  return typeof value === 'number' ? 'non-integer number' : typeof value;
}

/** Python's `Mapping.get`, reading only the object's own keys. */
function get(mapping, name) {
  const readable = mapping !== null && typeof mapping === 'object' && !Array.isArray(mapping)
    && Object.prototype.hasOwnProperty.call(mapping, name);
  return readable ? mapping[name] : null;
}

/** An export reads only a document it knows how to read, and says so when it cannot. */
function requireArtifact(artifact) {
  const found = get(artifact, 'format');
  if (found !== FORMAT) {
    throw new OperationalArtifactError('unknown_format',
      `cannot export format ${JSON.stringify(found)}; this exporter reads ${FORMAT}`);
  }
  return artifact;
}
