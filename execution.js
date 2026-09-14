/**
 * An execution plan derived from an already validated packing result.
 *
 * `docs/EXECUTION-PLAN.md` is the contract. A packing result answers *what goes where*; an
 * operator needs *what to do first, and why this carton*. This module turns the first into
 * the second and is built so that it cannot do anything else: it imports no solver and no
 * validator, holds no registry and reads no clock, so the same result yields the same plan
 * forever.
 *
 * Held to byte-identical output with `packvium.execution`, `Packvium\Execution\Plan` and
 * `packvium_core::execution`. JavaScript is the one that needs care for that: `JSON.stringify`
 * emits keys in insertion order, so this module sorts them itself, and it is also this
 * project's known odd one out for string order -- `sort()` compares UTF-16 code units where
 * the other three compare code points. Every key sorted here is an ASCII identifier this
 * module writes, so the two orders coincide; a key derived from caller data would not be
 * safe to sort this way and none is.
 *
 * Two rules do the work, and both are about not quietly becoming a decision-maker.
 * Authoritative solver facts and human text are separated in the *output*, under `facts`
 * and `presentation`, and every presentation string names the fields it came from. A
 * placement is referenced by container index, `item_type`, `orientation` and
 * `position.*.ticks` -- never by `item_id`, which `conformance/canonical.py` drops as "an
 * instance count rather than a semantic property".
 */

/** The plan's own format tag; not the packing schema's version, and it does not move with it. */
export const FORMAT = 'packvium-execution-plan/v1';

/**
 * What a `score` index means is a property of the request's objective, which this adapter
 * does not know. Naming an index it cannot explain would be inventing meaning.
 */
export const UNNAMED_AXIS = 'unnamed objective axis';

/** The adapter was handed something it cannot describe. */
export class ExecutionPlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExecutionPlanError';
  }
}

const integers = (value) => (Array.isArray(value) ? value.map((n) => Math.trunc(Number(n))) : []);

/** A reference two languages agree on, for one placement in one container. */
export function placementReference(containerIndex, placement) {
  for (const required of ['item_type', 'orientation']) {
    if (placement == null || !(required in placement)) {
      throw new ExecutionPlanError(
        `placement is missing a field the reference is built from: '${required}'`);
    }
  }
  const ticks = {};
  for (const axis of ['x', 'y', 'z']) {
    const value = placement.position?.[axis]?.ticks;
    if (value === undefined) {
      throw new ExecutionPlanError(
        `placement is missing a field the reference is built from: 'position.${axis}.ticks'`);
    }
    // `ticks` is the exact integer; `value`, which the same `exactScalar` also carries, is
    // a rendering, and a reference built on it would depend on how a number was printed.
    ticks[axis] = Math.trunc(Number(value));
  }
  return {
    container_index: containerIndex,
    item_type: placement.item_type,
    orientation: placement.orientation,
    position_ticks: ticks,
  };
}

/**
 * The operator sequence for one container, or an honest absence of one.
 *
 * The engines compute a loading order from geometry this adapter never sees, so it is
 * injected. Falling back to the order placements happen to appear in would present an
 * artifact of how the solver walked its candidates as a safe order to lift boxes in.
 */
function steps(containerIndex, placements, loadingOrder) {
  if (loadingOrder === undefined) {
    return {
      order: 'unavailable',
      steps: placements.map((placement) => ({
        placement: placementReference(containerIndex, placement),
      })),
    };
  }
  const sorted = [...loadingOrder].sort((a, b) => a - b);
  const expected = placements.map((_, index) => index);
  if (sorted.length !== expected.length || sorted.some((v, i) => v !== expected[i])) {
    throw new ExecutionPlanError(
      `loading order for container ${containerIndex} is not a permutation of its `
      + `${placements.length} placements`);
  }
  return {
    order: 'loading',
    steps: loadingOrder.map((index, step) => ({
      sequence: step + 1,
      placement: placementReference(containerIndex, placements[index]),
    })),
  };
}

/**
 * The first index at which two score vectors differ, and by how much.
 *
 * Never a blended number. The portfolio compared these lexicographically, so the first
 * differing index *is* the decision; weighting the vector would replace a decision that was
 * made with one that was not.
 */
function firstDifference(winner, loser) {
  const shared = Math.min(winner.length, loser.length);
  for (let index = 0; index < shared; index += 1) {
    if (winner[index] !== loser[index]) {
      return {
        index,
        winner: winner[index],
        alternative: loser[index],
        difference: loser[index] - winner[index],
      };
    }
  }
  if (winner.length !== loser.length) {
    throw new ExecutionPlanError(
      'score vectors of different length cannot be compared lexicographically');
  }
  return null;
}

function alternativeOf(index, winnerScore, alternative) {
  const score = integers(alternative?.score);
  const difference = firstDifference(winnerScore, score);
  const summary = difference === null
    ? 'This option scored identically to the chosen one on every objective axis; '
      + 'the score does not record why one was taken.'
    : `This option differs first at objective axis ${difference.index} (${UNNAMED_AXIS}): `
      + `chosen ${difference.winner}, this ${difference.alternative}.`;
  return {
    facts: {
      alternative_index: index,
      score,
      status: alternative?.status ?? null,
      first_difference: difference,
    },
    // Deliberately not "it lost because it is taller". The solver recorded a score, not a
    // cause; naming a cause would be a claim nothing in the result supports.
    presentation: { summary, cites: ['score', 'alternatives[].score'] },
  };
}

/**
 * Derive the execution plan for one validated result.
 *
 * `loadingOrders` maps a container index to the engine-computed order its placements load
 * in, and is optional for the reason `steps` gives.
 */
export function buildExecutionPlan(request, result, { loadingOrders = {} } = {}) {
  if (result?.status === undefined || result.status === null) {
    throw new ExecutionPlanError('a result without a status is not a validated result');
  }
  const containers = result.containers ?? [];
  const winnerScore = integers(result.score);

  const planContainers = containers.map((container, index) => ({
    container_index: index,
    facts: {
      container_type: container.container_type ?? null,
      placement_count: (container.placements ?? []).length,
      volume_utilization: container.volume_utilization ?? null,
    },
    ...steps(index, container.placements ?? [], loadingOrders[index]),
  }));

  const unplaced = (result.unpacked_items ?? []).map((item) => ({
    facts: {
      item_type: item.item_type ?? null,
      reason: item.reason ?? null,
      // Carried through unchanged. Softening `observed` into "could not fit" would turn an
      // honest limit into a false certainty.
      proof_level: item.proof?.level ?? null,
      details: item.details ?? [],
    },
    presentation: {
      summary: `Not packed: ${item.reason ?? ''} (${item.proof?.level ?? ''}).`,
      cites: ['unpacked_items[].reason', 'unpacked_items[].proof.level'],
    },
  }));

  const alternatives = (result.alternatives ?? [])
    .map((alternative, index) => alternativeOf(index, winnerScore, alternative));

  return {
    format: FORMAT,
    objective: result.objective ?? null,
    facts: {
      status: result.status,
      score: winnerScore,
      feasibility: result.feasibility ?? null,
      optimality: result.optimality ?? null,
      container_count: containers.length,
    },
    containers: planContainers,
    // Often empty, and not for one reason. Four produce an empty list: the `fast` profile
    // runs a single solver, stops the start loop once the grid lattice packs
    // everything, only one start completed, or `alternatives: 1` -- the cap counts the
    // winner. Measured over the corpus, 165 of 399 requests do carry one, so this is not
    // the rare case an earlier draft of this comment claimed. An empty list is
    // well-formed and is never an error.
    alternatives,
    unplaced,
  };
}

/**
 * Sort object keys recursively, leaving arrays in place.
 *
 * A list stays a list: sorting one would reorder steps, which are ordered on purpose.
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
  return sorted;
}

/**
 * The one byte-comparable spelling of a plan.
 *
 * `JSON.stringify` emits insertion order, so the sort above is what makes this comparable
 * with Python's `sort_keys=True`, PHP's recursive `ksort` and `serde_json`'s `BTreeMap`.
 */
export function canonicalPlanJson(plan) {
  return JSON.stringify(sortKeys(plan));
}
