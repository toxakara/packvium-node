import assert from 'node:assert/strict';
import test from 'node:test';

import { exactInteger, parseExact, stringifyExact } from '../exact-json.js';

test('a weight past the safe range round-trips exactly, and nothing else changes', () => {
  const result = { weight: { ticks: 2n ** 63n - 1n, value: '1', unit: 'g' }, small: { ticks: 7 }, list: [1.5, null, 'x'] };
  const text = stringifyExact(result);
  assert.equal(text, '{"weight":{"ticks":9223372036854775807,"value":"1","unit":"g"},"small":{"ticks":7},"list":[1.5,null,"x"]}');
  assert.deepEqual(parseExact(text), result);
  assert.deepEqual(parseExact(JSON.stringify({ id: '"ticks":12345678901234567890' })), { id: '"ticks":12345678901234567890' });
});

test('ticks stay a Number up to 2^53 - 1 and become a BigInt past it', () => {
  assert.equal(exactInteger(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  assert.equal(exactInteger('-9007199254740993'), -9007199254740993n);
  assert.equal(parseExact('{"ticks": 9007199254740993}').ticks, 9007199254740993n);
  assert.equal(parseExact('{"ticks":9007199254740991}').ticks, 9007199254740991);
});

test('any integer past the safe range is read exactly, wherever it stands, and no other number moves', () => {
  const text = '{"score":[1,3747987187107132459,-9007199254740993],"f":12345678901234567.5,"e":1e300,"s":"12345678901234567890","n":-0.5}';
  const parsed = parseExact(text);
  assert.deepEqual(parsed.score, [1, 3747987187107132459n, -9007199254740993n]);
  assert.equal(parsed.f, 12345678901234567.5);
  assert.equal(parsed.e, 1e300);
  assert.equal(parsed.s, '12345678901234567890');
  assert.equal(parsed.n, -0.5);
  assert.equal(stringifyExact(parsed), '{"score":[1,3747987187107132459,-9007199254740993],"f":12345678901234568,"e":1e+300,"s":"12345678901234567890","n":-0.5}');
});
