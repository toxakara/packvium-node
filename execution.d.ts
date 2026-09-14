// Types for `@packvium/engine/execution.js` — the execution-plan adapter.
//
// The split between `facts` and `presentation` is part of the contract rather than a
// convention, so it is spelt out here: `facts` is copied from the validated result and is
// what a downstream system may rely on; every `presentation.summary` names the fields it
// was built from in `cites`. A consumer that reads only `facts` loses nothing.
import type { PackingRequest, PackingResult, ResultFact } from './index.js';

export const FORMAT: 'packvium-execution-plan/v1';
export const UNNAMED_AXIS: string;

export class ExecutionPlanError extends Error {}

export interface PositionTicks{x:number;y:number;z:number}

/** How a step names a placement. Ticks are the exact integer coordinate, never a rendering. */
export interface PlacementReference{container_index:number;item_type:string;orientation:string;position_ticks:PositionTicks}

/** `sequence` is present only when a loading order was supplied; it is never derived. */
export interface ExecutionStep{sequence?:number;placement:PlacementReference}

export interface Presentation{summary:string;cites:string[]}

export interface ContainerFacts{container_type:string|null;placement_count:number;volume_utilization:string|null}

/** `order` is `'unavailable'` unless `loadingOrders` supplied one for this container. */
export interface PlanContainer{container_index:number;facts:ContainerFacts;order:'loading'|'unavailable';steps:ExecutionStep[]}

export interface UnplacedFacts{item_type:string|null;reason:string|null;proof_level:string|null;details:string[]}
export interface PlanUnplaced{facts:UnplacedFacts;presentation:Presentation}

/** `null` when the two scores are equal on every axis. */
export interface ScoreDifference{index:number;winner:number;alternative:number}
export interface AlternativeFacts{alternative_index:number;score:number[];status:string|null;first_difference:ScoreDifference|null}
export interface PlanAlternative{facts:AlternativeFacts;presentation:Presentation}

export interface PlanFacts{status:string;score:number[];feasibility:ResultFact|null;optimality:ResultFact|null;container_count:number}

export interface ExecutionPlan{format:string;objective:string|null;facts:PlanFacts;containers:PlanContainer[];alternatives:PlanAlternative[];unplaced:PlanUnplaced[]}

/** Throws `ExecutionPlanError` if the placement lacks `item_type`, `orientation` or a tick on any axis. */
export function placementReference(containerIndex:number,placement:unknown):PlacementReference;

/**
 * Derive the plan for one already validated result. Calls no solver and no validator.
 *
 * `loadingOrders` maps a container index to a permutation of that container's placement
 * indices; omit it and each container reports `order: 'unavailable'` with every placement
 * still listed. An order that is not a permutation throws `ExecutionPlanError`.
 */
export function buildExecutionPlan(request:PackingRequest,result:PackingResult,options?:{loadingOrders?:Record<number,number[]>}):ExecutionPlan;

/** The one byte-comparable spelling, with keys sorted recursively and arrays left in place. */
export function canonicalPlanJson(plan:ExecutionPlan):string;
