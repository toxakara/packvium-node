/**
 * The Python semantics the JavaScript port of the reference validator rests on.
 *
 * The corpus tests hold the whole port to the reference's verdicts; these pin the pieces a
 * corpus rarely reaches -- `repr` of a float or an astral string, `%.6f` of an exact tie, the
 * `Fraction` grammar, correctly rounded `float(fraction)`, Python's equality and ordering across
 * types -- with the same cases the Rust core's unit tests use, so the two ports are pinned alike.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { LENGTH, toTicks } from '../result-validation/units.js';
import {
  PyDict, compareCodePoints, get, hashKey, int, kind, list, pyCmp, pyEq, pyInt, pyIntInstance, sortPy, text, truthy,
} from '../result-validation/json.js';
import { Ratio, ceilDiv, fixed6, floorDiv, parseFraction, pyMod, ratioPpm } from '../result-validation/num.js';
import { floatRepr, pyRepr, strRepr, tuple } from '../result-validation/pyfmt.js';
import { UNICODE_VERSION } from '../result-validation/nonprintable.js';
import { Refusal } from '../result-validation/outcome.js';
import { cuboid, hullVolume, rotateHull, vertices } from '../result-validation/geometry.js';
import { placedHull } from '../result-validation/stacking.js';
import { MalformedResult, pack, validateWith } from '../index.js';

const refusesAsShape = (run) => assert.throws(run, (error) => error instanceof Refusal && error.kind === 'shape');

test('floats print as Python repr prints them', () => {
  const cases = [
    [1e16, '1e+16'], [1e-5, '1e-05'], [0.0001, '0.0001'], [123456789012345678, '1.2345678901234568e+17'],
    [0.1, '0.1'], [-0.5, '-0.5'], [5.5, '5.5'], [1e15 + 0.5, '1000000000000000.5'], [2.5e-6, '2.5e-06'],
    [1e21, '1e+21'], [1.5, '1.5'], [Infinity, 'inf'], [-Infinity, '-inf'], [NaN, 'nan'], [-0, '-0.0'], [0, '0.0'],
  ];
  for (const [value, expected] of cases) assert.equal(floatRepr(value), expected, String(value));
});

test('strings print as Python repr prints them, by code point', () => {
  assert.equal(strRepr('abc'), "'abc'");
  assert.equal(strRepr('\u{e0001}\u0600'), "'\\U000e0001\\u0600'");
  assert.equal(strRepr('\u0378\ue000\u00e9'), "'\\u0378\\ue000\u00e9'");
  assert.equal(UNICODE_VERSION, '14.0.0');
  assert.equal(strRepr("it's"), '"it\'s"');
  assert.equal(strRepr('\'"'), "'\\'\"'");
  assert.equal(strRepr('a\nb\\'), "'a\\nb\\\\'");
  assert.equal(strRepr('\u0007\u00e9\u200b'), "'\\x07\u00e9\\u200b'");
  assert.equal(strRepr('a\tb\rc\u007f\u0085'), "'a\\tb\\rc\\x7f\\x85'");
  assert.equal(strRepr('\u2028\u{f0000}\u{1f600}'), "'\\u2028\\U000f0000\u{1f600}'");
  assert.equal(strRepr('\ud800'), "'\\ud800'");
});

test('containers and special values print as Python prints them', () => {
  assert.equal(pyRepr({ a: [1, null, true], b: 'x', c: 1.5, d: false }), "{'a': [1, None, True], 'b': 'x', 'c': 1.5, 'd': False}");
  assert.equal(pyRepr(12n), '12');
  assert.equal(tuple(['7']), '(7,)');
  assert.equal(tuple(['1', '2']), '(1, 2)');
});

test('%.6f rounds the exact double half to even, as Python does', () => {
  assert.equal(fixed6(1 / 128), '0.007812');
  assert.equal(fixed6(3 / 128), '0.023438');
  assert.equal(fixed6(2.5e-6), '0.000003');
  assert.equal(fixed6(0.5), '0.500000');
  assert.equal(fixed6(1234.5), '1234.500000');
  assert.equal(fixed6(2 ** 60), '1152921504606846976.000000');
  assert.equal(fixed6(-1e-9), '-0.000000');
  assert.equal(fixed6(5e-324), '0.000000');
  assert.equal(fixed6(Infinity), 'inf');
  assert.equal(fixed6(-Infinity), '-inf');
  assert.equal(fixed6(NaN), 'nan');
});

test('fractions parse by CPython 3.11\'s grammar', () => {
  const cases = [
    ['1_000', 1000n, 1n], ['.5', 1n, 2n], ['5.', 5n, 1n], ['1e3', 1000n, 1n], ['1E-2', 1n, 100n],
    [' 3/16 ', 3n, 16n], ['+.5e1', 5n, 1n], ['1_0.0_1', 1001n, 100n], ['-0.25', -1n, 4n], ['\u001c7\u3000', 7n, 1n],
  ];
  for (const [source, numerator, denominator] of cases) {
    const parsed = parseFraction(source);
    assert.deepEqual([parsed.numerator, parsed.denominator], [numerator, denominator], source);
  }
  for (const bad of ['1 / 2', '0x10', '', '.', '1__0', '_1', '1/0', 'None', '1e', '1/2x', '1.5x']) {
    refusesAsShape(() => parseFraction(bad));
  }
});

test('float(fraction) is correctly rounded, ties to even', () => {
  assert.equal(new Ratio(5n, 2000000n).toDouble(), 2.5e-6);
  assert.equal(new Ratio(1n, 3n).toDouble(), 1 / 3);
  assert.equal(new Ratio(-1n, 3n).toDouble(), -1 / 3);
  assert.equal(Ratio.of((1n << 60n) + 1n).toDouble(), 2 ** 60);
  assert.equal(Ratio.of((1n << 54n) + 3n).toDouble(), 2 ** 54 + 4);
  assert.equal(Ratio.of((1n << 53n) + 1n).toDouble(), 2 ** 53);
  assert.equal(Ratio.of(0n).toDouble(), 0);
  refusesAsShape(() => Ratio.of(10n ** 400n).toDouble());
  refusesAsShape(() => new Ratio(1n, 0n));
  assert.equal(ratioPpm(parseFraction('0.0001245')), 124n);
  assert.equal(new Ratio(1n, 2n).add(new Ratio(1n, 3n)).compare(new Ratio(5n, 6n)), 0);
});

test('integer division floors as Python floors', () => {
  assert.equal(floorDiv(-7n, 2n), -4n);
  assert.equal(floorDiv(7n, -2n), -4n);
  assert.equal(floorDiv(6n, 3n), 2n);
  assert.equal(ceilDiv(7n, 2n), 4n);
  assert.equal(pyMod(-7n, 3n), 2n);
  refusesAsShape(() => floorDiv(1n, 0n));
});

test('measures read as the reference reads them', () => {
  const ticks = (measure) => toTicks(measure, 'mm', LENGTH);
  assert.equal(ticks(2), 32000n);
  assert.equal(ticks(0.5), 8000n);
  assert.equal(ticks('12 3/8 in'), 12n * 406400n + 152400n);
  assert.equal(ticks('-1 1/2 mm'), -24000n);
  assert.equal(ticks('3 ticks'), 3n);
  assert.equal(ticks('10 CM'), 1600000n);
  assert.equal(ticks('0.00003125'), 0n);
  assert.equal(ticks('0.00009375'), 2n);
  assert.equal(ticks({ value: '1', unit: 'in' }), 406400n);
  assert.equal(ticks(true), 16000n);
  refusesAsShape(() => ticks('5 furlong'));
  refusesAsShape(() => ticks({ value: 1, unit: null }));
});

test('values compare, hash and convert as Python\'s do', () => {
  assert.equal(pyCmp([1, 2], [1]), 1);
  assert.equal(pyCmp([1], [1, 2]), -1);
  assert.equal(pyCmp(1.5, 2), -1);
  assert.equal(pyCmp(2, 1.5), 1);
  assert.equal(pyCmp(2.5, 1.5), 1);
  assert.equal(pyCmp(1.5, 1.5), 0);
  assert.equal(pyCmp(1e21, 10n ** 21n), 0);
  assert.equal(pyCmp(-1.5, -1), -1);
  assert.ok(pyEq([1, [2], null], [true, [2n], null]));
  assert.ok(!pyEq([1, 2], [1, 3]));
  assert.ok(!pyEq({ a: 1 }, { b: 1 }));
  assert.ok(pyEq({ a: 1 }, { a: true }));
  assert.ok(!pyEq('1', 1));
  assert.ok(!pyEq(null, 0));
  assert.ok(!pyEq([1], { 0: 1 }));
  assert.ok(truthy(0.5) && truthy(1n) && !truthy(0n) && !truthy({}) && truthy({ a: 1 }) && !truthy(''));
  assert.equal(hashKey(null), 'null');
  assert.equal(hashKey(1), hashKey(true));
  assert.notEqual(hashKey(2.5), hashKey(2));
  assert.equal(hashKey(1e21), hashKey(10n ** 21n));
  assert.deepEqual([null, false, 1, 1.5, 'x', [1], {}].map(kind),
    ['null', 'a boolean', 'an integer', 'a number', 'a string', 'a list', 'an object']);
  assert.equal(pyIntInstance(true), 1n);
  assert.equal(pyInt(false, 'x'), 0n);
  assert.equal(pyInt(-2.7, 'x'), -2n);
  assert.equal(pyInt(' +1_000 ', 'x'), 1000n);
  assert.equal(pyInt('-12', 'x'), -12n);
  assert.deepEqual(sortPy(['\u{1f600}', '\uff21', 'a']), ['a', '\uff21', '\u{1f600}']);
  assert.equal(compareCodePoints('ab', 'a'), 1);
  assert.equal(compareCodePoints('a', 'ab'), -1);
});

test('what the reference cannot read is a shape refusal', () => {
  const refusals = [
    () => get(5, 'x'), () => list('x', 'x'), () => text(1, 'x'), () => int(1.5, 'x'), () => pyInt([], 'x'),
    () => pyInt('1__0', 'x'), () => pyCmp([1], 'a'), () => hashKey([1]), () => sortPy([1, 'a']),
    () => pyCmp(null, null), () => rotateHull([], [0, 1, 2]),
  ];
  refusals.forEach((run) => refusesAsShape(run));
});

test('a repeated key keeps its first place and its last value, as in a Python dict', () => {
  const dict = new PyDict();
  dict.set(1, 'a');
  dict.set('b', 'b');
  dict.set(true, 'c');
  assert.deepEqual(dict.items(), [[1, 'c'], ['b', 'b']]);
  assert.equal(dict.position('b'), 1);
  assert.equal(dict.get(1.5), undefined);
});

test('a hull\'s volume is exact, whatever the vertex order', () => {
  const cube = [];
  for (const x of [0n, 2n]) for (const y of [0n, 2n]) for (const z of [0n, 2n]) cube.push([x, y, z]);
  assert.equal(hullVolume(cube), 8n);
  assert.equal(hullVolume(rotateHull(cube.slice().reverse(), [1, 0, 2])), 8n);
  // A wedge with a vertex on an edge midpoint: the face walk passes over it.
  const wedge = [[0n, 0n, 0n], [4n, 0n, 0n], [0n, 4n, 0n], [0n, 0n, 4n], [2n, 0n, 0n]];
  assert.equal(hullVolume(wedge), 10n);
});

test('a hull whose reported box is not its rotated size is judged as that box', () => {
  const spec = {
    shapeType: 'convex_hull', stopIndex: null, dimensions: [2n, 2n, 2n],
    hullVertices: [[0n, 0n, 0n], [2n, 0n, 0n], [0n, 2n, 0n], [0n, 0n, 2n]],
  };
  const grown = cuboid(-1n, -1n, -1n, 4n, 4n, 4n);
  assert.deepEqual(placedHull(grown, { orientation: 'LWH' }, spec), vertices(grown));
  const exact = cuboid(0n, 0n, 0n, 2n, 2n, 2n);
  assert.equal(placedHull(exact, { orientation: 'LWH' }, spec).length, 4);
});

test('a container without an id is refused once an issue has to name it', () => {
  const request = {
    items: [{ id: 'cube', quantity: 1, dimensions: { length: '10', width: '10', height: '10' } }],
    containers: [{ id: 'box', inner_dimensions: { length: '10', width: '10', height: '10' } }],
  };
  const result = pack(request);
  assert.deepEqual(validateWith(null, request, result), []);
  delete result.containers[0].id;
  assert.deepEqual(validateWith(null, request, result), []);
  result.containers[0].payload_weight = { ticks: 1 };
  assert.throws(() => validateWith(null, request, result), (error) => error instanceof MalformedResult && error.kind === 'shape');
});


test('large JSON integer counters keep the decimal value read by the reference', () => {
  const request = {
    items: [{ id: 'a', dimensions: { length: '1', width: '1', height: '1' } }],
    containers: [{ id: 'box', inner_dimensions: { length: '1', width: '1', height: '1' } }],
    configuration: { effort_budget: { max_candidates_evaluated: 1 } },
  };
  const result = pack(request);
  const count = 1000000000000000100;
  result.algorithm.metrics.feasible_candidates = count;
  result.algorithm.candidates_evaluated = count;
  assert.deepEqual(validateWith(null, request, result).filter(({ code }) => code === 'effort_budget_exceeded'), [{
    code: 'effort_budget_exceeded',
    detail: 'feasible_candidates is 1000000000000000100, above max_candidates_evaluated=1',
  }]);
  assert.equal(pyEq(count, 1000000000000000100n), true);
  assert.equal(hashKey(count), hashKey(1000000000000000100n));
});
