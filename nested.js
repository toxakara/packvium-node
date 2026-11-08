/**
 * Nested packing: levels packed in order, each level's packed containers becoming the next
 * level's items, the same beam as Python's `NestedPacker` over JSON requests.
 *
 * `levelBeamWidth` K carries the K best chains from one level to the next. A chain is a
 * sequence of level results; it extends by packing its handoff against the level's whole
 * container list and, when K > 1 and the level offers more than one, against each container
 * alone. Chains rank by their outermost result's score, then each earlier level's outward in,
 * then generation order; two chains handing up the same multiset of (container type, billed
 * dimensions, gross weight) keep only the better. A level
 * with no complete candidate ends every chain, unless the next level lists its own items, and
 * the best incomplete one is the answer. K = 1 is exactly the greedy chain.
 *
 * At most L * K * (T + 1) level packs for L levels offering at most T containers each; ranking
 * sorts the K * (T + 1) extensions of one level, comparing up to L scores per pair.
 * Locks remain fixed: singleton offers omitting a locked container type are skipped, and
 * K > 1 skips inherited handoffs missing a locked item instance. If none can supply the
 * locks, the first handoff receives the ordinary packer's refusal. Filtering is O(F + T)
 * per level and O(H + F) per chain for F locks and H handed-up item types.
 */

/** Length ticks per millimetre and weight ticks per gram: both powers of 2 and 5 only, so every
 *  tick count is a terminating decimal in these units and re-parses to the same ticks. */
const LENGTH_TICKS_PER_MM = 16000n;
const WEIGHT_TICKS_PER_GRAM = 8000000n;
const SIDES = ['length', 'width', 'height'];

/**
 * The levels `packLevel` packed, as `{levels: [{name, result}]}`. `packLevel` packs one JSON
 * request; the package passes its own `pack`, so each level uses whichever backend is loaded.
 */
export function packNestedWith(packLevel, { levels, levelBeamWidth = 1 }) {
  if (!Number.isSafeInteger(levelBeamWidth) || levelBeamWidth < 1) {
    throw new RangeError('level_beam_width must be a positive integer');
  }
  let beam = [[]];
  for (const [index, level] of levels.entries()) {
    const ranked = rankedExtensions(packLevel, level, beam, levelBeamWidth);
    const complete = ranked.filter((chain) => chain[chain.length - 1].result.complete);
    if (complete.length > 0) {
      beam = distinctHandoffs(complete, levelBeamWidth);
      continue;
    }
    const next = levels[index + 1];
    if (next === undefined || !listsItems(next)) return answer(ranked[0]);
    beam = [ranked[0]];
  }
  return answer(beam[0]);
}

function answer(chain) {
  return { levels: chain.map(({ name, result }) => ({ name, result })) };
}

function listsItems(level) {
  return Array.isArray(level.request.items) && level.request.items.length > 0;
}

/** Every chain's extensions through `level`, best first; ties keep generation order. */
function rankedExtensions(packLevel, level, beam, width) {
  const extensions = [];
  let firstIncompatible;
  for (const chain of beam) {
    const items = listsItems(level) || chain.length === 0 ? level.request.items : handoff(chain[chain.length - 1]);
    if (width > 1 && chain.length > 0 && !listsItems(level) && !handoffSupportsLocks(level.request, items)) {
      firstIncompatible ??= chain;
      continue;
    }
    for (const containers of offers(level.request, width)) {
      const request = { ...level.request, items, containers };
      const link = { name: level.name, request, result: packLevel(request) };
      extensions.push({ chain: [...chain, link], ordinal: extensions.length });
    }
  }
  // Preserve the ordinary packer's meaningful refusal when no branch can supply the locks.
  if (extensions.length === 0 && firstIncompatible !== undefined) {
    return rankedExtensions(packLevel, level, [firstIncompatible], 1);
  }
  extensions.sort((a, b) => compareChains(a.chain, b.chain) || a.ordinal - b.ordinal);
  return extensions.map(({ chain }) => chain);
}

/** A lock consumes one handed-up item instance. Only absent/exhausted types make a branch
 *  incompatible; malformed locks remain the flat packer's responsibility. O(H + F). */
function handoffSupportsLocks(request, items) {
  if (!Array.isArray(request.fixed_placements) || request.fixed_placements.length === 0) return true;
  const available = new Map(items.map((item) => [item.id, item.quantity ?? 1]));
  for (const fixed of request.fixed_placements) {
    if (fixed === null || typeof fixed !== 'object' || typeof fixed.item_type !== 'string') return true;
    const left = available.get(fixed.item_type) ?? 0;
    if (left === 0) return false;
    available.set(fixed.item_type, left - 1);
  }
  return true;
}

function* offers(request, width) {
  const { containers } = request;
  // Validate the original request before deriving offers, including malformed locks.
  yield containers;
  if (width === 1 || containers.length < 2) return;
  const locked = new Set((request.fixed_placements ?? []).map((fixed) => fixed.container_type));
  // A singleton cannot carry locks naming another type. Keep the locks unchanged and
  // omit that offer; several locked types leave only the complete offer. O(F + T).
  if (locked.size > 1) return;
  for (const container of containers) {
    if (locked.size === 0 || locked.has(container.id)) yield [container];
  }
}

/** Outermost score first, then each earlier level's outward in; lower is better. */
function compareChains(a, b) {
  for (let index = a.length - 1; index >= 0; index--) {
    const order = compareScores(a[index].result.score, b[index].result.score);
    if (order !== 0) return order;
  }
  return 0;
}

/** Lexicographic, exact: an entry is a `Number` while safe and a `BigInt` past 2^53 - 1. */
function compareScores(a, b) {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const left = BigInt(a[index]);
    const right = BigInt(b[index]);
    if (left !== right) return left < right ? -1 : 1;
  }
  return a.length - b.length;
}

/** The first `width` chains whose last level hands up a distinct multiset of items. */
function distinctHandoffs(ranked, width) {
  const kept = [];
  const seen = new Set();
  for (const chain of ranked) {
    const key = handoffKey(chain[chain.length - 1]);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(chain);
    if (kept.length === width) break;
  }
  return kept;
}

/** A multiset: instance numbers and emission order are not part of a packing's contract, so
 *  every engine collapses the same chains. Any fixed order serves; only equality is read. */
function handoffKey(link) {
  return JSON.stringify(link.result.containers.map((container) => JSON.stringify([
    container.container_type,
    SIDES.map((side) => String(billedDimensions(link.request, container)[side].ticks)),
    String(container.gross_weight.ticks),
  ])).sort());
}

/** Each packed container as one upright item, Python's `PackedContainer.as_item()`. */
function handoff(link) {
  return link.result.containers.map((container) => ({
    id: container.id,
    quantity: 1,
    dimensions: Object.fromEntries(SIDES.map((side) =>
      [side, measure(billedDimensions(link.request, container)[side].ticks, LENGTH_TICKS_PER_MM, 'mm')])),
    weight: measure(container.gross_weight.ticks, WEIGHT_TICKS_PER_GRAM, 'g'),
    keep_upright: true,
    metadata: { source_packed_container: container.id },
  }));
}

/**
 * What a carrier measures: a flat bag's achieved package; a pallet's declared footprint (its
 * reported outer size) grown by the overhang it used, per horizontal axis the larger, at the
 * declared height; else the declared outer size.
 */
function billedDimensions(request, container) {
  const declared = request.containers.find((candidate) => candidate.id === container.container_type);
  if (declared?.deformable_boundary != null) return container.achieved_dimensions;
  if (declared?.pallet_overhang_limit == null) return container.outer_dimensions;
  const outer = container.outer_dimensions, achieved = container.achieved_dimensions;
  const larger = (side) => (BigInt(achieved[side].ticks) > BigInt(outer[side].ticks) ? achieved[side] : outer[side]);
  return { length: larger('length'), width: larger('width'), height: outer.height };
}

/** `ticks` as an exact decimal of `unit`, which holds `ticksPerUnit` ticks. */
function measure(ticks, ticksPerUnit, unit) {
  const exact = BigInt(ticks);
  const whole = exact / ticksPerUnit;
  let remainder = exact % ticksPerUnit;
  let fraction = '';
  while (remainder !== 0n) {
    remainder *= 10n;
    fraction += String(remainder / ticksPerUnit);
    remainder %= ticksPerUnit;
  }
  return { value: fraction === '' ? String(whole) : `${whole}.${fraction}`, unit };
}
