import assert from 'node:assert/strict';
import test from 'node:test';

import { InvalidRequestError, packFallback } from '../fallback.js';
import { itemRotations } from '../request-errors.js';
import { validateDocuments } from '../result-validation/index.js';

function request(allowedRotations, keepUpright = true) {
  return {
    configuration: { solver_profile: 'fast' },
    items: [{
      id: 'wedge', shape_type: 'convex_hull', keep_upright: keepUpright,
      allowed_rotations: allowedRotations,
      dimensions: { length: '10', width: '10', height: '10' },
      hull_vertices: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]].map(([x, y, z]) => ({ x, y, z })),
    }],
    containers: [{ id: 'crate', inner_dimensions: { length: '10', width: '10', height: '10' } }],
  };
}

for (const [codes, upright] of [[['+L-W-H'], true], [['LHW'], true], [[], true], [[], false]]) {
  test(`a hull with no effective rotation is refused: ${JSON.stringify(codes)}, upright ${upright}`, () => {
    assert.throws(() => packFallback(request(codes, upright)), (error) => {
      assert.ok(error instanceof InvalidRequestError);
      assert.equal(error.reason, 'invalid_value');
      assert.equal(error.field, '/items/0/allowed_rotations');
      assert.equal(error.message, 'invalid_request: /items/0/allowed_rotations: must allow at least one rotation after keep_upright');
      return true;
    });
  });
}

test('upright filtering keeps the caller order of the rotations that remain', () => {
  assert.deepEqual(itemRotations({
    allowed_rotations: ['+L-W-H', '+W-L+H', 'WLH', '-L-W+H', 'LWH'], keep_upright: true,
  }), ['+W-L+H', 'WLH', '-L-W+H', 'LWH']);
});

test('a malformed upright flag is checked before an empty effective rotation list', () => {
  const invalid = request(['+L-W-H']);
  invalid.items[0].keep_upright = 'true';
  assert.throws(() => packFallback(invalid), (error) => {
    assert.equal(error.reason, 'wrong_type');
    assert.equal(error.field, '/items/0/keep_upright');
    return true;
  });
});

for (const [codes, upright] of [[['+L-W-H'], true], [['LHW'], true], [[], true], [[], false]]) {
  test(`the independent validator refuses an empty effective list: ${JSON.stringify(codes)}, upright ${upright}`, () => {
    const valid = request(['LWH']);
    const result = packFallback(valid);
    const invalid = request(codes, upright);
    assert.deepEqual(validateDocuments(invalid, result), {
      refusal: {
        kind: 'contract',
        message: 'items[0].allowed_rotations must allow at least one rotation after keep_upright',
      },
    });
  });
}
