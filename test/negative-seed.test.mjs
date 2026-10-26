import assert from 'node:assert/strict';
import test from 'node:test';
import { packFallback } from '../fallback.js';
import { validate } from './validate.mjs';

// Every engine interprets a shuffle seed by its residue modulo 2^31.
// A generous clock and bounded effort keep the full report reproducible, counters included.
const request = seed => ({
  units: { length: 'mm' },
  configuration: {
    solver_profile: 'quality', seed, time_limit_ms: 600_000,
    effort_budget: { max_candidates_evaluated: 1_000_000, max_placement_attempts: 1_000_000, max_search_nodes: 1_000_000 },
  },
  items: [20, 25, 30, 35, 40, 45].map(side => ({
    id: `c${side}`, dimensions: { length: String(side), width: String(side), height: String(side) }, weight: '1 g',
  })),
  containers: [{ id: 'c', quantity: 1, inner_dimensions: { length: '160', width: '140', height: '120' } }],
});
const withoutSeed = result => JSON.stringify(result, (key, value) => ['seed', 'duration_ms', 'elapsed_ms'].includes(key) ? undefined : value);

for (const seed of [-7, -7 - 2 ** 31, 42 + 2 ** 31]) {
  test(`quality seed ${seed} preserves its echo and uses its modulo 2^31 residue`, () => {
    const payload = request(seed);
    const result = packFallback(payload);
    const residue = ((seed % 2 ** 31) + 2 ** 31) % 2 ** 31;
    const normalized = packFallback(request(residue));
    assert.deepEqual(validate(payload, result), []);
    assert.equal(result.algorithm.seed, seed);
    assert.equal(result.algorithm.time_limit_reached, false);
    assert.equal(normalized.algorithm.time_limit_reached, false);
    assert.equal(withoutSeed(result), withoutSeed(normalized));
  });
}
