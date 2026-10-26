/**
 * The result's own claims about the search: counters, counted-work limits, start records and the
 * feasibility, termination and optimality facts.
 */

import {
  at, getNull, getOr, isDict, pyCmp, pyIntInstance, strictInt, truthy,
} from './json.js';
import { contract, issue, shape } from './outcome.js';
import { boolRepr, pyRepr, pyStr, strRepr } from './pyfmt.js';

const METRICS = ['candidate_points_considered', 'orientations_considered', 'feasible_candidates',
  'collision_checks', 'support_checks', 'space_partitions', 'search_nodes_expanded'];

function algorithmOf(result) {
  const algorithm = at(result, 'algorithm');
  if (!isDict(algorithm)) throw contract('algorithm must be an object');
  return algorithm;
}

const isCounter = (value) => {
  const count = strictInt(value);
  return count !== null && count >= 0n;
};

export function checkAlgorithmMetrics(result, issues) {
  const algorithm = algorithmOf(result);
  const metrics = getNull(algorithm, 'metrics');
  if (!isDict(metrics) || !METRICS.every((field) => isCounter(getNull(metrics, field)))) {
    issues.push(issue('solver_metrics_mismatch', 'algorithm.metrics must contain every non-negative integer counter'));
    return;
  }
  const candidates = strictInt(getNull(algorithm, 'candidates_evaluated'));
  const attempts = strictInt(getNull(algorithm, 'placements_attempted'));
  const mirrors = candidates !== null && attempts !== null
    && candidates === strictInt(at(metrics, 'feasible_candidates'))
    && attempts === strictInt(at(metrics, 'orientations_considered'));
  if (!mirrors) issues.push(issue('solver_metrics_mismatch', 'legacy candidate counters must mirror algorithm.metrics'));
}

/** Counted-work limits are respected, and the stop flag is evidenced by one of them. */
export function checkEffortBudget(request, result, issues) {
  const algorithm = at(result, 'algorithm');
  const effortLimited = getNull(algorithm, 'effort_limit_reached');
  if (typeof effortLimited !== 'boolean') throw contract('algorithm.effort_limit_reached must be a boolean');
  const budget = getNull(getOr(request, 'configuration', {}), 'effort_budget');
  if (budget === null) {
    if (effortLimited) {
      issues.push(issue('effort_budget_mismatch', 'effort_limit_reached is true but the request has no effort_budget'));
    }
    return;
  }
  if (!isDict(budget)) throw contract('config.effort_budget must be an object');
  const metrics = getNull(algorithm, 'metrics');
  if (!isDict(metrics)) return;
  let reached = false;
  for (const [budgetName, metricName] of [['max_candidates_evaluated', 'feasible_candidates'],
    ['max_placement_attempts', 'orientations_considered'], ['max_search_nodes', 'search_nodes_expanded']]) {
    const limit = getNull(budget, budgetName);
    const value = strictInt(getNull(metrics, metricName));
    if (limit === null || value === null) continue;
    const order = pyCmp(value, limit);
    if (order > 0) {
      issues.push(issue('effort_budget_exceeded', `${metricName} is ${value}, above ${budgetName}=${pyStr(limit)}`));
    }
    reached = reached || order >= 0;
  }
  const restartLimit = getNull(budget, 'max_restarts');
  const starts = getOr(getOr(result, 'termination', {}), 'starts', []);
  const limit = pyIntInstance(restartLimit);
  if (limit !== null && Array.isArray(starts)) {
    const started = BigInt(starts.filter((start) => isDict(start) && getNull(start, 'started') === true).length);
    if (started > limit) {
      issues.push(issue('effort_budget_exceeded', `started ${started} solver runs, above max_restarts=${pyStr(restartLimit)}`));
    }
    reached = reached || started >= limit;
  }
  if (effortLimited && !reached) {
    issues.push(issue('effort_budget_mismatch',
      'effort_limit_reached is true but no configured counted-work boundary was reached'));
  }
}

function flag(algorithm, name) {
  const value = getNull(algorithm, name);
  if (typeof value !== 'boolean') throw contract(`algorithm.${name} must be a boolean`);
  return value;
}

function factCode(result, name) {
  const fact = at(result, name);
  if (!isDict(fact)) throw contract(`${name} must be an object`);
  const code = getNull(fact, 'code');
  if (typeof code !== 'string' || code === '') throw contract(`${name}.code must be a non-empty string`);
  return code;
}

export function checkResultFacts(result, issues) {
  const algorithm = algorithmOf(result);
  const timedOut = flag(algorithm, 'time_limit_reached');
  const effortLimited = flag(algorithm, 'effort_limit_reached');
  if (timedOut && effortLimited) {
    issues.push(issue('result_fact_mismatch', 'time_limit_reached and effort_limit_reached cannot both be true'));
  }
  const termination = at(result, 'termination');
  if (!isDict(termination)) throw contract('termination must be an object');
  checkStarts(termination, algorithm, timedOut, effortLimited, issues);

  const status = at(result, 'status');
  const complete = truthy(at(result, 'complete'));
  const invalid = status === 'invalid_result';
  const expected = {
    feasibility: status === 'infeasible' ? 'infeasible' : complete && !invalid ? 'feasible' : 'unknown',
    termination: invalid ? 'error' : timedOut ? 'time_limit' : effortLimited ? 'effort_limit' : 'complete',
    optimality: status === 'optimal' ? 'proven_optimal'
      : status === 'infeasible' ? 'proven_infeasible'
        : !complete && !invalid ? 'best_found' : 'not_proven',
  };
  for (const name of ['feasibility', 'termination', 'optimality']) {
    const actual = factCode(result, name);
    if (actual !== expected[name]) {
      issues.push(issue('result_fact_mismatch', `${name}.code is ${strRepr(actual)}, expected ${strRepr(expected[name])}`));
    }
  }
}

const LIFECYCLE = ['started', 'completed', 'truncated', 'selected', 'global_deadline_reached'];

/** Whether one start record is well formed, recording an inconsistent one on the way. */
function checkStart(start, issues) {
  if (!isDict(start) || typeof getNull(start, 'id') !== 'string') return false;
  const flags = LIFECYCLE.map((name) => getNull(start, name));
  if (!flags.every((value) => typeof value === 'boolean')) return false;
  const [started, completed, truncated] = flags;
  if ((completed && (!started || truncated)) || (truncated && (!started || completed)) || (!started && (completed || truncated))) {
    issues.push(issue('start_record_mismatch', `${pyStr(at(start, 'id'))}: inconsistent lifecycle flags`));
  }
  return true;
}

const isTrue = (start, name) => isDict(start) && getNull(start, name) === true;

function checkStarts(termination, algorithm, timedOut, effortLimited, issues) {
  const starts = getNull(termination, 'starts');
  if (!Array.isArray(starts) || starts.length === 0) {
    issues.push(issue('termination_aggregate_mismatch', 'termination.starts must contain at least one start'));
    return;
  }
  const wellFormed = starts.map((start) => checkStart(start, issues));
  if (wellFormed.includes(false)) {
    issues.push(issue('start_record_mismatch', 'a start record is missing its id or boolean lifecycle fields'));
  }
  const selected = starts.filter((start) => isTrue(start, 'selected'));
  if (selected.length !== 1) {
    issues.push(issue('termination_aggregate_mismatch', `expected one selected start, found ${selected.length}`));
    return;
  }
  if (!starts.every(isDict)) return;
  const winner = selected[0];
  const aggregate = [
    ['any_start_truncated', starts.some((start) => isTrue(start, 'truncated'))],
    ['all_required_starts_completed', starts.every((start) => isTrue(start, 'completed'))],
    ['winning_start_truncated', isTrue(winner, 'truncated')],
    ['global_deadline_reached', starts.some((start) => isTrue(start, 'global_deadline_reached'))],
  ];
  for (const [name, expected] of aggregate) {
    const reported = getNull(termination, name);
    if (reported !== expected) {
      issues.push(issue('termination_aggregate_mismatch', `${name} is ${pyRepr(reported)}, expected ${boolRepr(expected)}`));
    }
  }
  checkWinningSolver(winner, getNull(algorithm, 'solver'), issues);
  const globalDeadline = aggregate[3][1];
  const winningTruncated = aggregate[2][1];
  if (globalDeadline && !timedOut) {
    issues.push(issue('legacy_time_limit_mismatch', 'global_deadline_reached requires time_limit_reached'));
  }
  if ((globalDeadline || winningTruncated) !== (timedOut || effortLimited)) {
    issues.push(issue('termination_limit_mismatch', 'selected-start truncation must identify exactly one reached limit'));
  }
}

function checkWinningSolver(winner, solver, issues) {
  if (typeof solver !== 'string') return;
  const selectedId = getOr(winner, 'id', '');
  if (selectedId === solver) return;
  if (typeof selectedId !== 'string') throw shape(`a start id must be a string to name solver ${JSON.stringify(solver)}`);
  if (selectedId.startsWith(`${solver}#`)) return;
  issues.push(issue('winning_start_mismatch',
    `selected start ${pyRepr(selectedId)} does not identify solver ${strRepr(solver)}`));
}
