import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { backend, version } from '../index.js';
import { packFallback as pack } from '../fallback.js';
import { objective, validate } from './validate.mjs';

/**
 * The shared cross-language fixtures, judged by the same contract the Python
 * conformance runner applies.
 *
 * These fixtures have no expected output attached on purpose: implementations are free
 * to return different valid packings. What every one of them owes the caller is a
 * result that is physically sound and honestly scored, which is what is asserted here.
 * A blanket `result.complete` assertion would be wrong — `regression-group-atomicity`
 * is deliberately unsatisfiable.
 */

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../conformance/shared/fixtures');
const FIELD_MATRIX = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../conformance/shared/public-field-matrix.json',
);

// A cross-language fixture corpus kept in the native workspace tree; a published copy
// of this package does not carry it.
const hasFixtures = fs.existsSync(FIXTURES) && fs.existsSync(FIELD_MATRIX);
const names = hasFixtures
  ? fs.readdirSync(FIXTURES).filter((name) => name.endsWith('.json')).sort()
  : [];
const matrix = hasFixtures ? JSON.parse(fs.readFileSync(FIELD_MATRIX, 'utf8')) : null;

if (!hasFixtures) {
  test('the shared cross-language fixture corpus is not part of this package', { skip: true }, () => {});
}

// Whether a dotted, `*`-wildcarded field path (as used in the public-field matrix,
// e.g. `items.*.ground_contact_rule`) is set anywhere in a request.
function fieldPresent(node, parts) {
  if (parts.length === 0) return node != null;
  const [head, ...rest] = parts;
  if (head === '*') {
    return Array.isArray(node) && node.some((item) => fieldPresent(item, rest));
  }
  return node != null && typeof node === 'object' && head in node && fieldPresent(node[head], rest);
}

// The per-field `fixture` key is documentation (which fixture best showcases that
// field), not an exhaustive list of every fixture that touches it. A regression
// fixture can incidentally use a reference-only field without being that field's
// showcase, so support must be resolved from what the request actually contains.
function resolveSupport(request) {
  let expected = 'implemented';
  for (const [path, row] of Object.entries(matrix.fields)) {
    if (row.support === 'all' || !fieldPresent(request, path.split('.'))) continue;
    const level = matrix.support_sets[row.support].javascript;
    if (level === 'implemented') continue;
    assert.ok(
      expected === 'implemented' || expected === level,
      `${path}: conflicting support requirements (${expected} vs ${level})`,
    );
    expected = level;
  }
  return expected;
}

test('the fixture directory is present and populated', { skip: !hasFixtures }, () => {
  assert.ok(names.length > 0, `no fixtures found in ${FIXTURES}`);
});

test('the backend reports which engine answered', () => {
  assert.ok(['rust', 'javascript'].includes(backend()));
  assert.equal(typeof version(), 'string');
});

for (const name of names) {
  const request = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
  const expected = resolveSupport(request);

  if (expected !== 'implemented') {
    const expectedCode = expected.slice('rejected:'.length);
    test(`${name}: unsupported public fields are rejected structurally`, () => {
      assert.throws(
        () => pack(request),
        (error) => error?.code === expectedCode,
      );
    });
    continue;
  }

  test(`${name}: the result has the documented shape`, () => {
    const result = pack(request);
    assert.deepEqual(Object.keys(result).sort(), [
      'algorithm', 'alternatives', 'catalog_versions_used', 'complete', 'containers',
      'feasibility', 'objective', 'optimality', 'score', 'status', 'summary',
      'termination', 'unpacked_items', 'warnings',
    ]);
    assert.equal(typeof result.feasibility.code, 'string');
    assert.equal(typeof result.termination.code, 'string');
    assert.equal(typeof result.optimality.code, 'string');
    assert.ok(result.termination.starts.length > 0);
    assert.equal(
      result.termination.starts.filter((start) => start.selected).length,
      1,
    );
    assert.equal(
      result.termination.any_start_truncated,
      result.termination.starts.some((start) => start.truncated),
    );
    assert.equal(
      result.termination.all_required_starts_completed,
      result.termination.starts.every((start) => start.completed),
    );
    assert.equal(
      result.termination.winning_start_truncated,
      result.termination.starts.find((start) => start.selected).truncated,
    );
    assert.equal(
      result.termination.global_deadline_reached,
      result.termination.starts.some((start) => start.global_deadline_reached),
    );
    assert.equal(result.complete, result.unpacked_items.length === 0);
    assert.equal(result.summary.container_count, result.containers.length);
    assert.equal(result.summary.unpacked_item_count, result.unpacked_items.length);
    assert.equal(result.score.length, 5);
    assert.ok(result.score.every(Number.isInteger), 'every objective key must be an exact integer');
  });

  test(`${name}: the packing is physically sound`, () => {
    assert.deepEqual(validate(request, pack(request)), []);
  });

  test(`${name}: every unpacked item carries a reason`, () => {
    for (const entry of pack(request).unpacked_items) {
      assert.ok(entry.reason.length > 0, `${entry.item_id} was dropped without a reason`);
    }
  });

  if (request.configuration?.clearance == null) {
    test(`${name}: the reported score describes the reported packing`, () => {
      const result = pack(request);
      assert.deepEqual(result.score, objective(request, result));
    });
  }

  test(`${name}: a completed answer is reproducible`, (context) => {
    const first = pack(request);
    if (first.termination.global_deadline_reached || first.termination.any_start_truncated) {
      context.skip('wall-clock-truncated searches promise soundness, not bit identity');
      return;
    }
    assert.deepEqual(first, pack(request));
  });
}
