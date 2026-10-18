/**
 * The native path of `index.js` against the fallback's contract: an addon's
 * refusals arrive as the fallback's error classes, `maxMoves` is bounded by the addon's
 * `u32`, and an addon from another release is not used.
 *
 * The first part drives `packJsonWith` / `rebalanceWeightWith` with stand-in bindings that
 * raise what the compiled addon raises -- a plain `Error` whose `code`, `reason`, `field` and
 * `detail` are properties -- so it runs everywhere. The last test loads a real compiled addon
 * when `PACKVIUM_NODE_ADDON` names one (`cargo build --release -p packvium-node-native`
 * output); no build is part of this suite, so without it that test is skipped.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

import {
  FixedPlacementError,
  InvalidRequestError,
  UnsupportedFeatureError,
  packJsonWith,
  rebalanceWeightWith,
} from '../index.js';
import { packFallback } from '../fallback.js';
import { PACKAGE_VERSION, packageWithNativeAddon, packageWithNativeStandIn } from './native-stand-in.mjs';

const REQUEST = JSON.stringify({
  items: [{ id: 'cube', quantity: 1, dimensions: { length: '1', width: '1', height: '1' } }],
  containers: [{ id: 'box', inner_dimensions: { length: '2', width: '2', height: '2' } }],
});

/** What the compiled addon throws: a plain `Error` with the core's refusal as properties. */
function nativeRefusal(message, properties) {
  return Object.assign(new Error(message), properties);
}

const raising = (error) => ({ packJson: () => { throw error; } });

test('a native invalid_request arrives as the fallback\'s InvalidRequestError', () => {
  const error = nativeRefusal('invalid_request: /items/0/quantity: must be at least 1', {
    code: 'invalid_request', reason: 'below_minimum', field: '/items/0/quantity', detail: 'must be at least 1',
  });
  assert.throws(() => packJsonWith(raising(error), REQUEST), (thrown) => thrown instanceof InvalidRequestError
    && thrown.name === 'InvalidRequestError'
    && thrown.message === error.message
    && [thrown.code, thrown.reason, thrown.field, thrown.detail].join('|')
      === 'invalid_request|below_minimum|/items/0/quantity|must be at least 1');
});

test('a native invalid_fixed_placement arrives as the fallback\'s FixedPlacementError', () => {
  const error = nativeRefusal('invalid_fixed_placement: collision: cube#1 with cube#2', {
    code: 'invalid_fixed_placement', reason: 'cannot_hold', field: '/fixed_placements',
    detail: 'collision: cube#1 with cube#2',
  });
  assert.throws(() => packJsonWith(raising(error), REQUEST), (thrown) => thrown instanceof FixedPlacementError
    && thrown instanceof InvalidRequestError
    && thrown.message === error.message
    && [thrown.reason, thrown.field, thrown.detail].join('|')
      === 'cannot_hold|/fixed_placements|collision: cube#1 with cube#2');
});

test('a native unsupported_feature arrives as UnsupportedFeatureError, fields and core sentence kept', () => {
  const message = 'unsupported_feature: Rust core does not yet implement container.a, item.b; '
    + 'the request was rejected instead of silently ignoring public fields';
  const error = nativeRefusal(message, { code: 'unsupported_feature' });
  assert.throws(() => packJsonWith(raising(error), REQUEST), (thrown) => thrown instanceof UnsupportedFeatureError
    && thrown.code === 'unsupported_feature'
    && thrown.message === message
    && thrown.fields.join() === 'container.a,item.b');
});

test('a native error with any other code is re-thrown as raised', () => {
  const error = nativeRefusal('time limit reached', { code: 'time_limit' });
  assert.throws(() => packJsonWith(raising(error), REQUEST), (thrown) => thrown === error);
});

test('rebalanceWeight refuses a maxMoves the addon\'s u32 cannot hold, on either backend', () => {
  const calls = [];
  const binding = { rebalanceJson: (request, result, maxMoves) => { calls.push(maxMoves); return '{}'; } };
  for (const backend of [binding, null]) {
    for (const maxMoves of [2 ** 32, -1, 1.5]) {
      assert.throws(() => rebalanceWeightWith(backend, {}, {}, { maxMoves }),
        { name: 'RangeError', message: 'maxMoves must be an integer from 0 to 4294967295' });
    }
  }
  assert.deepEqual(rebalanceWeightWith(binding, {}, {}, { maxMoves: 0xffffffff }), {});
  assert.deepEqual(calls, [0xffffffff], 'the largest u32 still reaches the addon, nothing above it does');
});

test('a native rebalance refusal arrives as the fallback\'s class', () => {
  const error = nativeRefusal('invalid_request: /items: must be a list', {
    code: 'invalid_request', reason: 'wrong_type', field: '/items', detail: 'must be a list',
  });
  const binding = { rebalanceJson: () => { throw error; } };
  assert.throws(() => rebalanceWeightWith(binding, {}, {}), InvalidRequestError);
});

const BACKEND_PROBE = "import {backend, version} from './index.js'; process.stdout.write(backend() + ' ' + version());";

function probe(root, source) {
  fs.writeFileSync(path.join(root, 'probe.mjs'), source);
  return execFileSync(process.execPath, [path.join(root, 'probe.mjs')], { cwd: root, encoding: 'utf8' });
}

function withPackage(root, body) {
  try {
    return body(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('an addon from another release is not used, exactly as if it were absent', () => {
  const addon = 'module.exports={packJson:(s)=>s,version:()=>SUITE_VERSION};';
  withPackage(packageWithNativeStandIn(addon), (root) => {
    assert.equal(probe(root, BACKEND_PROBE), `rust ${PACKAGE_VERSION}`,
      'an addon of this release must be used, or the refusal below proves nothing');
  });
  withPackage(packageWithNativeStandIn(addon, '0.1.3'), (root) => {
    assert.equal(probe(root, BACKEND_PROBE), `javascript ${PACKAGE_VERSION}-js-fallback`);
  });
  withPackage(packageWithNativeStandIn('module.exports={packJson:(s)=>s};'), (root) => {
    assert.equal(probe(root, BACKEND_PROBE), `javascript ${PACKAGE_VERSION}-js-fallback`,
      'an addon that cannot say which release it is cannot be trusted to be this one');
  });
});

/** Requests each engine refuses, chosen so the refusal comes from the native core itself. */
const SIDE = { length: '100', width: '100', height: '100' };
const fixed = (x) => ({ item_type: 'cube', container_type: 'box', container_instance: 1,
  position: { x, y: '0', z: '0' }, orientation: 'LWH' });
const REFUSED = {
  collision: { items: [{ id: 'cube', quantity: 2, dimensions: SIDE }],
    containers: [{ id: 'box', inner_dimensions: { length: '200', width: '100', height: '100' } }],
    fixed_placements: [fixed('0'), fixed('0')] },
  'unknown item': { items: [{ id: 'cube', quantity: 1, dimensions: SIDE }],
    containers: [{ id: 'box', inner_dimensions: SIDE }],
    fixed_placements: [{ ...fixed('0'), item_type: 'crate' }] },
  unsupported: { items: [{ id: 'cube', quantity: 1, dimensions: SIDE }],
    containers: [{ id: 'box', inner_dimensions: SIDE, pallet_overhang_limit: '1' }] },
};

const describe = (error) => ({ name: error.name, code: error.code, reason: error.reason,
  field: error.field, detail: error.detail, fields: error.fields });

function fallbackRefusal(request) {
  try {
    packFallback(structuredClone(request));
  } catch (error) {
    return describe(error);
  }
  return null;
}

const ADDON = process.env.PACKVIUM_NODE_ADDON;

test('the compiled addon refuses with the fallback\'s classes and fields', { skip: !ADDON && 'PACKVIUM_NODE_ADDON is not set' }, () => {
  withPackage(packageWithNativeAddon(ADDON), (root) => {
    const source = `import {backend, pack} from './index.js';
      const requests = ${JSON.stringify(REFUSED)};
      const out = {backend: backend()};
      for (const [name, request] of Object.entries(requests)) {
        try { pack(request); out[name] = null; }
        catch (e) { out[name] = {name: e.name, code: e.code, reason: e.reason, field: e.field, detail: e.detail, fields: e.fields}; }
      }
      process.stdout.write(JSON.stringify(out));`;
    const native = JSON.parse(probe(root, source));
    assert.equal(native.backend, 'rust', 'the addon was not loaded; the comparison below would be fallback against itself');
    for (const [name, request] of Object.entries(REFUSED)) {
      const expected = fallbackRefusal(request);
      assert.ok(expected, `${name}: the fallback accepted the request`);
      assert.deepEqual(native[name], JSON.parse(JSON.stringify(expected)), name);
    }
  });
});
