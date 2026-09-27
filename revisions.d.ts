// Types for `@packvium/engine/revisions.js` — plan revisions.
//
// `docs/PLAN-REVISIONS.md` is the contract. A revision records the exceptions observed against
// an approved plan and derives the next request from its parent's. It calls no solver, validator
// or clock, and its RFC 8785 spelling is byte-identical across engines.
import type { FixedPlacement, PackingRequest } from './index.js';
import type { ArtifactReplay, OperationalArtifact } from './artifacts.js';

export const FORMAT: 'packvium-plan-revision/v1';
export const EVENT_TYPES: readonly ['item_missing', 'container_substituted', 'placement_locked', 'placement_verified'];

/** The closed set of refusal codes shared by all four engines. */
export type PlanRevisionErrorCode =
  | 'invalid_revision' | 'invalid_event' | 'event_conflict' | 'invalid_artifact'
  | 'invalid_json' | 'number_out_of_range' | 'invalid_string' | 'invalid_value';

export class PlanRevisionError extends Error{constructor(code:PlanRevisionErrorCode,message:string);readonly code:PlanRevisionErrorCode}

/** `sequence` continues across the whole chain from 1; order is the sequence, never a clock. */
export type RevisionEvent =
  | {sequence:number;type:'item_missing';item_type:string;quantity:number}
  | {sequence:number;type:'container_substituted';container_type:string;replacement:Record<string,unknown>&{id:string}}
  | {sequence:number;type:'placement_locked'|'placement_verified';placement:FixedPlacement};

export interface PlanRevision{format:'packvium-plan-revision/v1';suite_version:string;revision:number;parent:string|null;approved:{artifact:string;replay:ArtifactReplay}|null;events:RevisionEvent[];request:PackingRequest}

/** One way a chain fails its audit, anchored on the revision where it shows. */
export interface RevisionIssue{code:'invalid_revision'|'revision_number'|'parent_mismatch'|'sequence_gap'|'request_mismatch'|'artifact_mismatch';revision:number;detail:string}

/** Revision 0: the request as first approved, with nothing recorded against it. */
export function rootRevision(request:PackingRequest):PlanRevision;
/** The next revision: `events`, observed against `approvedArtifact`, applied to `parent`. Throws `PlanRevisionError`. */
export function deriveRevision(parent:PlanRevision,approvedArtifact:OperationalArtifact,events:RevisionEvent[]):PlanRevision;
/** The request these events derive. Refuses a contradiction (`event_conflict`), never physics. */
export function applyEvents(request:PackingRequest,events:RevisionEvent[]):PackingRequest;
/** Every way the chain fails to be what its root and events derive, without stopping at the first. */
export function verifyRevisionChain(revisions:PlanRevision[],artifacts?:(OperationalArtifact|null)[]|null):RevisionIssue[];
/** `sha256:` and the lowercase hex SHA-256 of a document's canonical bytes. */
export function documentDigest(document:unknown):string;
/** The RFC 8785 canonical form. Throws `PlanRevisionError` for a value with no spelling. */
export function canonicalRevisionJson(document:unknown):string;
