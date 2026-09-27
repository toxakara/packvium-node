# @packvium/engine

Deterministic 3D cartonization for Node.js. It uses the optional native engine when
available and automatically falls back to the bundled JavaScript implementation.

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
  items: [{
    id: 'book', quantity: 4,
    dimensions: { length: '210', width: '140', height: '30' },
  }],
  containers: [{
    id: 'carton',
    inner_dimensions: { length: '400', width: '300', height: '250' },
  }],
});

console.log(backend());       // "rust" or "javascript"
console.log(result.status);   // "feasible"
console.log(result.containers);

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

`reason` is one of `missing_field`, `wrong_type`, `below_minimum`, `above_maximum`, `negative_measure`, `invalid_unit`, `duplicate_id`, `not_allowed` or `invalid_value`. `FixedPlacementError` extends it, with code
`invalid_fixed_placement` and reason `malformed` or `cannot_hold`.
The message is the same in every Packvium engine. Branch on `reason` and `field`; show the
message to a person. A request that is valid but does not fit completely is not an error: the
result lists what was left out, and why, in `unpacked_items`.

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
answered; both return the same result for the same input. A runnable walk-through of all
three functions is in [examples/commerce.mjs](examples/commerce.mjs), and the full
contract — document format, every result shape, all ten rejection codes, complexity and
limitations — is `docs/COMMERCE-API.md`.

## Examples

Runnable, in [`examples/`](examples). Each one is a single file you can read top to bottom
and execute without a project around it.

| File | What it shows |
| --- | --- |
| [`basic.mjs`](examples/basic.mjs) | Pack an order, read placements, and see why an item was refused. |
| [`objectives.mjs`](examples/objectives.mjs) | All six objectives on scenes where they genuinely disagree — the same scores the Python, PHP and Rust engines print for the same request. |
| [`shapes.mjs`](examples/shapes.mjs) | Items that are not their box: complementary wedges sharing one crate as `convex_hull`, and a cushion that compresses under load until the crush limit refuses it. |
| [`constraints.mjs`](examples/constraints.mjs) | Stacking caps, incompatible tags and atomic groups — each shown with and without the rule, plus how to read the structured refusal. |
| [`units.mjs`](examples/units.mjs) | Why lengths travel as strings: fractional inches kept exact, one tick deciding a fit, and the point where a JavaScript number stops being exact and a quote is refused rather than rounded. |
| [`commerce.mjs`](examples/commerce.mjs) | Rate a shipment, apply an eligibility rule, and pin a catalog version. |
| [`execution.mjs`](examples/execution.mjs) | Turn a result into dock instructions — and the clearest place to see what "byte-identical" does and does not promise: the four adapters agree on any given result, while this engine is free to reach a different packing than Python does. |
| [`artifacts.mjs`](examples/artifacts.mjs) | Hand a result to a system with no engine: one document with the plan, geometry and the request that produced it, exported as CSV and a printable HTML work order, and a refusal for a format it does not know. |
| [`revisions.mjs`](examples/revisions.mjs) | Replan a half-loaded job: a missing item and a locked placement recorded against the approved plan, a replan that keeps the locked item in place, and a hash-chained record that notices an edit. |

```bash
node examples/basic.mjs
```

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
Python, PHP, JavaScript) and held to identical placements on a shared fixture set.
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
request and result types, and `docs/COMMERCE-API.md` for the commercial/control-plane
contract. Report security issues through [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
