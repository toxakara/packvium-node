# Changelog

What changed in `@packvium/engine` on npm, release by release. The format follows
[Keep a Changelog](https://keepachangelog.com/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.0]

Boxes cut to measure, flat bags, stacking groups and a volume-first objective in the request.
A request that uses none of them keeps its meaning; `fast` and `balanced` may now answer better.

### Added

- **`made_to_measure` on a container**: an on-demand box machine (largest box, minimum, cut
  step, board price and weight per m²); each packed box is the load's extent rounded up onto
  the machine grid and priced as cut, reported with `achieved_dimensions`.
- **`deformable_boundary: {kind: 'flat_bag'}` on a container**: a poly mailer that admits a load
  when length plus thickness and width plus thickness fit.
- **`stacking_group` and `accepts_stacking_groups` on an item**: which classes may rest directly
  on which.
- **`objective: 'maximum_volume'`**, ranking the volume left behind ahead of the piece count.
- **A warning for items resting on nothing** when `minimum_support_ratio` is 0. No answer
  changes. TypeScript types cover every new field.

### Changed

- **An unpacked item names the limit that left it out, the same in every engine.**
  Where the search used to fall back to `no_feasible_placement` or `search_exhausted`, an item a
  fresh container would take but none is left reports `container_inventory_exhausted`, and one
  that overloads an axle wherever it stands alone reports `axle_overloaded`; both are
  `inferred`. Code that matched the old reason for these cases must match the new one.
- **`balanced` and `quality` try eight orderings by default**, as the other engines
  do; `multi_start_orders` defaulted to 1. Answers can improve, and these profiles take longer:
  on our benchmark `balanced` 2-25 times as long, `quality` 1.7-2.8 times. `fast` keeps one
  ordering, and now ignores a larger `multi_start_orders`, as the other engines do. Set
  `multi_start_orders: 1` for the 1.5 speed. The candidate search allocates about 80% less, so
  eight orderings peak within about 13% of the memory one ordering took in 1.5.0.
- **Equal-volume items are ordered longest edge first, then heavier first, as in the other engines
,** and the layer start keeps its own order in every profile, so `quality` no longer
  packs a simple pallet/carton/drum load worse than `balanced`.
- **`quality` orders its beam by a `convex_hull` item's own solid**, not its box, so
  it no longer assumes a second wedge cannot fit when it can.
- **The container plan counts a `convex_hull` item by its own solid too**, so
  `quality` no longer ranks a plan as if wedges that share a container each needed their own.
- **`fast` and `balanced` add the block solver as one more start** on multi-type loads and keep
  its answer only when strictly better.

### Fixed

- **`effort_budget` caps the whole request, not each start.** With several orderings or the
  `quality` portfolio every start got the full budget, so `max_search_nodes: 5` could spend 40.
- **A restart keeps item priority.** A shuffled ordering could put a low-priority item ahead of
  a high-priority one; it now keeps priority, value under `maximum_value` and stop order first.
- **Exact search with a `convex_hull` item.** It bounded a hull by its box volume: two wedges
  that share one crate went into two, and a small order with a jar spent most of its time limit.
  It now finishes in a handful of search nodes.

## [1.5.0]

No API changes. The JavaScript engine's beam search is faster; route packing,
`rebalanceWeight` and the `quality` termination report are fixed, and a misspelt configuration
key is now refused (see *Fixed*).

### Changed

- **Beam search 7–9% faster in the JavaScript engine, same results.** Expansions that cannot
  beat the best plan so far are no longer copied, and the bound that ranks beam nodes is one
  binary search per node.
- **No probe for `@packvium/native`.** The package tried to load that name, which is neither
  published nor declared, so a supply-chain scanner reported an unresolved dependency. A
  compiled addon is still loaded from `packvium-native.node` beside `index.js`; an
  `npm install` runs the JavaScript engine, as it already did.

### Fixed

- **`quality` with `minimum_support_ratio` no longer returns unsupported items.** The
  homogeneous block solver ran even when the request asked for support, and a block set on a
  smaller one overhangs it: the result could hold items below the requested ratio, some
  resting on nothing, reported as `best_found`. Such a request is now left to the per-item
  search, and every item meets the ratio. Present since the block solver was added.
- **A misspelt `configuration` key is refused.** A key the request schema does not declare in
  `configuration` or its `effort_budget` (`profile` for `solver_profile`, `top_k` for
  `alternatives`) was silently ignored, so the request ran on defaults. `pack` now throws
  `InvalidRequestError` with reason `not_allowed` and the key's pointer, for example
  `/configuration/profile`.
- **`rebalanceWeight` no longer strands a supported item.** It could move the item underneath
  and leave the one above floating; such a move is now discarded, as documented.
- **`quality` reports `effort_limit` when the effort budget stopped it,** not `time_limit`.
- **Route packing with a `-x` door now packs all five items** in the regression scene (formerly
  two), keeps next-stop parcels behind the first stop's pallet, and orients upright pallets to
  save length.
- **An unknown `objective` or access direction is refused with its pointer** (`not_allowed`,
  e.g. `/configuration/objective`) instead of `invalid_value` with an empty field; refusal
  messages match the documentation.

## [1.4.0]

Replanning a job that has already started, and container ids that match the other engines.
A request the schema never allowed is now refused instead of packed (see *Fixed*).

### Added

- **`fixed_placements`** in a request. Each entry pins an item type to a container type and
  instance, at the origin a result reports, in one orientation. Fixed items keep their place,
  count toward weight, support and top load, and come back marked `fixed: true`. A fixed set
  that is not a valid packing on its own throws `FixedPlacementError` before any search.
- **`@packvium/engine/revisions.js`** — `rootRevision`, `deriveRevision`, `applyEvents`,
  `verifyRevisionChain`, `documentDigest` and `canonicalRevisionJson`, with TypeScript
  declarations. A `packvium-plan-revision/v1` chain records what happened on the dock —
  `item_missing`, `container_substituted`, `placement_locked`, `placement_verified` — against
  the artifact it changed, linked by SHA-256 from `node:crypto`, and carries the request the
  next plan solves. Every Packvium engine computes the same bytes from the same inputs.
- **`InvalidRequestError`**, exported from the package root. A malformed request names what is
  wrong: `code` is `invalid_request`, `reason` one of a closed set (`missing_field`,
  `wrong_type`, `below_minimum`, `above_maximum`, `negative_measure`, `invalid_unit`,
  `duplicate_id`, `not_allowed`, `invalid_value`), `field` the JSON Pointer of the bad value, and
  the message reads `invalid_request: /items/0/quantity: must be at least 1`. It extends
  `RangeError`, so existing handlers still catch it; `FixedPlacementError` extends it. The native
  and JavaScript backends raise the same error.
- `examples/revisions.mjs`.

### Changed

- **Container ids number each type from 1.** Searches over more than one container type counted
  containers across types, so a crate opened after a box was `crate#2` where the other engines
  said `crate#1`. Only answers with more than one container type change, and only their ids.

### Fixed

- **Numbers below their floor are refused.** The JavaScript engine packed requests with
  negative lengths, weights, payloads, clearances and obstacle positions, and with quantities,
  limits and ratios below their minimum, and raised a `max_candidate_points` below 16 to 16
  without saying so. Each now throws a `RangeError` naming what is wrong.
- **A `fixed_placements` that is not the schema's shape throws `FixedPlacementError`.** An
  object in place of the list was ignored, so the items it named were repacked elsewhere; a
  bad instance or orientation threw a bare `RangeError`.
- **A request key named `__proto__` survives a revision** as an ordinary key, instead of
  making the canonical writer refuse the document.

## [1.3.0]

Portable operational artifacts, and a faster `quality` profile. Nothing breaks 1.2.0.

### Added

- **`@packvium/engine/artifacts.js`** — `buildOperationalArtifact(request, result, { loadingOrders })`
  and `canonicalArtifactJson()`. One `packvium-operational-artifact/v1` document carries the
  execution plan, exact geometry, the values a work order shows, and the request that produced
  it. Every Packvium engine builds the same bytes from the same result.
- **`@packvium/engine/artifact-exports.js`** — `exportJson`, `exportCsv` (RFC 4180, 18 columns)
  and `exportWorkOrderHtml`: a printable work order in one HTML file with no scripts and no
  external resources.
- TypeScript declarations for both, and `examples/artifacts.mjs`.

### Changed

- **The beam search behind `solver_profile: "quality"` does less repeated work.** Results are
  byte-identical. On the wide cases measured (48 items, beam width 12) it took about half the
  time and 34–49 MB less memory.
- A pinned catalog version resolves without scanning the version history.
- `canonicalPlanJson` writes RFC 8785 through the same writer as the artifact. Every plan the
  engine produces keeps its 1.2.0 bytes.

## [1.2.0]

Execution plans, and a fix for items going missing on the `quality` profile. Nothing breaks 1.1.0.

### Added

- **`@packvium/engine/execution.js`** — `buildExecutionPlan(request, result, { loadingOrders })`,
  `canonicalPlanJson(plan)` and `placementReference()`, with TypeScript declarations. Turns a
  validated result into a work order: what to lift, why a carton was chosen, what was not
  packed. Step order comes from `loadingOrders` or is reported as `"unavailable"`.
- `examples/execution.mjs`.

### Fixed

- **The JavaScript engine could return fewer placements than it reported packed.** With
  `solver_profile: "quality"` or `container_plan_beam_width` above 1, a beam search that stopped
  early dropped the items it had not reached: neither placed nor listed as unpacked, and the
  result still said `feasible`. Affected `1.0.0` and `1.1.0`; the default profiles were not.
  If you used the `quality` profile, compare `packed_item_count` with the placements you received.

## Earlier releases

Up to 1.1.0 one changelog covered every Packvium language. Those entries are kept in
this repository's GitHub Releases for each tag.
