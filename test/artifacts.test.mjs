/**
 * The operational artifact and its exports in JavaScript.
 *
 * docs/OPERATIONAL-ARTIFACTS.md is the contract and `packvium.artifacts` is the reference; these
 * tests mirror `packvium-python/tests/test_artifacts.py` and `test_canonical_json.py`. The
 * modules are imported by package name, so a missing `exports` entry fails here and not only in
 * a consumer's project. Strings that carry surrogates or line separators are built from code
 * points, so this source stays ASCII.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FORMAT,
  OperationalArtifactError,
  SUITE_VERSION,
  buildOperationalArtifact,
  canonicalArtifactJson,
} from '@packvium/engine/artifacts.js';
import {
  CSV_COLUMNS,
  exportCsv,
  exportJson,
  exportWorkOrderHtml,
} from '@packvium/engine/artifact-exports.js';
import { buildExecutionPlan, canonicalPlanJson } from '@packvium/engine/execution.js';

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TICKS_PER_MM = 16000;
const LINE_SEPARATOR = String.fromCharCode(0x2028);

const scalar = (ticks, unit = 'mm') => ({
  ticks, unit, value: String(Math.trunc(ticks / (unit === 'mm' ? TICKS_PER_MM : 8000))),
});

const placement = (itemType, xMm, lengthMm = 10, orientation = 'LWH') => ({
  item_id: `${itemType}#${xMm}`,
  item_type: itemType,
  orientation,
  position: { x: scalar(xMm * TICKS_PER_MM), y: scalar(0), z: scalar(0) },
  dimensions: {
    length: scalar(lengthMm * TICKS_PER_MM), width: scalar(10 * TICKS_PER_MM), height: scalar(10 * TICKS_PER_MM),
  },
  support_ratio: '1.000000',
  top_load: scalar(0, 'g'),
});

const ALGORITHM = {
  profile: 'balanced', solver: 'extreme_point', seed: 7, duration_ms: 41,
  time_limit_reached: false, effort_limit_reached: false,
};

function result({ algorithm = ALGORITHM, placements, unpacked } = {}) {
  const built = {
    status: 'feasible',
    objective: 'default',
    score: [1, 0, 250],
    feasibility: { code: 'all_items_packed' },
    optimality: null,
    containers: [{
      id: 'crate#1',
      container_type: 'crate',
      inner_dimensions: {
        length: scalar(100 * TICKS_PER_MM), width: scalar(100 * TICKS_PER_MM), height: scalar(100 * TICKS_PER_MM),
      },
      payload_weight: scalar(8000, 'g'),
      gross_weight: scalar(16000, 'g'),
      volume_utilization: '0.002000',
      placements: placements ?? [placement('box', 0), placement('tin', 10, 5)],
    }],
    unpacked_items: unpacked ?? [],
    catalog_versions_used: [{ catalog_id: 'cartons', version: 3, effective_at: 10, resolved_at: 11 }],
  };
  if (algorithm !== null) built.algorithm = algorithm;
  return built;
}

const REQUEST = {
  items: [{ id: 'box', dimensions: { length: 10, width: 10, height: 10 }, minimum_support_ratio: 0.25 }],
  containers: [{ id: 'crate', inner_dimensions: { length: 100, width: 100, height: 100 } }],
};

function codeOf(run) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof OperationalArtifactError, `${error.name}: ${error.message}`);
    return error.code;
  }
  assert.fail('expected an OperationalArtifactError');
}

const artifactOf = (options) => buildOperationalArtifact(REQUEST, result(options), { loadingOrders: { 0: [1, 0] } });

// ------------------------------------------------------------------------ canonical JSON

// RFC 8785 numbers are ECMAScript's own, so these pin the rules rather than the arithmetic.
const NUMBERS = [
  [0.25, '0.25'], [1.0, '1'], [-0, '0'], [4.5, '4.5'], [0.1, '0.1'], [2e-3, '0.002'],
  [0.000001, '0.000001'], [1e-7, '1e-7'], [1.5e-7, '1.5e-7'], [1e-27, '1e-27'], [-1.5, '-1.5'],
  [123456789.5, '123456789.5'], [333333333.33333329, '333333333.3333333'],
  [9007199254740991, '9007199254740991'], [5e-324, '5e-324'], [100.0, '100'],
];

test('numbers are written as ECMAScript writes them', () => {
  for (const [value, spelled] of NUMBERS) assert.equal(canonicalArtifactJson(value), spelled);
  assert.equal(canonicalArtifactJson([0, -7, true, false, null]), '[0,-7,true,false,null]');
});

test('keys are sorted by UTF-16 code units, not code points', () => {
  // U+FFFD sorts after U+1F600 by code point and before it by UTF-16 code unit.
  const replacement = String.fromCharCode(0xFFFD);
  const grin = String.fromCodePoint(0x1F600);
  assert.equal(canonicalArtifactJson({ [replacement]: 1, [grin]: 2, a: 0 }),
    `{"a":0,"${grin}":2,"${replacement}":1}`);
});

test('only the characters RFC 8785 names are escaped', () => {
  const others = `/${String.fromCharCode(0x7F, 0x2028, 0x2029)}\u00e9`;
  const text = `"\\\b\t\n\f\r${String.fromCharCode(0, 0x1F)}${others}`;
  assert.equal(canonicalArtifactJson(text), `"\\"\\\\\\b\\t\\n\\f\\r\\u0000\\u001f${others}"`);
  for (let code = 0; code < 0x20; code += 1) {
    assert.match(canonicalArtifactJson(String.fromCharCode(code)), /^"\\([btnfr]|u00[0-9a-f]{2})"$/);
  }
});

test('there is no whitespace, nesting is preserved and arrays keep their order', () => {
  assert.equal(canonicalArtifactJson({ b: [1, { d: [], c: {} }], a: 'x' }), '{"a":"x","b":[1,{"c":{},"d":[]}]}');
});

test('a number no engine holds exactly is refused', () => {
  for (const value of [2 ** 53, -(2 ** 53), Infinity, -Infinity, NaN]) {
    assert.equal(codeOf(() => canonicalArtifactJson({ n: value })), 'number_out_of_range', String(value));
  }
});

test('a lone surrogate is refused in a value and in a key', () => {
  const high = String.fromCharCode(0xD800);
  const low = String.fromCharCode(0xDC00);
  for (const value of [high, `a${low}`, `${low}${high}`, { [low]: 1 }, [`x${high}y`]]) {
    assert.equal(codeOf(() => canonicalArtifactJson(value)), 'invalid_string');
  }
  assert.equal(canonicalArtifactJson(high + low), `"${high}${low}"`, 'a pair is well formed');
});

test('a value JSON cannot spell is refused', () => {
  // eslint-disable-next-line no-sparse-arrays
  const values = [undefined, { a: undefined }, () => 1, 1n, Symbol('s'), new Map(), new Set([1]),
    new Date(0), [1, , 2], { [Symbol('k')]: 1 }];
  for (const value of values) assert.equal(codeOf(() => canonicalArtifactJson(value)), 'invalid_value');
});

test('the plan uses the same canonical form', () => {
  const plan = buildExecutionPlan(REQUEST, result(), { loadingOrders: { 0: [1, 0] } });
  assert.equal(canonicalPlanJson(plan), canonicalArtifactJson(plan));
  assert.throws(() => canonicalPlanJson({ ...plan, objective: String.fromCharCode(0xDFFF) }),
    (error) => error.code === 'invalid_string');
});

// -------------------------------------------------------------------------- the document

test('the plan inside is exactly the plan builder output', () => {
  const orders = { 0: [1, 0] };
  const artifact = buildOperationalArtifact(REQUEST, result(), { loadingOrders: orders });
  assert.equal(artifact.format, FORMAT);
  assert.equal(artifact.suite_version, SUITE_VERSION);
  assert.equal(canonicalPlanJson(artifact.plan),
    canonicalPlanJson(buildExecutionPlan(REQUEST, result(), { loadingOrders: orders })));
});

test('the suite version is the package version', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.equal(SUITE_VERSION, manifest.version);
});

test('the request is embedded as given, with its fractional numbers', () => {
  const artifact = buildOperationalArtifact(REQUEST, result());
  assert.deepEqual(artifact.provenance.request, REQUEST);
  assert.ok(canonicalArtifactJson(artifact).includes('"minimum_support_ratio":0.25'));
});

test('geometry is in result order, in tick strings, addressed by placement reference', () => {
  const [container] = buildOperationalArtifact(REQUEST, result()).geometry.containers;
  assert.deepEqual(container.inner_dimensions, { length: '1600000', width: '1600000', height: '1600000' });
  assert.deepEqual(container.placements.map((entry) => entry.placement.item_type), ['box', 'tin']);
  assert.equal(container.placements[1].dimensions.length, '80000');
  assert.ok(!JSON.stringify(container).includes('item_id'));
});

test('work order lines follow the plan steps and copy rendered values', () => {
  const artifact = artifactOf();
  const workOrder = artifact.work_order;
  const [container] = workOrder.containers;
  assert.deepEqual([workOrder.length_unit, workOrder.weight_unit], ['mm', 'g']);
  assert.deepEqual([container.payload_weight, container.gross_weight], ['1', '2']);
  assert.deepEqual(container.lines.map((line) => [line.sequence, line.placement.item_type]), [[1, 'tin'], [2, 'box']]);
  assert.deepEqual(container.lines[0].position, { x: '10', y: '0', z: '0' });
  assert.deepEqual(artifact.plan.containers[0].steps.map((step) => step.placement),
    container.lines.map((line) => line.placement));
});

test('without a loading order no line is numbered', () => {
  const { lines } = buildOperationalArtifact(REQUEST, result()).work_order.containers[0];
  assert.ok(lines.every((line) => !('sequence' in line)));
});

test('a result without containers has no units and no lines', () => {
  const empty = { ...result(), containers: [] };
  assert.deepEqual(buildOperationalArtifact(REQUEST, empty).work_order,
    { length_unit: null, weight_unit: null, containers: [] });
});

// ---------------------------------------------------------------------------- provenance

test('the solver is the deterministic part of the algorithm and wall clock never enters', () => {
  const artifact = buildOperationalArtifact(REQUEST, result());
  assert.deepEqual(artifact.provenance.solver, {
    profile: 'balanced', solver: 'extreme_point', seed: 7, time_limit_reached: false, effort_limit_reached: false,
  });
  assert.deepEqual(artifact.provenance.replay, { level: 'exact', because: null });
  assert.equal(artifact.provenance.catalog_versions_used[0].catalog_id, 'cartons');
  assert.ok(!canonicalArtifactJson(artifact).includes('duration_ms'));
});

test('a search stopped by the clock is not promised an exact replay', () => {
  const { replay } = buildOperationalArtifact(REQUEST, result({
    algorithm: { ...ALGORITHM, time_limit_reached: true },
  })).provenance;
  assert.deepEqual(replay, { level: 'not_guaranteed', because: 'provenance.solver.time_limit_reached' });
});

test('a result that does not say how it was solved is not promised one either', () => {
  const { provenance } = buildOperationalArtifact(REQUEST, result({ algorithm: null }));
  assert.equal(provenance.solver, null);
  assert.deepEqual(provenance.replay, { level: 'not_guaranteed', because: 'provenance.solver' });
});

// ------------------------------------------------------------------------------ refusals

test('a request that is not an object is refused', () => {
  for (const request of [[], null, 'request']) {
    assert.equal(codeOf(() => buildOperationalArtifact(request, result())), 'invalid_request');
  }
  assert.equal(codeOf(() => buildOperationalArtifact(REQUEST, [])), 'invalid_result');
});

test('a loading order that is not a permutation is refused by the plan', () => {
  assert.equal(codeOf(() => buildOperationalArtifact(REQUEST, result(), { loadingOrders: { 0: [0, 0] } })),
    'invalid_plan_input');
});

test('values in two units are refused rather than printed as one', () => {
  const mixed = result();
  mixed.containers[0].placements[0].position.x.unit = 'cm';
  assert.equal(codeOf(() => buildOperationalArtifact(REQUEST, mixed)), 'mixed_units');
});

test('two placements with one reference are refused', () => {
  const duplicated = result({ placements: [placement('box', 0), placement('box', 0)] });
  assert.equal(codeOf(() => buildOperationalArtifact(REQUEST, duplicated)), 'invalid_result');
});

test('a container without inner dimensions is refused', () => {
  const broken = result();
  delete broken.containers[0].inner_dimensions;
  assert.equal(codeOf(() => buildOperationalArtifact(REQUEST, broken)), 'invalid_result');
});

test('an algorithm record that is incomplete or mistyped is refused', () => {
  for (const algorithm of [{ profile: 'fast' }, { ...ALGORITHM, time_limit_reached: 'no' }, 'fast']) {
    assert.equal(codeOf(() => buildOperationalArtifact(REQUEST, result({ algorithm }))), 'invalid_result');
  }
});

test('a catalog reference that is incomplete or mistyped is refused', () => {
  const catalog = { catalog_id: 'cartons', version: 3, effective_at: 10, resolved_at: 11 };
  const broken = [
    { ...catalog, version: 1.5 }, { ...catalog, effective_at: true }, { ...catalog, resolved_at: '11' },
    { ...catalog, catalog_id: 7 }, { catalog_id: 'cartons', version: 3, effective_at: 10 },
  ];
  for (const entry of broken) {
    const mistyped = { ...result(), catalog_versions_used: [entry] };
    assert.equal(codeOf(() => buildOperationalArtifact(REQUEST, mistyped)), 'invalid_result', JSON.stringify(entry));
  }
});

test('a non-object list entry is refused as an invalid result before the plan is built', () => {
  // A non-permutation order would be `invalid_plan_input` from the plan builder; the entry
  // check runs first, so every engine names the malformed result instead.
  const orders = { loadingOrders: { 0: [0, 0] } };
  const cases = [
    { ...result(), containers: ['crate'] },
    { ...result(), unpacked_items: [null] },
    { ...result(), alternatives: [[1, 0]] },
    { ...result(), alternatives: { score: [1] } },
    { ...result(), catalog_versions_used: ['cartons'] },
    result({ placements: [placement('box', 0), 'tin'] }),
  ];
  for (const broken of cases) {
    assert.equal(codeOf(() => buildOperationalArtifact(REQUEST, broken, orders)), 'invalid_result');
  }
});

test('a field is read from the object itself, never from its prototype', () => {
  // `field in object` would find `constructor` on every object; a missing key must stay missing.
  const broken = result();
  broken.containers[0].inner_dimensions = Object.create({ length: scalar(1), width: scalar(1), height: scalar(1) });
  assert.equal(codeOf(() => buildOperationalArtifact(REQUEST, broken)), 'invalid_result');
});

test('a request number JavaScript cannot hold is refused', () => {
  assert.equal(codeOf(() => buildOperationalArtifact({ ...REQUEST, metadata: { order: 2 ** 53 } }, result())),
    'number_out_of_range');
});

test('a tick count beyond 2^53 - 1 is refused rather than written as a rounded length', () => {
  const huge = result();
  huge.containers[0].inner_dimensions.width.ticks = 2 ** 60;
  assert.equal(codeOf(() => buildOperationalArtifact(REQUEST, huge)), 'number_out_of_range');
});

test('a result that is not an object is refused', () => {
  for (const notAnObject of [null, 'result', 42, [result()]]) {
    assert.equal(codeOf(() => buildOperationalArtifact(REQUEST, notAnObject)), 'invalid_result', String(notAnObject));
  }
});

test('a list field that is not a list is refused before the plan is built', () => {
  // `{}` and a string would each be iterated differently by the four languages' plan builders.
  const orders = { loadingOrders: { 0: [0, 0] } };
  for (const [name, value] of [['containers', {}], ['unpacked_items', 'jack'], ['catalog_versions_used', {}]]) {
    const broken = { ...result(), [name]: value };
    assert.equal(codeOf(() => buildOperationalArtifact(REQUEST, broken, orders)), 'invalid_result', name);
  }
});

test('geometry ticks that are not an integer are refused', () => {
  // A fraction, a boolean or a numeric string has no single decimal spelling across engines;
  // copying the string would also hide that the result broke its own schema.
  for (const ticks of [1.5, true, '160000', null]) {
    const inner = result();
    inner.containers[0].inner_dimensions.width.ticks = ticks;
    assert.equal(codeOf(() => buildOperationalArtifact(REQUEST, inner)), 'invalid_result', `inner ${String(ticks)}`);
    const placed = result();
    placed.containers[0].placements[1].dimensions.height.ticks = ticks;
    assert.equal(codeOf(() => buildOperationalArtifact(REQUEST, placed)), 'invalid_result', `placement ${String(ticks)}`);
  }
});

test('a rendered value that is not a string is refused rather than re-rendered', () => {
  // The work order copies the result's rendering; a number here would be rendered by this
  // engine instead, which is exactly what the artifact promises never to do.
  const edits = [
    (built) => { built.containers[0].placements[0].position.x.value = 0; },
    (built) => { built.containers[0].placements[1].dimensions.length.value = null; },
    (built) => { built.containers[0].payload_weight.value = 1; },
    (built) => { built.containers[0].gross_weight.value = ['2']; },
  ];
  for (const edit of edits) {
    const broken = result();
    edit(broken);
    assert.equal(codeOf(() => buildOperationalArtifact(REQUEST, broken)), 'invalid_result', String(edit));
  }
});

test('a printed integer beyond 2^53 - 1 is refused rather than printed rounded', () => {
  // Reachable only through an artifact edited after it was built: the builder would have
  // refused the same number. JSON refuses it too, so the exports agree.
  const edited = JSON.parse(JSON.stringify(artifactOf()));
  edited.work_order.containers[0].lines[0].placement.position_ticks.x = 2 ** 60;
  assert.equal(codeOf(() => exportCsv(edited)), 'number_out_of_range');
  assert.equal(codeOf(() => exportJson(edited)), 'number_out_of_range');
  const heading = JSON.parse(JSON.stringify(artifactOf()));
  heading.work_order.containers[0].container_index = Number.MAX_SAFE_INTEGER;
  assert.equal(codeOf(() => exportWorkOrderHtml(heading)), 'number_out_of_range', 'the index plus one');
});

test('the builder imports no solver, validator, renderer or clock', () => {
  const allowed = {
    'canonical-json.js': [],
    'artifacts.js': ['./canonical-json.js', './execution.js'],
    'artifact-exports.js': ['./artifacts.js'],
  };
  for (const [name, imports] of Object.entries(allowed)) {
    const source = fs.readFileSync(path.join(PACKAGE_ROOT, name), 'utf8');
    const found = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gms)].map((match) => match[1]).sort();
    assert.deepEqual(found, imports, name);
    for (const forbidden of ['require(', 'Date', 'performance', 'Math.random', 'import(']) {
      assert.ok(!source.includes(forbidden), `${name} uses ${forbidden}`);
    }
  }
});

// ------------------------------------------------------------------------------- exports

test('the JSON export is the canonical artifact', () => {
  const artifact = artifactOf();
  assert.equal(exportJson(artifact), canonicalArtifactJson(artifact));
  assert.deepEqual(JSON.parse(exportJson(artifact)), JSON.parse(JSON.stringify(artifact)));
});

test('a printed value that is not a string, an integer or null is refused by CSV and HTML', () => {
  // Each builds: the artifact carries these values faithfully. Only printing them has no
  // spelling every engine shares.
  const printed = [
    [result(), (built) => { built.feasibility = { code: true }; }, [exportWorkOrderHtml]],
    [result(), (built) => { built.containers[0].volume_utilization = 0.5; }, [exportWorkOrderHtml]],
    [result(), (built) => { built.containers[0].container_type = { name: 'crate' }; }, [exportCsv, exportWorkOrderHtml]],
    [result({ unpacked: [{ item_type: ['jack'], reason: 'r', proof: { level: 'proven' } }] }), () => {}, [exportCsv, exportWorkOrderHtml]],
    [result({ algorithm: { ...ALGORITHM, seed: false } }), () => {}, [exportWorkOrderHtml]],
  ];
  for (const [built, change, exporters] of printed) {
    change(built);
    const artifact = buildOperationalArtifact(REQUEST, built);
    assert.equal(typeof exportJson(artifact), 'string');
    for (const exporter of exporters) assert.equal(codeOf(() => exporter(artifact)), 'invalid_value', exporter.name);
  }
});

test('integers print in decimal and null prints as nothing', () => {
  const artifact = artifactOf();
  artifact.work_order.containers[0].container_type = null;
  artifact.work_order.containers[0].lines[0].placement.orientation = -0;
  const [, row] = exportCsv(artifact).split('\r\n');
  assert.equal(row, 'step,0,,1,tin,0,160000,0,0,10,0,0,5,10,10,mm,,');
});

test('the container heading number is refused unless the index is an integer', () => {
  // The heading prints `container_index + 1`, a computed value, so it is held to the same rule
  // as a copied one. CSV prints the plan reference's index, not this one, and is unaffected.
  const artifact = artifactOf();
  assert.ok(exportWorkOrderHtml(artifact).includes('<h2>Container 1: crate</h2>'));
  for (const index of [0.5, true, false, '0', null]) {
    const edited = JSON.parse(JSON.stringify(artifact));
    edited.work_order.containers[0].container_index = index;
    assert.equal(codeOf(() => exportWorkOrderHtml(edited)), 'invalid_value', String(index));
  }
});

test('every export refuses a document it cannot read', () => {
  for (const exporter of [exportJson, exportCsv, exportWorkOrderHtml]) {
    assert.equal(codeOf(() => exporter({ ...artifactOf(), format: 'packvium-operational-artifact/v2' })),
      'unknown_format');
    assert.equal(codeOf(() => exporter(['not', 'an', 'artifact'])), 'unknown_format');
    assert.equal(codeOf(() => exporter(null)), 'unknown_format');
  }
});

test('the CSV has a header, one row per step in order and one per unplaced item', () => {
  const unpacked = [{
    item_id: 'jack#1', item_type: 'jack', reason: 'no_compatible_container_dimensions', details: [],
    proof: { level: 'proven' },
  }];
  const rows = exportCsv(artifactOf({ unpacked })).split('\r\n');
  assert.equal(rows[0], CSV_COLUMNS.join(','));
  assert.equal(rows[1], 'step,0,crate,1,tin,LWH,160000,0,0,10,0,0,5,10,10,mm,,');
  assert.equal(rows[2], 'step,0,crate,2,box,LWH,0,0,0,0,0,0,10,10,10,mm,,');
  assert.equal(rows[3], 'unplaced,,,,jack,,,,,,,,,,,,no_compatible_container_dimensions,proven');
  assert.equal(rows[4], '');
  assert.equal(rows.length, 5);
});

test('a CSV field is quoted only when it must be and never rewritten', () => {
  const quoted = result({
    placements: [placement('a,"b"', 0), placement('=SUM(A1)', 10), placement('two\nlines', 20),
      placement(`sep${LINE_SEPARATOR}arator`, 30)],
  });
  const text = exportCsv(buildOperationalArtifact(REQUEST, quoted));
  assert.ok(text.includes(',"a,""b""",'));
  assert.ok(text.includes(',=SUM(A1),'));
  assert.ok(text.includes(',"two\nlines",'));
  assert.ok(text.includes(`,sep${LINE_SEPARATOR}arator,`));
});

test('the work order is self-contained, escaped and lists every step', () => {
  const escaped = result({ placements: [placement('<b>&\'"', 0), placement('tin', 10, 5)] });
  const html = exportWorkOrderHtml(buildOperationalArtifact(REQUEST, escaped, { loadingOrders: { 0: [1, 0] } }));
  assert.ok(html.startsWith('<!DOCTYPE html>\n') && html.endsWith('</html>\n'));
  assert.ok(!html.includes('<script') && !html.includes('http') && !html.includes(' src='));
  assert.ok(html.includes('&lt;b&gt;&amp;&#39;&quot;') && !html.includes('<b>&\''));
  assert.equal(html.split('&#9744;').length - 1, 2);
  assert.ok(html.includes('Order: loading.') && html.includes('extreme_point') && html.includes('cartons v3'));
  assert.ok(/^[\x00-\x7F]*$/.test(html), 'the source is ASCII');
});

test('the work order says when there is no order and when everything was packed', () => {
  const html = exportWorkOrderHtml(buildOperationalArtifact(REQUEST, result()));
  assert.ok(html.includes('Order: unavailable.'));
  assert.ok(html.includes('<p>Every item was packed.</p>'));
});

test('exports are deterministic and leave the artifact untouched', () => {
  const artifact = artifactOf();
  const before = canonicalArtifactJson(artifact);
  for (const exporter of [exportJson, exportCsv, exportWorkOrderHtml]) {
    assert.equal(exporter(artifact), exporter(artifact));
  }
  assert.equal(canonicalArtifactJson(artifact), before);
});

// ---------------------------------------------------------------------------- the corpus

// The golden corpus and the requests it answers live in the workspace only; a published copy
// of this package does not carry them.
const CONFORMANCE = path.resolve(PACKAGE_ROOT, '../../../conformance');
const GOLDEN = path.join(CONFORMANCE, 'golden');
const FIXTURES = path.join(CONFORMANCE, 'fixtures');
const hasCorpus = fs.existsSync(GOLDEN) && fs.existsSync(FIXTURES);

test('every golden result with its request builds an artifact every export can read',
  { skip: hasCorpus ? false : 'the corpus lives in the workspace only' }, () => {
    let built = 0;
    for (const name of fs.readdirSync(GOLDEN).filter((entry) => entry.endsWith('.json')).sort()) {
      const golden = JSON.parse(fs.readFileSync(path.join(GOLDEN, name), 'utf8'));
      const fixture = path.join(FIXTURES, name);
      if (golden === null || typeof golden !== 'object' || !('status' in golden) || !fs.existsSync(fixture)) continue;
      const request = JSON.parse(fs.readFileSync(fixture, 'utf8'));
      const loadingOrders = {};
      (golden.containers ?? []).forEach((container, index) => {
        loadingOrders[index] = (container.placements ?? []).map((_, position) => position).reverse();
      });
      const artifact = buildOperationalArtifact(request, golden, { loadingOrders });
      assert.deepEqual(JSON.parse(exportJson(artifact)).plan, JSON.parse(canonicalPlanJson(artifact.plan)), name);
      exportCsv(artifact);
      exportWorkOrderHtml(artifact);
      built += 1;
    }
    assert.ok(built >= 398, `built ${built}`);
  });
