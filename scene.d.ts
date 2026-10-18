// Types for `@packvium/engine/scene.js` — visualization scenes from a packing result.
//
// visualizer/spec/scene.md and scene.schema.json are the contract: one scene is one container,
// every length an exact tick string beside a display-only `mm` decimal.
import type { PackingRequest, PackingResult } from './index.js';

export const SCENE_FORMAT: 'packvium-visualization-scene/v1';

/** An exact tick count, and the same length in millimetres for display only. */
export interface SceneLength{ticks:string;mm:string}
export interface ScenePoint{x:SceneLength;y:SceneLength;z:SceneLength}
export interface SceneDimensions{length:SceneLength;width:SceneLength;height:SceneLength}
export type SceneRotation='LWH'|'LHW'|'WLH'|'WHL'|'HLW'|'HWL';
export interface SceneItem{id:string;position:ScenePoint;dimensions:SceneDimensions;rotation:SceneRotation}
export interface SceneStep{step:number;item_id:string}

export interface Scene{
  format:'packvium-visualization-scene/v1';
  display_unit?:'mm'|'cm'|'m'|'in'|'ft';
  container:{id:string;dimensions:SceneDimensions};
  items:SceneItem[];
  obstacles:[];
  sequence_kind?:'loading';
  sequence?:SceneStep[];
}

/** A plan's address for a placement: what a scene item id is spelled from. */
export interface ScenePlacementReference{readonly item_type:string;readonly orientation:string;readonly position_ticks:{readonly x:number;readonly y:number;readonly z:number}}
type SceneTickDimensions={readonly length:string;readonly width:string;readonly height:string};

/**
 * A plan container. `sequence` stays optional to match `ExecutionStep`, but under a `loading`
 * order every step must carry it -- the plan builder always numbers them, and the number is the
 * scene's `step` -- and `artifactToScene` refuses one that does not. An `unavailable` order's
 * steps are not read.
 */
export interface ScenePlanContainer{readonly order:'loading'|'unavailable';readonly steps:ReadonlyArray<{readonly sequence?:number;readonly placement:ScenePlacementReference}>}

/**
 * The fields of an operational artifact a scene is read from. Any `OperationalArtifact` from
 * `./artifacts.js` satisfies it, as does a reader's own narrower parse of the same document.
 */
export interface SceneSource{
  readonly geometry:{readonly containers:ReadonlyArray<{readonly inner_dimensions:SceneTickDimensions;readonly placements:ReadonlyArray<{readonly placement:ScenePlacementReference;readonly dimensions:SceneTickDimensions}>}>};
  readonly plan:{readonly containers:ReadonlyArray<ScenePlanContainer>};
  readonly work_order:{readonly length_unit:string|null};
}

/** Every container of the result `pack` returned for `request`, one scene each, in order. */
export function resultToScenes(request:PackingRequest,result:PackingResult):Scene[];

/**
 * One container of an operational artifact; a `RangeError` for an index it does not have, and
 * for any field above that is missing or mistyped, a loading step without its `sequence` included.
 */
export function artifactToScene(artifact:SceneSource,containerIndex:number):Scene;

/** `<item_type>@<x>,<y>,<z>/<orientation>`, unique within a container; a `RangeError` for a malformed reference. */
export function sceneItemId(reference:ScenePlacementReference):string;
