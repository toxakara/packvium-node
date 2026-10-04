# @packvium/engine

Deterministic 3D cartonization for Node.js. It uses the optional native engine when
available and automatically falls back to the bundled JavaScript implementation.

Use it to pick the smallest carton for an order, build a pallet, load a shipping container,
or load a truck within its axle ratings and delivery-stop order. Every answer comes back as
coordinates and rotations for each item, with a reason for anything that did not fit.

Full documentation, the constraint reference and benchmarks live at
[packvium.com](https://packvium.com).

## Install

```bash
npm install @packvium/engine
```

Node.js 16 or later is required. Use a currently supported Node.js release in
production.

## Quick start

```js
import { backend, commerce, pack } from '@packvium/engine';

const result = pack({
  units: { length: 'mm' },
  configuration: {
    // Stop by counted work, not by the clock, so the answer is the same on any machine.
    // The time limit is only a safety fuse; see "Deterministic results" below.
    effort_budget: { max_candidates_evaluated: 1000000 },
    time_limit_ms: 60000,
  },
  items: [{
    id: 'book', quantity: 4, weight: '450 g',
    dimensions: { length: '210', width: '140', height: '30' },
  }],
  containers: [{
    id: 'carton',
    inner_dimensions: { length: '400', width: '300', height: '250' },
  }],
});

console.log(backend());       // "rust" or "javascript"
console.log(result.status);   // "feasible"
console.log(result.containers[0].placements.length); // 4

const commerceDocument = { tariffs: [{
  carrier_id: 'acme', service_id: 'ground',
  versions: [{
    effective_at: 0, dimensional_weight_divisor: 5000,
    cost_per_dimensional_kg_minor: { 'zone-a': 450 },
    minimum_charge_minor: 900, fuel_surcharge_permille: 120,
  }],
}] };
const quote = commerce.quote(commerceDocument, {
  carrier_id: 'acme', service_id: 'ground', tariff_version: 1,
  zone: 'zone-a', actual_weight_g: 1200, volume_mm3: 6000000,
});
console.log(quote.quote.total_minor);
```

Lengths and weights are strings on purpose: they are parsed into exact integers, so `'0.1'`
is a tenth of a millimetre and never `0.09999999999999999`. Every measurement in the result
comes back as `{ ticks, value, unit }` -- `ticks` is the exact integer the engine reasoned
with, `value` the same number written for a person.

## Two backends

`pack()` uses a compiled native addon when one is built beside `index.js` and loads,
and the bundled JavaScript engine otherwise. The published package ships no binary, so an
`npm install` runs the JavaScript engine. `backend()` says which one answered.

- **Packing:** both return a valid packing that honours every rule in the request, and each is
  deterministic on its own. They are independent searches, so for the same request they may
  choose a different arrangement, a different container, or a differently worded reason for an
  item left out. Do not compare results across backends byte for byte.
- **Commerce:** the two are held to the same answer: a quote's price is one exact integer
  and both compute the same one, and an unanswerable request is rejected by both with the same
  code and fields.

## Deterministic results

A solve stops when it finishes or when a limit stops it, and which limit matters:

- `configuration.time_limit_ms` is a wall clock. How far a search gets in it depends on the
  machine and its load, so an answer the clock cut short can differ on the next run. The
  JavaScript engine uses **1000 ms** when you set nothing.
- `configuration.effort_budget` counts work -- `max_candidates_evaluated`,
  `max_placement_attempts`, `max_search_nodes`, `max_restarts` -- and stops at the same point
  on every machine, so even a partial answer repeats exactly.

For anything you store, compare or audit, set an `effort_budget` and a `time_limit_ms` far above
what that work takes, as a fuse rather than a limit. The result says which one stopped it:

```js
const result = pack({ ...request, configuration: {
  effort_budget: { max_candidates_evaluated: 200000 },
  time_limit_ms: 60000,
} });

result.termination.code;               // "complete", "effort_limit" or "time_limit"
result.algorithm.effort_limit_reached; // true: partial, but a rerun gives the same answer
result.algorithm.time_limit_reached;   // true: the clock decided -- do not cache it as the answer
```

Items the search never reached are listed in `unpacked_items` with reason `effort_limit` or
`time_limit`, not as items that do not fit. [`examples/reproducibility.mjs`](examples/reproducibility.mjs)
shows both.

## Errors

A request that no engine may answer throws `InvalidRequestError`, a `RangeError`, before anything
is solved, whichever backend is running. It names the problem instead of describing it:

```js
import { InvalidRequestError, pack } from '@packvium/engine';

try {
  const result = pack(request);
} catch (error) {
  if (!(error instanceof InvalidRequestError)) throw error;
  error.code;    // 'invalid_request'
  error.reason;  // 'below_minimum'
  error.field;   // '/items/0/quantity' -- a JSON Pointer into your request
  error.message; // 'invalid_request: /items/0/quantity: must be at least 1'
}
```

`reason` is one of `missing_field`, `wrong_type`, `below_minimum`, `above_maximum`,
`negative_measure`, `invalid_unit`, `duplicate_id`, `not_allowed` or `invalid_value`. `field` is
an RFC 6901 JSON Pointer: `~1` stands for `/` and `~0` for `~` inside a key such as a tag name,
and `''` means the request as a whole. The message is `<code>: <field>: <detail>`, the same in
every Packvium engine. Branch on `reason` and `field`; show the message to a person.

- `FixedPlacementError` extends it, with code `invalid_fixed_placement` and reason `malformed`
  (`field` points at the bad value) or `cannot_hold` (the fixed items are not a valid packing on
  their own; `field` is `/fixed_placements`). One `catch` for `InvalidRequestError` covers both.
- `UnsupportedFeatureError` is separate, with code `unsupported_feature` and a `fields` list: the
  request uses a field the schema reserves but this engine does not implement yet, such as
  `container.pallet_overhang_limit`. It is refused rather than silently ignored.
- Numbers are judged by value, as the other engines judge them: `2.0` is the integer `2`, `2.5`
  and `'2'` are not integers, and an integer above `Number.MAX_SAFE_INTEGER` (2^53 - 1) is
  `above_maximum` -- also when it arrives as JSON text, which `JSON.parse` would otherwise round.
- Text that is not JSON makes `packJson()` throw the `SyntaxError` from `JSON.parse`.

A request that is valid but does not fit completely is not an error: the result lists what was
left out, and why, in `unpacked_items`. [`examples/errors.mjs`](examples/errors.mjs) walks every
case above.

## Quotes, policy and catalog versions

`commerce` has three functions, all deterministic and all over one document you supply —
no clock, no network, no hidden state. A history is a list and a version's number is its
position in that list starting at 1, so `tariff_version: 2` always means "the second
entry under this carrier and service".

```js
import { commerce } from '@packvium/engine';

// Which version applies: pin it, or ask what was in force at an instant. Never both.
commerce.quote(document, { /* ... */ tariff_version: 1 });
commerce.quote(document, { /* ... */ as_of: 1500 });

// The decision, and the rule id and version that made it.
const { decision } = commerce.evaluatePolicy(document, {
  scope: 'hazmat', context: { un_class: '1.4' }, as_of: 0,
});
decision.allowed;              // false
decision.citation.rule_id;     // "no-hazmat-air"

// Which catalog version a pin resolves to, what it holds, whether it was a rollback.
const { catalog } = commerce.catalogVersionInfo(document, {
  catalog_id: 'dc-12', version: 2, resolved_at: 1700,
});
catalog.entry_counts;          // { items: 1, cartons: 1, pallets: 0, ... }
catalog.rolled_back_from;      // 1, or null for an ordinary publication

// Store, log and compare results in the canonical form, not JSON.stringify.
commerce.canonicalJson(result);
```

Two kinds of failure, and they are not interchangeable:

- a **malformed** document or request is your bug and throws `CommerceInputError`;
- a request the model simply **cannot answer** — no tariff effective at that instant, no
  rate for that zone — is a successful call returning `"status": "rejected"` with a code
  from a closed set and structured fields naming what was missing.

`commerce.backend()` reports whether the native addon or the JavaScript implementation
answered; both give the same price and the same rejection for the same input. A runnable
walk-through of all three functions is in [examples/commerce.mjs](examples/commerce.mjs), and
the full contract — document format, every result shape, all ten rejection codes, complexity
and limitations — is [COMMERCE-API.md](https://github.com/toxakara/packvium-node/blob/main/docs/COMMERCE-API.md).

## Examples

Runnable, in [`examples/`](examples). Each one is a single file you can read top to bottom
and execute without a project around it, and each prints what it teaches.

| File | What it shows |
| --- | --- |
| [`basic.mjs`](examples/basic.mjs) | Pack an order, read placements, and see why an item was refused. |
| [`objectives.mjs`](examples/objectives.mjs) | All six objectives on scenes where they genuinely disagree about which container to open. |
| [`constraints.mjs`](examples/constraints.mjs) | Rotations and `keep_upright`, support ratio, top load, stacking caps, incompatible tags and atomic groups — each with and without the rule — and `explainUnpackedItem` turning a refusal into a sentence. |
| [`limits.mjs`](examples/limits.mjs) | Wheel arches as `obstacles` with `additional_boxes`, `max_items` and `tag_limits` per container, and what happens when container stock or `max_containers` runs out. |
| [`trucking.mjs`](examples/trucking.mjs) | A multi-drop van: `stop_index` and a rear door in `access_directions`, two `axles` with load limits, and a safe loading order fed into `buildExecutionPlan`. |
| [`shapes.mjs`](examples/shapes.mjs) | Items that are not their box: complementary wedges sharing one crate as `convex_hull`, and a cushion that compresses under load until the crush limit refuses it. |
| [`units.mjs`](examples/units.mjs) | Why lengths travel as strings: fractional inches kept exact, one tick deciding a fit, and the point where a JavaScript number stops being exact and a quote is refused rather than rounded. |
| [`serialization.mjs`](examples/serialization.mjs) | `packJson` with JSON text in and out, runners-up through `alternatives`, and exactly which mistakes are refused and which are ignored. |
| [`reproducibility.mjs`](examples/reproducibility.mjs) | `effort_budget` against `time_limit_ms`: a budget that never binds, one that cuts the search short and still repeats exactly, and how to tell from the result which one stopped it. |
| [`errors.mjs`](examples/errors.mjs) | `InvalidRequestError`'s `code`, `reason`, `field` and message for each kind of bad request, JavaScript's integer range, `FixedPlacementError` and `UnsupportedFeatureError` — and a valid request that simply does not fit. |
| [`fixed_placements.mjs`](examples/fixed_placements.mjs) | Pack around items already loaded, lock half of an earlier plan by quoting its placements, and a fixed set that cannot hold. |
| [`rebalancing.mjs`](examples/rebalancing.mjs) | `rebalanceWeight` evening out payload between packed crates, the moves it made, and `maxMoves`. |
| [`commerce.mjs`](examples/commerce.mjs) | Rate a shipment, apply an eligibility rule, and pin a catalog version. |
| [`execution.mjs`](examples/execution.mjs) | Turn a result into dock instructions, and what "byte-identical" does and does not promise: the four adapters agree on any given result, while this engine is free to reach a different packing than Python does. |
| [`artifacts.mjs`](examples/artifacts.mjs) | Hand a result to a system with no engine: one document with the plan, geometry and the request that produced it, exported as CSV and a printable HTML work order, and a refusal for a format it does not know. |
| [`revisions.mjs`](examples/revisions.mjs) | Replan a half-loaded job: a missing item and a locked placement recorded against the approved plan, a replan that keeps the locked item in place, and a hash-chained record that notices an edit. |

```bash
node examples/basic.mjs
```

## Subpath modules

The main entry point has packing, sequencing, explanations, rebalancing and `commerce`. Four
more modules are separate imports, so an application that only packs never loads them:

```js
import { buildExecutionPlan, canonicalPlanJson } from '@packvium/engine/execution.js';
import { buildOperationalArtifact, canonicalArtifactJson } from '@packvium/engine/artifacts.js';
import { exportCsv, exportJson, exportWorkOrderHtml } from '@packvium/engine/artifact-exports.js';
import { deriveRevision, rootRevision, verifyRevisionChain } from '@packvium/engine/revisions.js';
```

`execution.js` turns a result into numbered work-order steps. It never computes a loading order
itself: pass one from `safeLoadingOrder()` as `loadingOrders`, or the plan says its order is
`unavailable` rather than guessing. `artifacts.js` and `artifact-exports.js` package a result for a
system with no engine; `revisions.js` records changes against an approved plan.

## Features

- Exact, deterministic placement with no floating-point geometry decisions.
- Rotation, payload, stackability, support, clearance, obstacle and tag constraints.
- Multiple container types and clear explanations for unpacked items.
- JSON input/output through `pack()` or `packJson()`.
- Optional payload rebalancing with `rebalanceWeight()`.
- Loading and removal sequence helpers for already placed boxes.
- Execution plans through `buildExecutionPlan()` / `canonicalPlanJson()`: a work-order view of a
  result, with solver facts separated from the text that cites them.
- Portable operational artifacts through `buildOperationalArtifact()` from `artifacts.js`, exported
  by `artifact-exports.js` as canonical JSON, CSV or a self-contained HTML work order — the same
  bytes the Python, PHP and Rust packages write.
- Fixed placements (`fixed_placements`): items already loaded stay where they are and the solve
  packs around them; plan revisions from `revisions.js` record exceptions against an approved
  plan and derive the next request, hash-chained with the same bytes in all four engines.
- Deterministic carrier quotes, policy evaluation and effective-dated catalog lookup
  through `commerce`.

The native addon is optional. `npm install` works on unsupported platforms too; call
`backend()` if your application needs to know which implementation handled a request.

## The Packvium family

One request and result contract, implemented independently in four engines (Rust,
Python, PHP, JavaScript) and checked against each other on a shared fixture set: Python and
PHP to identical placements, Rust and JavaScript to a valid packing that scores no worse
than a per-fixture floor.
Pick the package for your stack; mixing them in one system is safe.

Documentation, the constraint reference and the benchmarks are at
[packvium.com](https://packvium.com).

| Package | Install | Source |
| --- | --- | --- |
| Python — [`packvium`](https://pypi.org/project/packvium/) | `pip install packvium` | [packvium-python](https://github.com/toxakara/packvium-python) |
| PHP — [`packvium/packvium`](https://packagist.org/packages/packvium/packvium) | `composer require packvium/packvium` | [packvium-php](https://github.com/toxakara/packvium-php) |
| Rust — [`packvium`](https://crates.io/crates/packvium) | `packvium = "1.0"` | [packvium-rust](https://github.com/toxakara/packvium-rust) |
| Node.js — [`@packvium/engine`](https://www.npmjs.com/package/@packvium/engine) | `npm install @packvium/engine` | [packvium-node](https://github.com/toxakara/packvium-node) |
| Browser / WebAssembly — [`@packvium/browser`](https://www.npmjs.com/package/@packvium/browser) | `npm install @packvium/browser` | [packvium-wasm](https://github.com/toxakara/packvium-wasm) |
| PHP FFI bridge — [`packvium/native-bridge`](https://packagist.org/packages/packvium/native-bridge) | `composer require packvium/native-bridge` | [packvium-php-bridge](https://github.com/toxakara/packvium-php-bridge) |
| Python native selector — `packvium-native` | from source until the native wheels ship | [packvium-python-adapter](https://github.com/toxakara/packvium-python-adapter) |

## API and support

TypeScript declarations are included. See the package's `index.d.ts` for the complete
request and result types. The documentation is in the source repository, not in the npm
package:

- [GUARANTEES.md](https://github.com/toxakara/packvium-node/blob/main/docs/GUARANTEES.md) — what is promised and what is not;
- [PUBLIC-API.md](https://github.com/toxakara/packvium-node/blob/main/docs/PUBLIC-API.md) — every request field, result shape and status;
- [UNITS-AND-NUMERICS.md](https://github.com/toxakara/packvium-node/blob/main/docs/UNITS-AND-NUMERICS.md) — units, accepted input forms, exact
  arithmetic and the 2^53 ceiling;
- [COMMERCE-API.md](https://github.com/toxakara/packvium-node/blob/main/docs/COMMERCE-API.md) — the commercial/control-plane contract.

Report security issues through [SECURITY.md](SECURITY.md).

## Citation

If Packvium supports your research, cite it as software. GitHub's **Cite this repository**
button reads [`CITATION.cff`](https://github.com/toxakara/packvium-node/blob/main/CITATION.cff), and
[`codemeta.json`](https://github.com/toxakara/packvium-node/blob/main/codemeta.json) carries the same record in
CodeMeta form.

```bibtex
@software{packvium_node,
  author  = {{Packvium contributors}},
  title   = {Packvium for Node.js},
  version = {1.5.0},
  license = {MIT},
  url     = {https://packvium.com}
}
```

## License

MIT. See [LICENSE](LICENSE).
