export type ExactScalar=string|number|{value:string|number;unit?:string};
export interface Dimensions{length:ExactScalar;width:ExactScalar;height:ExactScalar}
export interface Item{id:string;quantity?:number;dimensions:Dimensions;weight?:ExactScalar;allowed_rotations?:string[];keep_upright?:boolean;stackable?:boolean;must_be_on_floor?:boolean;max_top_load?:ExactScalar;max_stacked_items?:number;nesting_height?:ExactScalar;minimum_support_ratio?:number;ground_contact_rule?:'free'|'covered'|'single'|'multiple';group?:string;tags?:string[];incompatible_tags?:string[];eligible_container_tags?:string[];priority?:number;value?:number;metadata?:Record<string,unknown>}
export interface Axle{position:ExactScalar;max_load?:ExactScalar}
export interface Container{id:string;inner_dimensions:Dimensions;outer_dimensions?:Dimensions;max_payload?:ExactScalar;tare_weight?:ExactScalar;quantity?:number;cost_minor?:number;max_items?:number;max_stack_density?:ExactScalar;axles?:[Axle,Axle];tags?:string[];tag_limits?:Record<string,number>;void_fill_reserve_ratio?:number;metadata?:Record<string,unknown>;obstacles?:Array<{id:string;origin:{x:ExactScalar;y:ExactScalar;z:ExactScalar};dimensions:Dimensions;additional_boxes?:Array<{origin?:{x:ExactScalar;y:ExactScalar;z:ExactScalar};dimensions:Dimensions}>}>}
export interface PackingConfiguration{solver_profile?:'fast'|'balanced'|'quality'|'exact_small';time_limit_ms?:number;alternatives?:number;seed?:number;max_containers?:number;clearance?:ExactScalar;minimum_support_ratio?:number;exact_item_limit?:number;multi_start_orders?:number;max_candidates_per_item?:number;max_candidate_points?:number;require_placement_coordinates?:boolean;solvers?:Array<'grid'|'extreme_points'|'homogeneous_blocks'|'layer'|'maximal_spaces'|'exact_small'>;objective?:'default'|'lowest_cost'|'shipping_cost'|'open_dimension_height'|'maximum_value';dimensional_weight_divisor?:number;dimensional_weight_length_unit?:'mm'|'cm'|'m'|'in'|'ft';dimensional_weight_weight_unit?:'mg'|'g'|'kg'|'oz'|'lb';effort_budget?:{max_candidates_evaluated?:number;max_placement_attempts?:number;max_search_nodes?:number;max_restarts?:number}}
export interface CatalogReference{catalog_id:string;version:number;effective_at:number;resolved_at:number}
export interface PackingRequest{units?:{length?:string};configuration?:PackingConfiguration;items:Item[];containers:Container[];catalog_versions_used?:CatalogReference[];output?:{length_unit?:string;weight_unit?:string}}
export interface ResultFact{code:string;[key:string]:unknown}
export interface StartRecord{id:string;started:boolean;completed:boolean;truncated:boolean;selected:boolean;global_deadline_reached:boolean}
export interface TerminationFact extends ResultFact{any_start_truncated:boolean;all_required_starts_completed:boolean;winning_start_truncated:boolean;global_deadline_reached:boolean;starts:StartRecord[]}
export interface SolverMetrics{candidate_points_considered:number;orientations_considered:number;feasible_candidates:number;collision_checks:number;support_checks:number;space_partitions:number;search_nodes_expanded:number}
export interface RejectionObservation{code:string;count:number;details:string[];[key:string]:unknown}
export interface ReasonProof{level:'proven'|'observed'|'inferred'|'unknown_due_to_limit';observations:RejectionObservation[];[key:string]:unknown}
export interface UnpackedItemResult{item_id:string;item_type:string;reason:string;details:string[];proof:ReasonProof}
export interface ExplanationDescriptor{message_key:string;arguments:{item_id:string;evidence_level:string;details:string};default_message:string}
export interface PackingResult{status:string;feasibility:ResultFact;termination:TerminationFact;optimality:ResultFact;complete:boolean;algorithm:{profile:string;solver:string;duration_ms:number;seed:number;time_limit_reached:boolean;effort_limit_reached:boolean;candidates_evaluated:number;placements_attempted:number;metrics:SolverMetrics};summary:{container_count:number;packed_item_count:number;unpacked_item_count:number};containers:unknown[];unpacked_items:UnpackedItemResult[];catalog_versions_used:CatalogReference[];[key:string]:unknown}
export interface WeightMove{item_id:string;from_container_id:string;to_container_id:string}
export interface RebalanceResult{containers:unknown[];moves:WeightMove[];improved:boolean}
export class UnsupportedFeatureError extends Error{readonly code:'unsupported_feature';readonly fields:string[]}
export type MovementDirection='+x'|'-x'|'+y'|'-y'|'+z'|'-z';
export interface SequencePoint{x:number;y:number;z:number}
export interface SequenceDimensions{length:number;width:number;height:number}
export interface SequenceBox{origin:SequencePoint;dimensions:SequenceDimensions}
export interface SequenceStep{index:number;direction:MovementDirection;depends_on:number[]}
export interface Reachability{index:number;reachable:boolean;blocked_by_support:number[];blocked_by_neighbors:number[];blocked_by_route:number[]}
export interface SequenceBusinessRulePlacement extends SequenceBox{weight?:number;max_top_load?:number;max_stacked_items?:number;stackable?:boolean;ground_contact_rule?:'free'|'covered'|'single'|'multiple'}
export interface SequenceBusinessRuleContainer{max_stack_density?:number}
export const ALL_DIRECTIONS:readonly MovementDirection[];
export class InvalidDirectionError extends RangeError{readonly code:'invalid_direction';readonly direction:string}
export class SequenceError extends Error{readonly code:'sequence_stuck';readonly stuck:number[]}
export class SequenceReplayError extends Error{readonly code:'sequence_replay';readonly index:number;readonly step:number;readonly reason:string}
export class SequenceWarning{readonly code:string;readonly index:number;readonly message_key:string;readonly arguments:Readonly<Record<string,string>>;constructor(code:string,index:number,messageKey:string,arguments_?:Record<string,string>);toJSON():{code:string;index:number;message_key:string;arguments:Readonly<Record<string,string>>}}
export class LoadingDependencyGraph{readonly dependsOn:readonly (readonly number[])[];constructor(dependsOn:readonly (readonly number[])[]);static build(boxes:readonly SequenceBox[]):LoadingDependencyGraph;isAcyclic():boolean}
export class UnloadingDependencyGraph{readonly dependsOn:readonly (readonly number[])[];constructor(dependsOn:readonly (readonly number[])[]);static build(boxes:readonly SequenceBox[]):UnloadingDependencyGraph;isAcyclic():boolean}
export function safeLoadingOrder(boxes:readonly SequenceBox[],container:SequenceDimensions,directions?:readonly MovementDirection[]):number[];
export function safeLoadingOrderForPlacements(placements:readonly SequenceBusinessRulePlacement[],container:SequenceDimensions&SequenceBusinessRuleContainer,directions?:readonly MovementDirection[]):number[];
export function safeRemovalOrder(boxes:readonly SequenceBox[],container:SequenceDimensions,directions?:readonly MovementDirection[]):number[];
export function placementReachability(boxes:readonly SequenceBox[],container:SequenceDimensions,stops?:readonly (number|null)[]|null,directions?:readonly MovementDirection[]):Reachability[];
export function replayLoadingOrder(boxes:readonly SequenceBox[],container:SequenceDimensions,order:readonly number[],directions?:readonly MovementDirection[]):void;
export function replayRemovalOrder(boxes:readonly SequenceBox[],container:SequenceDimensions,order:readonly number[],directions?:readonly MovementDirection[]):void;
export function safeLoadingOrderWithEvidence(boxes:readonly SequenceBox[],container:SequenceDimensions,directions?:readonly MovementDirection[]):SequenceStep[];
export function safeRemovalOrderWithEvidence(boxes:readonly SequenceBox[],container:SequenceDimensions,directions?:readonly MovementDirection[]):SequenceStep[];
export function verifyLoadingPrefixBusinessRules(placements:readonly SequenceBusinessRulePlacement[],order:readonly number[],container:SequenceBusinessRuleContainer):void;
export const REASON_MESSAGES:Readonly<Record<string,string>>;
export function explainReason(reason:string):string;
export function explanationForUnpackedItem(item:UnpackedItemResult):ExplanationDescriptor;
export function explainUnpackedItem(item:UnpackedItemResult):string;
export function pack(request:PackingRequest):PackingResult;
export function packJson(input:string):string;
export function rebalanceWeight(request:PackingRequest,result:PackingResult,options?:{maxMoves?:number}):RebalanceResult;
export function backend():"rust"|"javascript";
export function version():string;
/** One canonical commerce result document: see docs/COMMERCE-API.md. */
export type CommerceResult=Record<string,unknown>;
export class CommerceInputError extends Error{readonly name:'CommerceInputError'}
export const commerce:{
  backend():"rust"|"javascript";
  readonly API_VERSION:number;
  readonly REJECTION_CODES:readonly string[];
  canonicalJson(result:CommerceResult):string;
  quote(document:unknown,request:unknown):CommerceResult;
  evaluatePolicy(document:unknown,request:unknown):CommerceResult;
  catalogVersionInfo(document:unknown,request:unknown):CommerceResult;
};
