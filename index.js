import { createRequire } from 'node:module';
import {
  UnsupportedFeatureError,
  packFallback,
  rebalanceWeight as rebalanceFallback,
} from './fallback.js';
export {
  ALL_DIRECTIONS, InvalidDirectionError, LoadingDependencyGraph, SequenceError,
  SequenceReplayError, SequenceWarning, UnloadingDependencyGraph, replayLoadingOrder,
  replayRemovalOrder, safeLoadingOrder, safeLoadingOrderWithEvidence,
  safeLoadingOrderForPlacements, safeRemovalOrder, safeRemovalOrderWithEvidence,
  placementReachability,
  verifyLoadingPrefixBusinessRules, REASON_MESSAGES, explainReason,
  explanationForUnpackedItem, explainUnpackedItem,
} from './fallback.js';
export { UnsupportedFeatureError };
const require=createRequire(import.meta.url);
let native=null;
for(const candidate of ['./packvium-native.node','@packvium/native']){try{native=require(candidate);break}catch{}}
export const backend=()=>native?'rust':'javascript';
export function packJson(input){if(native?.packJson)return native.packJson(input);return JSON.stringify(packFallback(JSON.parse(input)));}
export function pack(request){return JSON.parse(packJson(JSON.stringify(request)));}
export function rebalanceWeight(request,result,{maxMoves=64}={}){
  if(!Number.isSafeInteger(maxMoves)||maxMoves<0)throw new RangeError('maxMoves must be a non-negative safe integer');
  if(native?.rebalanceJson){
    return JSON.parse(native.rebalanceJson(JSON.stringify(request),JSON.stringify(result),maxMoves));
  }
  return rebalanceFallback(request,result,{maxMoves});
}
export const version=()=>native?.version?.()??'0.1.0-js-fallback';
