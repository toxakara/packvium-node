/**
 * Serialization: the request as JSON text, the result as JSON text, and runners-up.
 *
 * Run it:
 *
 *     node examples/serialization.mjs
 *
 * Everything the engine can do is reachable through one JSON document, and that document
 * is the contract every Packvium engine reads -- Python, PHP, Rust and this one. So a
 * request that arrives over HTTP, sits in a queue or is saved for later needs no mapping
 * layer: hand the text to `packJson` and store the text it returns.
 *
 * `pack(object)` and `packJson(string)` are the same call; `pack` parses and serializes
 * for you. This example uses the text form throughout, then shows `alternatives`, and
 * ends with exactly what is and is not refused.
 */

import { UnsupportedFeatureError, InvalidRequestError, packJson } from '../index.js';

// As it might arrive in an HTTP body. Lengths and weights are decimal strings, so
// nothing is lost to floating point on the way in or out.
const body = `{
  "units": {"length": "mm"},
  "configuration": {
    "solver_profile": "quality",
    "alternatives": 3,
    "effort_budget": {"max_candidates_evaluated": 200000},
    "time_limit_ms": 60000
  },
  "items": [
    {"id": "lamp", "quantity": 3, "weight": "2 kg",
     "dimensions": {"length": "200", "width": "200", "height": "300"}},
    {"id": "book", "quantity": 6, "weight": "500 g",
     "dimensions": {"length": "210", "width": "140", "height": "30"}}
  ],
  "containers": [
    {"id": "small", "cost_minor": 300,
     "inner_dimensions": {"length": "400", "width": "300", "height": "300"}},
    {"id": "large", "cost_minor": 550,
     "inner_dimensions": {"length": "600", "width": "400", "height": "350"}}
  ]
}`;

const text = packJson(body);
const result = JSON.parse(text);

const rule = '='.repeat(78);
const section = (title) => console.log(`\n${rule}\n${title}\n${rule}`);

// ------------------------------------------------------------------------------------
section('1. JSON in, JSON out');

console.log(`  request  ${body.length} characters of text`);
console.log(`  result   ${text.length} characters of text`);
console.log(`  status   ${result.status}`);
console.log(`  score    [${result.score.join(', ')}]  <- exact integers, compared left to right`);
console.log(`  opened   ${result.containers.map((container) => container.id).join(', ')}`);

// Every measurement comes back in three forms: exact integer ticks, a decimal string
// for people, and its unit. Keep `ticks` for arithmetic; show `value`.
const [first] = result.containers[0].placements;
console.log(`\n  one coordinate: ${JSON.stringify(first.position.x)}`);

// ------------------------------------------------------------------------------------
section('2. alternatives: runners-up, already scored and validated');

// The count includes the winner, so 3 asks for at most two runners-up. They come from the
// portfolio's other starts, which is why this request asks for the `quality` profile:
// a single-start profile has nothing else to rank. An empty list is normal.
console.log(`  asked for 3, got the winner and ${result.alternatives.length} runner(s)-up`);
for (const [index, alternative] of [result, ...result.alternatives].entries()) {
  const opened = alternative.containers.map((container) => container.container_type).join(' + ');
  console.log(`  ${index === 0 ? 'winner' : `#${index}    `}  score [${alternative.score.join(', ')}]  ${opened}`);
}
console.log('\n  No runner-up scores better than the winner. Two can share a cost and still be');
console.log('  different arrangements. The list is this engine\'s own: another engine may');
console.log('  return different runners-up, or none, for the same request.');

// ------------------------------------------------------------------------------------
section('3. What is refused, and what is not');

const variant = (edit) => {
  const request = JSON.parse(body);
  edit(request);
  return JSON.stringify(request);
};

// A key the engine does not recognise on an item is ignored. Misspell `keep_upright` and
// the lamp may be laid on its side; nothing is thrown. Check keys yourself if typos in
// item fields matter.
const typo = JSON.parse(packJson(variant((request) => { request.items[0].keep_uprght = true; })));
console.log(`  misspelled item field   -> ${typo.status}; the misspelling was never read`);

// An unknown value where the engine has to choose a behaviour is refused.
try {
  packJson(variant((request) => { request.configuration.objective = 'cheapest'; }));
} catch (error) {
  if (!(error instanceof InvalidRequestError)) throw error;
  console.log(`  unknown objective       -> ${error.reason}: ${error.message}`);
}

// A field the schema reserves but this engine has not implemented is refused by name,
// so a request written for a newer engine fails loudly instead of being half-honoured.
try {
  packJson(variant((request) => { request.containers[0].pallet_overhang_limit = { length: '50', width: '50' }; }));
} catch (error) {
  if (!(error instanceof UnsupportedFeatureError)) throw error;
  console.log(`  reserved, unimplemented -> ${error.code}: ${error.fields.join(', ')}`);
}

// And text that is not JSON at all never reaches the engine.
try {
  packJson('{"items": [');
} catch (error) {
  console.log(`  not JSON                -> ${error.name}`);
}
