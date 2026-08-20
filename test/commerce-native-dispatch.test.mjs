/**
 * The native commerce dispatch inside `index.js`.
 *
 * `commerce.test.mjs` proves the real Rust addon and the JavaScript fallback agree, but
 * it loads the addon itself, by its in-workspace build path. The package's own probe
 * list is `['./packvium-native.node', '@packvium/native']`, and neither resolves in this
 * workspace -- so `viaNative`, the branch every installed user with the addon takes, was
 * never executed by any test or measured by any coverage run.
 *
 * This supplies a stub at the specifier the package actually probes. `index.js` captures
 * the module object once and reads each entry point off it per call, so one import is
 * enough: every case below reshapes the same stub rather than reloading the package.
 * That matters for more than tidiness -- importing `index.js` twice under different URLs
 * puts two records for one file into the coverage report, which the coverage gate
 * refuses as untrustworthy.
 *
 * No file is written, and the interception is removed as soon as the import completes,
 * so nothing here can leak into another suite -- or, worse, into a published package
 * that then believes it has a native backend.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

/** Reshaped per case; `index.js` reads its entry points at call time, not at load time. */
const stub = {};

const previousLoad = Module._load;
Module._load = function loadWithStubbedNativeBackend(request, parent, isMain) {
  if (request === '@packvium/native') return stub;
  return previousLoad.call(this, request, parent, isMain);
};
const engine = await import('../index.js');
Module._load = previousLoad;

const DOCUMENT = { tariffs: [] };
const REQUEST = { marker: 'probe' };

/** @param {Record<string, unknown>} entries what this case's addon exports */
function addon(entries) {
  for (const key of Object.keys(stub)) delete stub[key];
  Object.assign(stub, entries);
}

test('each commerce function reaches its own native entry point', () => {
  const seen = {};
  const entry = (name) => (json) => {
    seen[name] = JSON.parse(json);
    return JSON.stringify({ entry: name });
  };
  addon({
    commerceQuoteJson: entry('commerceQuoteJson'),
    commerceEvaluatePolicyJson: entry('commerceEvaluatePolicyJson'),
    commerceCatalogVersionInfoJson: entry('commerceCatalogVersionInfoJson'),
  });

  assert.equal(engine.commerce.backend(), 'rust', 'a loadable addon must be reported as the backend');

  for (const [method, name] of [
    ['quote', 'commerceQuoteJson'],
    ['evaluatePolicy', 'commerceEvaluatePolicyJson'],
    ['catalogVersionInfo', 'commerceCatalogVersionInfoJson'],
  ]) {
    assert.deepEqual(engine.commerce[method](DOCUMENT, REQUEST), { entry: name });
    // One `{document, request}` envelope, not two arguments and not a flattened object.
    assert.deepEqual(seen[name], { document: DOCUMENT, request: REQUEST });
  }
});

test('a native failure surfaces as the same error the fallback raises', () => {
  addon({ commerceQuoteJson: () => { throw new Error('request.zone: expected a string'); } });

  assert.throws(
    () => engine.commerce.quote(DOCUMENT, REQUEST),
    (error) => error instanceof engine.CommerceInputError
      && error.message === 'request.zone: expected a string',
    'a caller must not have to know which backend answered in order to catch the failure',
  );
});

test('an addon that answers with something other than JSON is not silently accepted', () => {
  addon({ commerceQuoteJson: () => '{ this is not JSON' });

  assert.throws(() => engine.commerce.quote(DOCUMENT, REQUEST), engine.CommerceInputError);
});

test('an addon carrying only some of the three functions falls back for the rest', () => {
  addon({ commerceQuoteJson: () => JSON.stringify({ entry: 'native' }) });

  assert.deepEqual(engine.commerce.quote(DOCUMENT, REQUEST), { entry: 'native' });

  // No native `commerceEvaluatePolicyJson`, so this must reach the JavaScript fallback
  // and be refused there for the same reason the fallback always refuses it.
  assert.throws(
    () => engine.commerce.evaluatePolicy(DOCUMENT, REQUEST),
    engine.CommerceInputError,
    'a partial addon must not make an operation disappear',
  );
});

test('an addon with no commerce surface at all leaves the package on the fallback', () => {
  addon({ packJson: (input) => input });

  assert.equal(engine.commerce.backend(), 'javascript');
  assert.equal(engine.backend(), 'rust', 'packing still uses the addon it does carry');
});

/**
 * `rebalanceWeight` is the one other native dispatch on this entry point, and it was
 * unreachable for the same reason. Covered here rather than in its own file because the
 * stub is what makes it reachable, and a second module instance is what the coverage
 * gate refuses.
 */
test('rebalanceWeight routes to the addon with its arguments already serialised', () => {
  let seen = null;
  addon({
    rebalanceJson: (request, result, maxMoves) => {
      seen = { request, result, maxMoves };
      return JSON.stringify({ moves: [] });
    },
  });

  const answer = engine.rebalanceWeight({ id: 'r' }, { id: 's' }, { maxMoves: 3 });

  assert.deepEqual(answer, { moves: [] });
  assert.deepEqual(seen, { request: '{"id":"r"}', result: '{"id":"s"}', maxMoves: 3 });
});

test('rebalanceWeight falls back when the addon does not carry it', () => {
  addon({});
  const side = { length: '100', width: '100', height: '100' };
  const request = {
    units: { length: 'mm' },
    items: [{ id: 'a', dimensions: side }, { id: 'b', dimensions: side }],
    containers: [{ id: 'box', inner_dimensions: { length: '300', width: '100', height: '100' } }],
  };

  const balanced = engine.rebalanceWeight(request, engine.pack(request), { maxMoves: 0 });

  assert.deepEqual(balanced.moves, [], 'a zero-move budget can only produce no moves');
  assert.equal(balanced.containers.length, 1);
});

test('an out-of-range maxMoves is refused before either backend is consulted', () => {
  let called = false;
  addon({ rebalanceJson: () => { called = true; return '{}'; } });

  for (const maxMoves of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => engine.rebalanceWeight({}, {}, { maxMoves }),
      RangeError,
      `expected ${maxMoves} to be refused`,
    );
  }
  assert.equal(called, false, 'the guard must run before the addon is called');
});
