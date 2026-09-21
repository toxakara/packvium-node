// Types for `@packvium/engine/artifacts.js` — the operational artifact.
//
// `docs/OPERATIONAL-ARTIFACTS.md` is the contract. The artifact wraps the execution plan
// unchanged, adds tick-string geometry and the result's rendered work-order values, and records
// provenance without wall-clock time. Its RFC 8785 spelling is byte-identical across engines.
import type { PackingRequest, PackingResult } from './index.js';
import type { ExecutionPlan, PlacementReference } from './execution.js';

export const FORMAT: 'packvium-operational-artifact/v1';
export const SUITE_VERSION: string;

/** The closed set of refusal codes shared by all four engines. */
export type OperationalArtifactErrorCode =
  | 'invalid_request' | 'invalid_result' | 'invalid_plan_input' | 'mixed_units'
  | 'number_out_of_range' | 'invalid_string' | 'invalid_value' | 'unknown_format' | 'invalid_json';

export class OperationalArtifactError extends Error{constructor(code:OperationalArtifactErrorCode,message:string);readonly code:OperationalArtifactErrorCode}

/** Integer tick counts as decimal strings: no engine has to hold them as a native number. */
export interface TickDimensions{length:string;width:string;height:string}

export interface ArtifactSolver{profile:string;solver:string;seed:number;time_limit_reached:boolean;effort_limit_reached:boolean}

/** `because` names the field that ruled out an exact replay, never a sentence. */
export type ArtifactReplay =
  | {level:'exact';because:null}
  | {level:'not_guaranteed';because:'provenance.solver'|'provenance.solver.time_limit_reached'};

export interface ArtifactProvenance{request:PackingRequest;catalog_versions_used:unknown[];solver:ArtifactSolver|null;replay:ArtifactReplay}

export interface GeometryPlacement{placement:PlacementReference;dimensions:TickDimensions}
export interface GeometryContainer{container_index:number;inner_dimensions:TickDimensions;placements:GeometryPlacement[]}

/** Rendered values copied from the result, all in the work order's units. */
export interface WorkOrderLine{sequence?:number;placement:PlacementReference;position:{x:string;y:string;z:string};dimensions:{length:string;width:string;height:string}}
export interface WorkOrderContainer{container_index:number;container_type:string|null;payload_weight:string;gross_weight:string;lines:WorkOrderLine[]}
export interface WorkOrder{length_unit:string|null;weight_unit:string|null;containers:WorkOrderContainer[]}

export interface OperationalArtifact{format:'packvium-operational-artifact/v1';suite_version:string;provenance:ArtifactProvenance;plan:ExecutionPlan;geometry:{containers:GeometryContainer[]};work_order:WorkOrder}

/**
 * Build the artifact for one validated result. Calls no solver, validator, renderer or clock.
 * `loadingOrders` is passed straight to `buildExecutionPlan`. Throws `OperationalArtifactError`.
 */
export function buildOperationalArtifact(request:PackingRequest,result:PackingResult,options?:{loadingOrders?:Record<number,number[]>}):OperationalArtifact;

/** The RFC 8785 canonical form. Throws `OperationalArtifactError` for a value with no spelling. */
export function canonicalArtifactJson(artifact:OperationalArtifact):string;
