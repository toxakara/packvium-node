/**
 * The JavaScript port of the reference validator gives the reference's verdict on every
 * pair of the shared corpus, with no addon involved.
 *
 * `conformance/result_validation/corpus.json` (scripts/generate_result_validation_corpus.py) is
 * the subset of the cross-language corpus that reaches every arc, issue code and refusal kind the
 * full corpus reaches in the reference, each pair with the reference's outcome. Each pair is
 * parsed and handed to `validateWith(null, ...)`, so the port answers whatever this host has
 * built, and is judged by `conformance/result_validation/run.py`'s rules: the same issues in the
 * same order; for a `contract` refusal, a `contract` refusal with the same message (up to a quoted
 * Python exception); for a `shape` refusal, any refusal. The full five-thousand-pair comparison is
 * the workspace's result-validation conformance run, as its `engine-fallback` engine.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { MalformedResult, validateWith } from '../index.js';

const CORPUS = new URL('../../../../conformance/result_validation/corpus.json', import.meta.url);
const SOURCES = new URL('../result-validation/', import.meta.url);

/** Reference refusals that end by quoting a Python exception compare up to the quote. */
const QUOTES_PYTHON_ERROR = /^(placement is missing tick coordinates: |.*: lattice_summary is missing a canonical field: )/;

function outcome(requestText, resultText) {
  let request;
  let result;
  try {
    request = JSON.parse(requestText);
    result = JSON.parse(resultText);
  } catch (error) {
    // Text that is not JSON cannot reach `validate`; the reference refuses it as `shape`.
    return { refusal: { kind: 'shape', message: error.message } };
  }
  try {
    return { issues: validateWith(null, request, result) };
  } catch (error) {
    if (!(error instanceof MalformedResult)) throw error;
    return { refusal: { kind: error.kind, message: error.message } };
  }
}

function agrees(expected, actual) {
  if (expected.issues) return JSON.stringify(actual.issues) === JSON.stringify(expected.issues);
  if (!actual.refusal) return false;
  if (expected.refusal.kind !== 'contract') return true;
  const quoted = QUOTES_PYTHON_ERROR.exec(expected.refusal.message);
  return actual.refusal.kind === 'contract'
    && (quoted ? actual.refusal.message.startsWith(quoted[1]) : actual.refusal.message === expected.refusal.message);
}

if (!fs.existsSync(CORPUS)) {
  test('the shared result-validation corpus is not part of this package', { skip: true }, () => {});
} else {
  const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));

  test('every pair of the corpus gets the reference\'s verdict from the JavaScript port', () => {
    assert.equal(corpus.format, 'packvium-result-validation-corpus/v1');
    const disagreements = corpus.cases
      .map((pair, index) => ({ index, expected: pair.expected, actual: outcome(pair.request, pair.result) }))
      .filter(({ expected, actual }) => !agrees(expected, actual));
    assert.deepEqual(disagreements, []);
  });

  test('the corpus reaches every issue code the port can raise', () => {
    const raisable = new Set();
    for (const name of fs.readdirSync(SOURCES).filter((file) => file.endsWith('.js'))) {
      const source = fs.readFileSync(new URL(name, SOURCES), 'utf8');
      for (const match of source.matchAll(/issue\('([a-z_0-9]+)'/g)) raisable.add(match[1]);
    }
    const raised = new Set(corpus.cases.flatMap((pair) => (pair.expected.issues || []).map((found) => found.code)));
    assert.deepEqual([...raisable].filter((code) => !raised.has(code)), []);
    assert.ok(raisable.size >= 70, `only ${raisable.size} issue codes found in the port's source`);
  });
}
