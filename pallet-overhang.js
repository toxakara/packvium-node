/**
 * Pallet overhang (docs/PALLET-AND-ROBOT-RULES.md "container.pallet_overhang_limit").
 *
 * A container with `pallet_overhang_limit` `(l, w)` is a deck `L x W`, its `inner_dimensions`,
 * that a load may overhang by at most `l` past each end and `w` past each side. Every solver
 * packs the solving frame `(L + 2l) x (W + 2w) x H`, whose origin is the corner of the overhang
 * zone, so the deck lies on `[l, l + L] x [w, w + W]` and every coordinate stays non-negative.
 *
 * Only the deck carries weight: a placement on the floor rests on its overlap with the deck. The
 * packed pallet is billed and handed up at the size it reached: its declared footprint (outer if
 * stated, else inner) grown by the overhang actually used past each edge.
 *
 * Placements here are the solver's own: `x`, `y`, `z` the envelope origin and `ed` its sides,
 * all safe-integer ticks. This module is package-internal: `fallback.js` imports it.
 */

/** The frame every solver packs for a declared inner `[L, W, H]`, and the deck inside it. O(1). */
export function solvingFrame(inner, overhangX, overhangY) {
  return {
    d: [inner[0] + 2 * overhangX, inner[1] + 2 * overhangY, inner[2]],
    deck: Object.freeze({ x: overhangX, y: overhangY, length: inner[0], width: inner[1] }),
  };
}

/** The inner size the caller declared: a frame's deck at its height, else `d` itself. */
export const declaredInner = (d, deck) => (deck == null ? d : [deck.length, deck.width, d[2]]);

/** The container a pallet trial packs first: the deck alone, as declared, with no deck of its own. */
export function deckAlone(frame) {
  return { ...frame, d: declaredInner(frame.d, frame.deck), deck: null };
}

/** How much of a floor footprint rests on the deck. O(1). */
export function deckContactArea(deck, x, y, length, width) {
  const dx = Math.min(x + length, deck.x + deck.length) - Math.max(x, deck.x);
  const dy = Math.min(y + width, deck.y + deck.width) - Math.max(y, deck.y);
  return dx > 0 && dy > 0 ? dx * dy : 0;
}

/** The deck as a one-tick slab under the floor, shaped as a supporter: only its footprint is read. */
export const deckSlab = (deck) => ({ x: deck.x, y: deck.y, z: -1, d: [deck.length, deck.width, 1] });

/** How far the placements pass the deck in total along each axis, both ends then both sides. O(p). */
function overhangUsed(deck, placements) {
  let lowX = deck.x, lowY = deck.y, highX = deck.x + deck.length, highY = deck.y + deck.width;
  for (const p of placements) {
    lowX = Math.min(lowX, p.x); lowY = Math.min(lowY, p.y);
    highX = Math.max(highX, p.x + p.ed[0]); highY = Math.max(highY, p.y + p.ed[1]);
  }
  return [(deck.x - lowX) + (highX - deck.x - deck.length), (deck.y - lowY) + (highY - deck.y - deck.width)];
}

/**
 * The shift that seats a frame trial's load with the least overhang. Per axis: flush with the
 * deck's near edge when the load is no longer than the deck, else centred on the deck with an
 * odd tick past the far edge. The load stays inside the frame, since its span is at most the
 * deck plus both allowances. O(p); `[0, 0]` for none.
 */
export function centringOffset(deck, placements) {
  if (placements.length === 0) return [0, 0];
  let lowX = Infinity, lowY = Infinity, highX = -Infinity, highY = -Infinity;
  for (const p of placements) {
    lowX = Math.min(lowX, p.x); lowY = Math.min(lowY, p.y);
    highX = Math.max(highX, p.x + p.ed[0]); highY = Math.max(highY, p.y + p.ed[1]);
  }
  return [seat(deck.x, deck.length, lowX, highX), seat(deck.y, deck.width, lowY, highY)];
}

function seat(start, length, low, high) {
  const span = high - low;
  return (span <= length ? start : start - Math.floor((span - length) / 2)) - low;
}

/** Every placement moved by `(dx, dy)`; relative geometry, and so every rule but floor support, unchanged. O(p). */
export const movedPlacements = (placements, dx, dy) => placements.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));

/** The deck grown by the overhang used, at the load's height: what the loaded pallet reaches. O(p). */
export function achievedDimensions(deck, placements) {
  const [overX, overY] = overhangUsed(deck, placements);
  const top = placements.reduce((highest, p) => Math.max(highest, p.z + p.ed[2]), 0);
  return [deck.length + overX, deck.width + overY, top];
}

/**
 * Per horizontal axis the larger of the declared footprint `base` (outer if stated, else inner)
 * and the deck grown by the overhang used; the declared height. An outer margin is not positioned
 * against the deck, so it is never added to the overhang. O(p).
 */
export function billedDimensions(base, deck, placements) {
  const [overX, overY] = overhangUsed(deck, placements);
  return [Math.max(base[0], deck.length + overX), Math.max(base[1], deck.width + overY), base[2]];
}
