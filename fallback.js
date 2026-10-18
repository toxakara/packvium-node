import { jsonInteger, jsonSpelling } from './canonical-json.js';
import { appendContactBox, buildContactGraph } from './contact-graph.js';
import { CommerceInputError, compareCodePoints } from './commerce-model.js';
import { parsePolicy, policyRejection, provesUnplaceable, tagOccurrences } from './policy.js';
import { InvalidRequestError, checkRequest, pointer } from './request-errors.js';
import { fabricate, solvingEnvelopes } from './made-to-measure.js';

export { InvalidRequestError };

const LEN={mm:16000,millimeter:16000,millimeters:16000,cm:160000,m:16000000,in:406400,inch:406400,inches:406400,ft:4876800,tick:1,ticks:1};
const WT={g:8000000,kg:8000000000,mg:8000,lb:3628738960,lbs:3628738960,oz:226796185,tick:1,ticks:1};
const ROT={LWH:[0,1,2],LHW:[0,2,1],WLH:[1,0,2],WHL:[1,2,0],HLW:[2,0,1],HWL:[2,1,0]};
const SUPPORT_SCALE=1000000;
/** A ratio in parts per million by the published rule, `floor(ratio * 1000000 + 0.5)`, Python's
 *  `scaled_ratio`. */
const scaledRatio=(ratio)=>Math.floor(ratio*SUPPORT_SCALE+0.5);
/** A support ratio in parts per million, the one conversion the global, per-item, rebalance and
 *  validator paths share (S11). A positive ratio below half a ppm still demands contact: Python
 *  refuses an unsupported item there through its stability check, which this engine reads as
 *  the smallest ratio it can state. */
const supportPpm=(ratio)=>ratio>0?Math.max(1,scaledRatio(ratio)):0;
const MIN_CANDIDATE_POINTS=16;
const hasOwn=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function cloneValue(value){
  if(Array.isArray(value))return value.map(cloneValue);
  // An item's accepted stacking groups are a Set of strings; copied, not flattened.
  if(value instanceof Set)return new Set(value);
  if(value!==null&&typeof value==='object'){
    const copy={};
    for(const [key,entry] of Object.entries(value))copy[key]=cloneValue(entry);
    return copy
  }
  return value
}
const UNSUPPORTED={
  // Top-level scope: a block describing the whole request rather than one item or
  // container, which none of the per-entry loops below would ever see.
  // `fixed_placements` left this list in 1.4.0, when this engine gained seeding, admission
  // and the fixed-placement validator rule (docs/PLAN-REVISIONS.md).
  request:[],
  configuration:[],
  // `hull_vertices`, `compression_ratio` and `max_compression_pressure_kpa` left this list
  // in, the last engine to gain both the solver behaviour and the independent
  // validation the staged rollout requires.
  item:[],
  // `pallet_overhang_limit` was reserved in the schema by at the 1.1.0 contract
  // freeze and is refused everywhere until an engine implements it from a request: a field
  // a caller can set and the solver ignores is worse than a refusal.
  // `access_directions` left this list in, which wired the reserved field through
  // to the stop-accessibility rule in all four engines at once.
  container:['pallet_overhang_limit'],
  obstacle:[],
  // `item.shape_type` values this engine does not implement. Presence is the
  // wrong test for this one field: `rigid_cuboid` is the default and is implemented, so a
  // caller that spells the default out must be served, not refused. What is unimplemented
  // is a *value*, and the refusal names it -- packing a `convex_hull` item as its bounding
  // box would return a plan that looks valid and does not physically fit.
  // Empty since: this engine implements every value the schema defines. The guard
  // stays because the next reserved value will need it.
  shapeType:[],
};
// The admission boundary for staged public-field rollouts, exported so a test can assert
// that what the lists name is exactly what the guard refuses -- the counterpart of
// `ArrayCodec::UNSUPPORTED_FIELDS` in PHP and `UNSUPPORTED_FIELDS` in Python. Empty while
// this engine is current with the shared schema.
export const UNSUPPORTED_FIELDS=Object.freeze(Object.fromEntries(
  Object.entries(UNSUPPORTED).map(([scope,fields])=>[scope,Object.freeze([...fields])])));
/**
 * A carrier rate card, parsed once per container.
 *
 * `weight_brackets_g` is an ascending ladder of upper bounds in whole grams; the first
 * bound the billed weight does not exceed sets the price. Validation is strict and
 * up front because a malformed tariff misprices silently: a descending ladder would
 * make an unreachable bracket look priced, and a length mismatch would pair a weight
 * with someone else's price.
 */
function parseRateTable(raw){
  if(raw==null)return null;
  const brackets=raw.weight_brackets_g,prices=raw.prices_minor;
  if(!Array.isArray(brackets)||!Array.isArray(prices)||!brackets.length)throw new RangeError('rate_table requires non-empty weight_brackets_g and prices_minor');
  if(brackets.length!==prices.length)throw new RangeError('rate_table weight_brackets_g and prices_minor must have the same length');
  for(let index=0;index<brackets.length;index++){
    if(!Number.isSafeInteger(brackets[index])||brackets[index]<=0)throw new RangeError('rate_table weight_brackets_g must be positive safe integers');
    if(index>0&&brackets[index]<=brackets[index-1])throw new RangeError('rate_table weight_brackets_g must be strictly ascending');
    if(!Number.isSafeInteger(prices[index])||prices[index]<0)throw new RangeError('rate_table prices_minor must be non-negative safe integers');
  }
  const minimum=raw.minimum_charge_minor??0,fuel=raw.fuel_surcharge_permille??0;
  if(!Number.isSafeInteger(minimum)||minimum<0)throw new RangeError('rate_table minimum_charge_minor must be a non-negative safe integer');
  if(!Number.isSafeInteger(fuel)||fuel<0)throw new RangeError('rate_table fuel_surcharge_permille must be a non-negative safe integer');
  return {brackets,prices,minimum,fuel}
}
// A made-to-measure container's machine in ticks, or null for a stock container.
function parseMachine(raw,unit){
  if(raw==null)return null;
  const sides=value=>value==null?[0,0,0]:dims(value,unit);
  return {minimum:sides(raw.minimum),increment:sides(raw.increment),price:raw.cost_per_square_metre_minor??0,
    tarePerSquareMetre:raw.tare_per_square_metre==null?0:scalar(raw.tare_per_square_metre,'g',WT),allowance:sides(raw.outer_allowance)}
}
// Billed weight in whole grams, rounded up -- how a carrier reads a scale. A shipment
// fractionally over a bracket is in the next bracket; rounding down would price it
// below what the carrier charges.
const billedGrams=ticks=>ceilDiv(ticks,WT.g);
/** The charge for a billed weight, or `null` when the tariff does not price it. */
function chargeMinor(table,grams){
  for(let index=0;index<table.brackets.length;index++)if(grams<=table.brackets[index]){
    const base=Math.max(table.prices[index],table.minimum);
    return base+ceilDiv(base*table.fuel,1000)
  }
  return null
}
// A weight past the last bracket has no published price. Ranking it free would make the
// objective prefer exactly the packing the caller cannot ship, so it is ranked worst
// instead. Unlike a missing rate card -- rejected at admission, since that is a static
// property of the request -- this depends on how the search happened to fill the box,
// so it must lose a candidate rather than abort the run.
const UNPRICEABLE=Number.MAX_SAFE_INTEGER;
// One wording for the refusal wherever it fires (outermost solve frame, rebalancing),
// so the four engines stay literally comparable.
const unpriceableRefusal=({id,grams,bound})=>new RangeError(`container ${JSON.stringify(id)} bills at ${grams} g, above its rate table's last bracket (${bound} g); the shipment has no published price`);
const addLanded=(total,template,billedTicks)=>{
  if(total===UNPRICEABLE)return total;
  const charge=template.rate==null?null:chargeMinor(template.rate,billedGrams(billedTicks));
  return charge==null?UNPRICEABLE:total+charge
};
export class UnsupportedFeatureError extends Error{
  constructor(fields){super(`unsupported_feature: JavaScript fallback does not yet implement ${fields.join(', ')}; the request was rejected instead of silently ignoring public fields`);this.name='UnsupportedFeatureError';this.code='unsupported_feature';this.fields=fields}
}
// The entries of a list that can carry a field at all. This guard runs before the request's
// shape is checked, so a list that is not one, or an entry that is not an object, is left for
// `checkRequest` to name rather than crashing here.
const objectsIn=value=>Array.isArray(value)?value.filter(isObject):[];
// D10: each combination reads a container dimension or position the fabricated box does
// not keep. Checked on the raw request, before any request error. O(containers + fixed placements).
function madeToMeasureCombinations(req){const fields=[],measured=new Set();
  for(const raw of objectsIn(req.containers)){if(raw.made_to_measure==null)continue;
    if(typeof raw.id==='string')measured.add(raw.id);
    if(raw.axles!=null)fields.push('container.made_to_measure+axles');
    if(Array.isArray(raw.obstacles)&&raw.obstacles.length)fields.push('container.made_to_measure+obstacles');
    if(typeof raw.void_fill_reserve_ratio==='number'&&raw.void_fill_reserve_ratio>0)fields.push('container.made_to_measure+void_fill_reserve_ratio')}
  if(objectsIn(req.fixed_placements).some(entry=>typeof entry.container_type==='string'&&measured.has(entry.container_type)))
    fields.push('fixed_placements+container.made_to_measure');
  return fields}
function rejectUnsupported(req){const fields=[];
  for(const key of UNSUPPORTED.request)if(hasOwn(req,key))fields.push(key);
  for(const key of UNSUPPORTED.configuration)if(isObject(req.configuration)&&hasOwn(req.configuration,key))fields.push(`configuration.${key}`);
  for(const raw of objectsIn(req.items))for(const key of UNSUPPORTED.item)if(hasOwn(raw,key))fields.push(`item.${key}`);
  for(const raw of objectsIn(req.containers)){
    for(const key of UNSUPPORTED.container)if(hasOwn(raw,key))fields.push(`container.${key}`);
    for(const obstacle of objectsIn(raw.obstacles))for(const key of UNSUPPORTED.obstacle)if(hasOwn(obstacle,key))fields.push(`obstacle.${key}`);
  }
  for(const raw of objectsIn(req.items)){const shape=raw.shape_type;
    if(typeof shape==='string'&&UNSUPPORTED.shapeType.includes(shape))fields.push(`item.shape_type=${shape}`)}
  fields.push(...madeToMeasureCombinations(req));
  if(fields.length)throw new UnsupportedFeatureError([...new Set(fields)].sort());
}
/**
 * The request's fixed placements are malformed (`reason` `malformed`, `field` the bad value) or
 * cannot all hold (`cannot_hold`, `field` `/fixed_placements`), so no search is attempted
 * (docs/PLAN-REVISIONS.md). The message is `packvium.fixed_placements`' word for word, and names
 * no field: it predates the field and is pinned across engines.
 */
export class FixedPlacementError extends InvalidRequestError{
  static code='invalid_fixed_placement';
  static describe(field,detail){return `${this.code}: ${detail}`}
  constructor(detail,reason='cannot_hold',field='/fixed_placements'){super(reason,field,detail);this.name='FixedPlacementError'}
}
const malformed=(detail,field)=>new FixedPlacementError(detail,'malformed',field);
const FIXED_REQUIRED=['item_type','container_type','orientation'],FIXED_FIELDS=[...FIXED_REQUIRED,'container_instance','position'],AXES=['x','y','z'];
const unknownKeys=(value,allowed)=>Object.keys(value).filter(key=>!allowed.includes(key)).sort(compareCodePoints);
/**
 * The request's `fixed_placements` as JSON gave them, or a refusal naming the first entry
 * that is not the schema's shape. Nothing is coerced: `"1"` and `true` are not instances, and
 * a list is not a position. An absent or null field is no fixed placements. O(f).
 */
function requireFixedPlacementShapes(raw,u){
  if(raw==null)return [];
  if(!Array.isArray(raw))throw malformed('fixed_placements is a list','/fixed_placements');
  raw.forEach((entry,index)=>requireFixedEntryShape(entry,`fixed_placements[${index}]`,pointer('fixed_placements',index),u));
  return raw
}
function requireFixedEntryShape(entry,where,field,u){
  if(!isObject(entry))throw malformed(`${where} is an object`,field);
  const unknown=unknownKeys(entry,FIXED_FIELDS);
  if(unknown.length)throw malformed(`${where} cannot carry ${jsonSpelling(unknown)}`,field);
  const missing=FIXED_REQUIRED.filter(name=>!hasOwn(entry,name));
  if(missing.length)throw malformed(`${where} needs ${jsonSpelling(missing)}`,field);
  for(const name of ['item_type','container_type'])
    if(typeof entry[name]!=='string'||!entry[name])throw malformed(`${where}.${name} is a non-empty string`,`${field}/${name}`);
  if(!Object.keys(ROT).includes(entry.orientation))throw malformed(`${where}.orientation must be one of ${jsonSpelling(Object.keys(ROT))}`,`${field}/orientation`);
  const instance=fixedInstance(entry);
  if(instance===null||instance<1)throw malformed(`${where}.container_instance counts from 1`,`${field}/container_instance`);
  const position=hasOwn(entry,'position')?entry.position:{};
  requirePointShape(position,`${where}.position`,`${field}/position`,malformed);
  for(const axis of AXES)if(hasOwn(position,axis))requireCoordinate(position[axis],`${where}.position.${axis}`,`${field}/position/${axis}`,u);
}
// Parsed here, before admission, so a coordinate the length parser cannot read is refused as
// the entry's own fault, naming the value, rather than surfacing later as a bare parse error.
function requireCoordinate(value,where,field,u){
  try{scalar(value,u,LEN)}
  catch(error){throw malformed(`${where} ${String(error?.message).includes('cannot be negative')?'cannot be negative':'is a measure'}`,field)}
}
const fixedInstance=entry=>jsonInteger(hasOwn(entry,'container_instance')?entry.container_instance:1);
/**
 * A point is an object of `x`, `y` and `z` measures; what a measure may be is the length
 * parser's to say, so only the values it would silently misread are refused here. `error`
 * builds the refusal from its message and the JSON Pointer of the bad value.
 */
export function requirePointShape(point,where,field,error){
  if(!isObject(point))throw error(`${where} is a point object`,field);
  const unknown=unknownKeys(point,AXES);
  if(unknown.length)throw error(`${where} cannot carry ${jsonSpelling(unknown)}`,field);
  for(const axis of AXES)if(hasOwn(point,axis)&&(point[axis]===null||typeof point[axis]==='boolean'||Array.isArray(point[axis])))
    throw error(`${where}.${axis} is a measure`,`${field}/${axis}`);
}
/**
 * Resolve `req.fixed_placements` into the containers the solve opens first, or refuse the
 * request. Fixed items take the first instances of their type in listed order, and each
 * enters as a real placement, so every rule that reads a container's placement list holds
 * for it with no rule of its own. The checks run in `admit_fixed_placements`' order because
 * the refusal text is compared across engines.
 *
 * O(f log f) to resolve f entries, plus one pass of `fixedSetIssue`, O(f^2) in its pairwise
 * collision sweep. It runs once per solve frame, before search.
 */
function admitFixedPlacements(req,{items,templates,u,clear}){
  const entries=requireFixedPlacementShapes(req.fixed_placements,u);if(!entries.length)return [];
  const rawItems=new Map((req.items??[]).map(raw=>[raw.id,raw])),byId=new Map(templates.map(t=>[t.id,t]));
  const instances=new Map(items.map(item=>[item.id,item])),order=new Map((req.containers??[]).map((raw,index)=>[raw.id,index]));
  const parsed=entries.map(entry=>{const point=hasOwn(entry,'position')?entry.position:{};
    return {itemType:entry.item_type,containerType:entry.container_type,instance:fixedInstance(entry),orientation:entry.orientation,
      position:AXES.map(axis=>scalar(hasOwn(point,axis)?point[axis]:0,u,LEN))}});
  for(const entry of parsed){const raw=rawItems.get(entry.itemType);
    if(raw===undefined)throw new FixedPlacementError(`unknown item type ${jsonSpelling(entry.itemType)}`);
    if(!byId.has(entry.containerType))throw new FixedPlacementError(`unknown container type ${jsonSpelling(entry.containerType)}`);
    if(!(raw.allowed_rotations??(raw.keep_upright?['LWH','WLH']:Object.keys(ROT))).includes(entry.orientation))
      throw new FixedPlacementError(`${entry.itemType} may not be placed in orientation ${entry.orientation}`)}
  const taken=new Map(),assigned=parsed.map(entry=>{const count=(taken.get(entry.itemType)??0)+1,quantity=rawItems.get(entry.itemType).quantity??1;taken.set(entry.itemType,count);
    if(count>quantity)throw new FixedPlacementError(`${count} ${entry.itemType} fixed, ${quantity} requested`);
    return instances.get(`${entry.itemType}#${count}`)});
  const grouped=new Map();
  parsed.forEach((entry,index)=>{const item=assigned[index],[px,py,pz]=entry.position;
    // The clearance envelope must be inside the container, as for any placement; an item
    // flush against a wall has an envelope that starts before it.
    if(Math.min(px,py,pz)<clear)throw new FixedPlacementError(`outside_container: ${item.id}`);
    const key=`${entry.containerType}\u0000${entry.instance}`,pd=rotate(item.d,entry.orientation);
    if(!grouped.has(key))grouped.set(key,{tmpl:byId.get(entry.containerType),seq:entry.instance,placements:[]});
    grouped.get(key).placements.push({x:px-clear,y:py-clear,z:pz-clear,pd,ed:grown(pd,2*clear),r:entry.orientation,item,fixed:true})});
  const groups=[...grouped.values()].sort((a,b)=>order.get(a.tmpl.id)-order.get(b.tmpl.id)||a.seq-b.seq);
  requireContiguousInstances(groups,req.configuration?.max_containers??null);
  // Support is measured against every other fixed item in the container, not only the ones
  // listed before it: the set is one arrangement, and listing order is not physics.
  for(const group of groups)for(const placement of group.placements)placement.fixedSupport=placement.z===0?[1,1]
    :[directSupporters(placement,group.placements).reduce((total,support)=>total+support.area,0),placement.ed[0]*placement.ed[1]];
  const issue=fixedSetIssue(groups,req,clear);
  if(issue!==null)throw new FixedPlacementError(issue);
  return groups
}
function requireContiguousInstances(groups,maxContainers){
  const named=new Map();for(const group of groups){if(!named.has(group.tmpl.id))named.set(group.tmpl.id,[]);named.get(group.tmpl.id).push(group.seq)}
  for(const [id,sequences] of named){
    if(sequences.some((sequence,index)=>sequence!==index+1))throw new FixedPlacementError(`${id} instances ${jsonSpelling(sequences)} are not numbered 1..${sequences.length}`);
    const quantity=byTemplate(groups,id).quantity;
    if(quantity!=null&&sequences.length>quantity)throw new FixedPlacementError(`${sequences.length} ${id} named, ${quantity} available`)}
  if(maxContainers!=null&&groups.length>maxContainers)throw new FixedPlacementError(`${groups.length} containers hold fixed items, max_containers is ${maxContainers}`)
}
const byTemplate=(groups,id)=>groups.find(group=>group.tmpl.id===id).tmpl;
/**
 * The first issue `IndependentSolutionValidator` reports for the fixed set alone, as
 * `code: detail`, or null. Same rules, same order: collisions, then per placement bounds,
 * obstacles, floor, eligibility, compatibility, tag counts, support and stacking, then per
 * container load, axles, route, payload and item count, then groups. Item accounting is
 * left out because the free items have not been placed yet. The support-polygon centroid
 * test is absent because this engine does not enforce it in search either
 * (docs/VALIDATION-CONTRACT.md).
 */
function fixedSetIssue(groups,req,clear){
  const globalRatio=req.configuration?.minimum_support_ratio??0,globalPpm=supportPpm(globalRatio),located=new Map();
  for(const group of groups){const {tmpl,placements}=group,cid=`${tmpl.id}#${group.seq}`,boxOf=p=>({x:p.x,y:p.y,z:p.z,d:p.ed});
    for(let i=0;i<placements.length;i++)for(let j=i+1;j<placements.length;j++){const a=placements[i],b=placements[j];
      if(intersects(boxOf(a),boxOf(b))&&!validNesting(a,b)&&solidsOverlap(placedHull(a),boxOf(a),placedHull(b),boxOf(b)))return `collision: ${a.item.id} with ${b.item.id}`}
    const compatibility=placements.some(p=>p.item.tags.length||p.item.incompatible.length);
    const support=globalRatio>0||placements.some(p=>p.item.supportPpm>0||(p.item.groundRule!=null&&p.item.groundRule!=='free'));
    const stack=placements.some(p=>refusesLoad(p.item)||p.item.maxTop!=null||p.item.maxStacked!=null||p.item.maxCompressionKpa!=null);
    const boxes=placements.map(constraintBox),graph=contactGraph(boxes);
    for(let index=0;index<placements.length;index++){const p=placements[index],item=p.item,id=item.id,box=boxOf(p),others=placements.filter((_,k)=>k!==index);
      if(p.x+p.ed[0]>tmpl.d[0]||p.y+p.ed[1]>tmpl.d[1]||p.z+p.ed[2]>tmpl.d[2])return `outside_container: ${id}`;
      if(tmpl.obs.some(o=>intersects(box,o)&&solidsOverlap(placedHull(p),box,null,o)))return `obstacle_collision: ${id}`;
      if(item.raw.must_be_on_floor&&p.z!==0)return `must_be_on_floor: ${id}: `;
      if(item.eligibleTags.length&&!item.eligibleTags.some(tag=>(tmpl.tags??[]).includes(tag)))return `container_ineligible: ${id}`;
      if(compatibility){const rule=compatibilityIssue(item,others,tmpl);if(rule!==null)return `${rule[0]}: ${id}: ${rule[1]}`}
      if(support){const rule=supportIssue(p,others,globalRatio,globalPpm);if(rule!==null)return `${rule[0]}: ${id}: ${rule[1]}`}
      if(stack){const lower=graph.supporters[index].find(([k])=>stackingRefusal(placements[k].item,item)!==null);
        if(lower!==undefined)return `${stackingRefusal(placements[lower[0]].item,item)}: ${id}: ${placements[lower[0]].item.raw.id}`;
        const upper=refusesLoad(item)?graph.children[index].find(k=>stackingRefusal(item,placements[k].item)!==null):undefined;
        if(upper!==undefined)return `${stackingRefusal(item,placements[upper].item)}: ${id}: ${item.raw.id}`}}
    const bearing=loadIssue(boxes,graph,placements,tmpl);if(bearing!==null)return `${bearing[0]}: ${cid}: ${bearing[1]}`;
    const reaction=axleReactions(tmpl,placements);
    if(reaction!=null){const [front,rear]=tmpl.axleSpec;
      if(front.max!=null&&reaction.front>BigInt(front.max)*reaction.denominator)return `axle_overloaded: ${cid}: front`;
      if(rear.max!=null&&reaction.rear>BigInt(rear.max)*reaction.denominator)return `axle_overloaded: ${cid}: rear`}
    if(tmpl.bag&&!bagAdmits(tmpl,placements))return `bag_girth_exceeded: ${cid}`;
    if(placements.some(p=>p.item.stopIndex!=null)){const stuck=routeStuck(placements,tmpl,clear);
      if(stuck!==null)return `unloading_order_violation: ${cid}: stop ${stuck.stop} cannot be fully unloaded (${stuck.indices.map(k=>placements[k].item.id).join(', ')} still blocked)`}
    if(tmpl.max!=null&&placements.reduce((total,p)=>total+p.item.w,0)>tmpl.max)return `payload_exceeded: ${cid}`;
    if(tmpl.max_items!=null&&placements.length>tmpl.max_items)return `max_items_exceeded: ${cid}`;
    for(const p of placements)if(p.item.group!=null){if(!located.has(p.item.group))located.set(p.item.group,new Set());located.get(p.item.group).add(cid)}}
  for(const group of [...located.keys()].sort(compareCodePoints)){const where=[...located.get(group)].sort(compareCodePoints);
    if(where.length>1)return `group_split: ${group}: ${where.join(', ')}`}
  return null
}
// `[max x2, max y2, max z2]` over the envelopes, and the girth rule over it.
function bagExtent(placements){let a=0,b=0,c=0;
  for(const p of placements){a=Math.max(a,p.x+p.ed[0]);b=Math.max(b,p.y+p.ed[1]);c=Math.max(c,p.z+p.ed[2])}
  return [a,b,c]}
function bagAdmits(tmpl,placements){const [a,b,c]=bagExtent(placements);return a+c<=tmpl.d[0]&&b+c<=tmpl.d[1]}
function compatibilityIssue(item,others,tmpl){
  if(item.tags.length||item.incompatible.length)for(const other of others)
    if(item.incompatible.some(tag=>other.item.tags.includes(tag))||other.item.incompatible.some(tag=>item.tags.includes(tag)))
      return ['incompatible_items',`${item.raw.id} is incompatible with ${other.item.raw.id}`];
  for(const tag of item.tags.filter(tag=>tmpl.tagLimits[tag]!=null).sort(compareCodePoints)){
    const limit=tmpl.tagLimits[tag],count=others.filter(other=>other.item.tags.includes(tag)).length;
    if(count+1>limit)return ['tag_count_exceeded',`${tag}: limit ${limit}, would be ${count+1}`]}
  return null
}
function supportIssue(p,others,globalRatio,globalPpm){
  const rule=p.item.groundRule,required=Math.max(globalRatio,p.item.raw.minimum_support_ratio??0);
  if(p.z===0||((rule==null||rule==='free')&&required<=0))return null;
  const supporters=directSupporters(p,others),count=supporters.length;
  if(rule==='covered'){const surfaces=others.filter(o=>o.z+o.ed[2]===p.z),x2=p.x+p.ed[0],y2=p.y+p.ed[1];
    if(![[p.x,p.y],[x2,p.y],[p.x,y2],[x2,y2]].every(([x,y])=>surfaces.some(s=>s.x<=x&&x<=s.x+s.ed[0]&&s.y<=y&&y<=s.y+s.ed[1])))
      return ['ground_contact_violation',`covered: ${count} supporter(s), not all four corners touched`]}
  if(rule==='single'&&count!==1)return ['ground_contact_violation',`single: rests on ${count} item(s)`];
  if(rule==='multiple'&&count<2)return ['ground_contact_violation',`multiple: rests on ${count} item(s)`];
  if(required<=0)return null;
  const area=supporters.reduce((total,support)=>total+support.area,0),base=p.ed[0]*p.ed[1];
  return area<requiredArea(base,Math.max(globalPpm,p.item.supportPpm))?['insufficient_support',`${area}/${base} < ${sixPlaces(...doubleFraction(required))}`]:null
}
// The whole-container bearing pass, each rule reporting its first offender by instance id.
function loadIssue(boxes,graph,placements,tmpl){
  const loads=topLoads(boxes,graph),label=index=>placements[index].item.id;
  let index=boxes.findIndex((b,i)=>b.maxTop!=null&&loads[i]>BigInt(b.maxTop));if(index>=0)return ['top_load_exceeded',label(index)];
  index=boxes.findIndex((b,i)=>b.maxCompressionKpa!=null&&pressureExceeds(appliedPressure(Number(loads[i]),b.d[0]*b.d[1]),b.maxCompressionKpa));
  if(index>=0)return ['crush_violation',label(index)];
  index=boxes.findIndex((b,root)=>{if(b.maxStacked==null)return false;const seen=new Set(),pending=[...graph.children[root]];
    while(pending.length){const k=pending.pop();if(!seen.has(k)){seen.add(k);pending.push(...graph.children[k])}}return seen.size>b.maxStacked});
  if(index>=0)return ['stacked_item_limit_exceeded',label(index)];
  if(tmpl.maxStackDensity!=null){const squareMetre=16000000n*16000000n;
    index=boxes.findIndex((b,i)=>(BigInt(b.w)+loads[i])*squareMetre>BigInt(tmpl.maxStackDensity)*BigInt(b.d[0])*BigInt(b.d[1]));
    if(index>=0)return ['stack_density_exceeded',label(index)]}
  return null
}
// `safe_route_removal_order` over the physical boxes: the first stop that cannot be emptied,
// with every placement still due there, or null.
function routeStuck(placements,tmpl,clear){
  const boxes=placements.map(p=>({x:p.x+clear,y:p.y+clear,z:p.z+clear,d:{length:p.pd[0],width:p.pd[1],height:p.pd[2]}}));
  const container={length:tmpl.d[0],width:tmpl.d[1],height:tmpl.d[2]},dependsOn=unloadingDependencies(boxes),present=new Set(boxes.map((_,k)=>k));
  for(const stop of [...new Set(placements.map(p=>p.item.stopIndex).filter(s=>s!=null))].sort((a,b)=>a-b)){
    let due=placements.map((p,k)=>k).filter(k=>placements[k].item.stopIndex===stop);
    while(due.length){const removable=due.filter(k=>!dependsOn[k].some(d=>present.has(d))&&clearDirection(k,boxes,present,container,ALL_DIRECTIONS)!=null);
      if(!removable.length)return {stop,indices:due};
      const chosen=Math.min(...removable);present.delete(chosen);due=due.filter(k=>k!==chosen)}}
  return null
}
function rat(s){s=String(s).trim();if(s.includes(' ')){const [w,f]=s.split(/\s+/,2),[n,d]=f.split('/').map(BigInt),wb=BigInt(w),sg=s.startsWith('-')?-1n:1n,mag=(wb<0n?-wb:wb)*d+n;return [sg*mag,d]}if(s.includes('/')){const[n,d]=s.split('/').map(BigInt);return[n,d]}if(s.includes('.')){const neg=s.startsWith('-'),[a,b]=s.replace(/^[-+]/,'').split('.');const d=10n**BigInt(b.length),n=BigInt(a)*d+BigInt(b);return[neg?-n:n,d]}return[BigInt(s),1n]}
function round(n,d){const sg=n<0n?-1n:1n,a=n<0n?-n:n,q=a/d,r=a%d;const z=r*2n<d?q:r*2n>d?q+1n:q%2n===0n?q:q+1n;return sg*z}
function scalar(v,def,table){let raw=v,unit=def;if(v&&typeof v==='object'){raw=v.value;unit=v.unit??def}else if(typeof v==='string'){const m=v.trim().match(/^(.+?)\s*(millimeters|millimeter|inches|ticks|inch|lbs|tick|mm|cm|ft|in|mg|kg|oz|lb|g|m)$/i);if(m){raw=m[1];unit=m[2]}}const[n,d]=rat(raw),ticks=Number(round(n*BigInt(table[unit.trim().toLowerCase()]),d));if(ticks<0)throw new RangeError(`${table===WT?'weight':'length'} cannot be negative`);return ticks}
// With no `output.length_unit`, the request's own `units.length` spelt as the schema's
// output code ("Inches" is `in`); a unit no output code names, the internal tick, gives `mm`.
function outputLengthUnit(unit){const multiplier=LEN[unit.trim().toLowerCase()];return ['mm','cm','m','in','ft'].find(code=>LEN[code]===multiplier)??'mm'}
function dims(v,u){return [scalar(v.length,u,LEN),scalar(v.width,u,LEN),scalar(v.height,u,LEN)]}
// Three-element literals, not `Array.prototype.map`: an inlined `map` in optimised code builds
// a holey array where the baseline tiers build a packed one, so every consumer of a box's
// sides met two array maps and deoptimised on the second -- the hot candidate sweep included,
// each time costing it another optimising compile.
function rotate(d,r){const order=ROT[r];return [d[order[0]],d[order[1]],d[order[2]]]}
function grown(d,margin){return [d[0]+margin,d[1]+margin,d[2]+margin]}
function volume(d){return BigInt(d[0])*BigInt(d[1])*BigInt(d[2])}
function intersects(a,b){return a.x<b.x+b.d[0]&&a.x+a.d[0]>b.x&&a.y<b.y+b.d[1]&&a.y+a.d[1]>b.y&&a.z<b.z+b.d[2]&&a.z+a.d[2]>b.z}

// ---------------------------------------------------------------- irregular geometry
//
// The rule is fixed by docs/IRREGULAR-ITEMS.md. Every product here is a `BigInt`, and not for
// tidiness: a separating axis is a cross product of two edge vectors, so its components grow
// as the square of a coordinate and a projection grows as the cube. At the shared coordinate
// cap a cross product reaches 8e16 and a projection 2.4e25, while a JavaScript number is exact
// only to 2^53 ~ 9e15. Both would silently lose precision, and a collision predicate that
// rounds returns a plan that validates and does not fit. Rust carries the same arithmetic in
// `i128`; PHP needs a decimal-string fallback; here `BigInt` is already the house answer, used
// for load distribution since the first port.

/** Largest vertex coordinate a hull may carry, in ticks -- 6.25 m. Shared with every engine:
 *  they must refuse the same hulls or they disagree about which requests are legal. */
const MAX_HULL_COORDINATE=100000000;
const UNIT_AXES=[[1n,0n,0n],[0n,1n,0n],[0n,0n,1n]];
const sub3=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross3=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot3=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const big3=v=>[BigInt(v[0]),BigInt(v[1]),BigInt(v[2])];
function bigGcd(a,b){a=a<0n?-a:a;b=b<0n?-b:b;while(b){const t=a%b;a=b;b=t}return a}
/** Divide out the gcd and fix the sign, so parallel axes collapse to one entry. `null` for the
 *  zero vector: a cross product of parallel directions names no axis, an ordinary outcome. */
function primitiveAxis(v){
  const g=bigGcd(bigGcd(v[0],v[1]),v[2]);
  if(g===0n)return null;
  const r=[v[0]/g,v[1]/g,v[2]/g];
  const lead=r.find(x=>x!==0n);
  return lead>0n?r:[-r[0],-r[1],-r[2]];
}
const axisKey=v=>`${v[0]},${v[1]},${v[2]}`;
/** Lexicographic order on the vertex vector itself. `axisKey` is for identity, never order. */
const compareVertices=(l,r)=>{
  for(let i=0;i<3;i++)if(l[i]!==r[i])return l[i]<r[i]?-1:1;
  return 0;
};
/** Canonicalise an authored vertex list or refuse a hull with no interior. A zero-volume hull
 *  is separated from everything on its own normal, so it would pass through every other item
 *  and still be reported as a valid placement. */
function hullValidate(vertices){
  const points=vertices.map(v=>[Number(v[0]),Number(v[1]),Number(v[2])]);
  if(points.length<4)throw new RangeError(`a convex hull needs at least 4 vertices, got ${points.length}`);
  if(new Set(points.map(axisKey)).size!==points.length)throw new RangeError('convex hull vertices must be unique');
  if(points.some(v=>v.some(c=>Math.abs(c)>MAX_HULL_COORDINATE)))
    throw new RangeError(`convex hull coordinates must stay within ${MAX_HULL_COORDINATE} ticks`);
  const b=points.map(big3);
  for(let i=0;i<b.length;i++)for(let j=i+1;j<b.length;j++)for(let k=j+1;k<b.length;k++)for(let l=k+1;l<b.length;l++)
    if(dot3(sub3(b[l],b[i]),cross3(sub3(b[j],b[i]),sub3(b[k],b[i])))!==0n)return points;
  throw new RangeError('convex hull vertices are coplanar and enclose no volume');
}
/** Does the plane through `origin` with normal `axis` leave every vertex on one side? */
function isSupporting(points,origin,axis){
  const offset=dot3(origin,axis);let above=false,below=false;
  for(const v of points){const side=dot3(v,axis)-offset;
    if(side>0n)above=true;else if(side<0n)below=true;
    if(above&&below)return false}
  return true;
}
/** Corners of one planar convex face, in cyclic order seen from outside.
 *
 *  The vertices sharing a supporting plane are not all corners of the polygon they lie on: one
 *  can sit inside the face or part-way along an edge, and fanning over the raw set triangulates
 *  the wrong region -- the surface then fails to close and the volume is wrong. Gift-wrapping
 *  keeps only the corners, resolving collinear candidates to the farthest so an edge-interior
 *  vertex is walked past rather than doubled back through. */
function windFace(face,outward){
  // By the vertex vector, never its decimal encoding: the walk is only correct because it
  // starts from a corner, which it earns by starting from the smallest vertex under a genuine
  // linear order. String order is not one -- "10,0,0" sorts before "9,0,0" -- so it can name a
  // vertex lying inside the face and make the walk emit a segment that is not a hull edge.
  const sorted=[...face].sort(compareVertices);
  const ordered=[sorted[0]];let current=sorted[0];
  for(let step=0;step<sorted.length;step++){
    let next=null;
    for(const candidate of sorted){
      if(axisKey(candidate)===axisKey(current))continue;
      if(next===null){next=candidate;continue}
      const turn=dot3(cross3(sub3(next,current),sub3(candidate,current)),outward);
      const reach=dot3(sub3(candidate,current),sub3(candidate,current));
      const held=dot3(sub3(next,current),sub3(next,current));
      if(turn<0n||(turn===0n&&reach>held))next=candidate;
    }
    if(next===null||axisKey(next)===axisKey(sorted[0]))break;
    ordered.push(next);current=next;
  }
  return ordered;
}
/** Every face of the hull, each as its own corners in outward cyclic order.
 *
 *  One walk, because the faces answer two questions at once: the volume needs them wound
 *  consistently, and the hull's edges are the consecutive corner pairs of the same walk. A
 *  plane carrying fewer than three vertices is an edge or a corner of the hull, not a face,
 *  and carries no edge its two adjoining faces do not already carry. */
function woundFaces(points,faceAxes){
  const faces=[];
  for(const axis of faceAxes)for(const outward of [axis,[-axis[0],-axis[1],-axis[2]]]){
    let extreme=null;
    for(const v of points){const value=dot3(v,outward);if(extreme===null||value>extreme)extreme=value}
    const face=points.filter(v=>dot3(v,outward)===extreme);
    if(face.length<3)continue;
    faces.push(windFace(face,outward));
  }
  return faces;
}
/** Exact volume in cubic ticks, by the divergence theorem over the hull's own faces. */
function hullVolume(faces){
  let six=0n;
  for(const ordered of faces){
    const apex=ordered[0];
    for(let i=1;i+1<ordered.length;i++)six+=dot3(apex,cross3(ordered[i],ordered[i+1]));
  }
  const magnitude=six<0n?-six:six;
  return magnitude/6n;
}
/** Directions of the hull's real edges, deduplicated and canonical.
 *
 *  Every edge of a convex polyhedron is shared by exactly two faces, so walking each wound
 *  face and taking its consecutive corner pairs -- closing the cycle -- reaches all of them.
 *  The separating-axis theorem asks for exactly these, not for every vertex pair.
 *
 *  The distinction is the whole cost of the predicate. A hull has at most `3v - 6` edges but
 *  `v(v - 1) / 2` vertex pairs, and the axis set is the *product* of two hulls' sets, so the
 *  gap squares: on a 20-vertex hull, 1351 candidate axes rather than 15616. Vertex pairs were
 *  never wrong, only a superset -- a pair that is not an edge names a direction no face can
 *  separate along, so it can add an axis but never remove one. */
function hullEdges(faces){
  const edges=new Map();
  for(const ordered of faces)for(let i=0;i<ordered.length;i++){
    const axis=primitiveAxis(sub3(ordered[(i+1)%ordered.length],ordered[i]));
    if(axis)edges.set(axisKey(axis),axis);
  }
  return [...edges.values()].sort(compareVertices);
}
/** A hull's separating axes and volume in its own local frame, computed once per shape. */
function hullShape(vertices){
  const points=hullValidate(vertices).map(big3);
  const faces=new Map();
  for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++){
    for(let k=j+1;k<points.length;k++){
      // A triple whose plane cuts through the solid is not a face, and its normal separates
      // nothing the real face normals do not.
      const axis=primitiveAxis(cross3(sub3(points[j],points[i]),sub3(points[k],points[i])));
      if(axis&&isSupporting(points,points[i],axis))faces.set(axisKey(axis),axis);
    }
  }
  const faceAxes=[...faces.values()].sort(compareVertices);
  const wound=woundFaces(points,faceAxes);
  return {v:points,faces:faceAxes,edges:hullEdges(wound),volume:hullVolume(wound)};
}
/** A copied, string-exact view used only by this module's direct tests.
 *
 *  `fallback.js` is an internal package file: package.json exposes only `index.js`, which does
 *  not re-export this function. Keeping the probe beside the algorithm lets the suite assert
 *  edge identity and ordering without widening `@packvium/engine`'s public API or handing a
 *  mutable cached shape to a caller. */
export function __inspectHullShapeForTests(vertices){
  const shape=hullShape(vertices),copy=axes=>axes.map(axis=>axis.map(value=>value.toString()));
  return {volume:shape.volume.toString(),faceAxes:copy(shape.faces),edgeDirections:copy(shape.edges)};
}
/** How many rotated hulls stay resident, before the memo is dropped and refilled. A request is
 *  bounded by its distinct hull items times the six orientations, so this holds far more than
 *  any request the solver is sized for -- and bounded, rather than growing for the life of the
 *  process. */
const SHAPE_CACHE_ENTRIES=1024;
const shapeCache=new Map();
/** The rotated hull of one item in one orientation, built at most once.
 *
 *  A hull depends on the item and the orientation and on nothing about where a candidate sits,
 *  but the collision predicate was rebuilding it on every call -- `O(v^4)` work inside an
 *  `O(n^2)` loop. Measured on the two-wedge fixture: 78 builds for two items, where twelve are
 *  the floor.
 *
 *  Memoisation is safe here in the way it is not in general: the shape is never mutated after
 *  it is built, the key is the whole of what determines the value, and callers only project
 *  through it. Determinism is untouched -- this changes how often the answer is computed,
 *  never what it is. */
function shapeFor(vertices,rotation){
  const key=rotation+'|'+vertices.map(v=>v.join(',')).join(';');
  const found=shapeCache.get(key);
  if(found!==undefined)return found;
  const shape=hullShape(hullRotate(vertices,rotation));
  if(shapeCache.size>=SHAPE_CACHE_ENTRIES)shapeCache.clear();
  shapeCache.set(key,shape);
  return shape;
}
/** A cuboid, built without searching for its own faces: both sets are the three unit axes. */
/** Lower bounds on the objective vector.
 *
 *  The mathematics is fixed by docs/OPTIMALITY-CERTIFICATES.md. This is an independent
 *  implementation written from that document, and `conformance/scene/objective-bounds.json`
 *  holds it to the same vectors Python computes on 380 cases from the golden corpus.
 *
 *  asks only for soundness -- the bound must never exceed the achieved objective --
 *  because this engine is not held to placement equality. That freedom does not extend to a
 *  bound: it is a function of the *request*, so there is no room for a legitimately different
 *  answer, and this port is held to equality because equality is achievable and stronger.
 *
 *  `BigInt` throughout for volumes. A one-metre cube is 4.1e21 cubic ticks, past what a
 *  double represents exactly, and the widest intermediate multiplies a summed volume by 1e6.
 *  Counts, weights, costs and the parts-per-million keys come back to `Number` only once the
 *  arithmetic has reduced them to that scale.
 *
 *  `O(n log n + c log c)` for `n` instances and `c` container types: one sort of the volumes,
 *  one of the weights, one of the per-unit costs. No geometry is touched. */
const BOUND_PPM=1000000n;
/** Every sum in the bound path must stay below this.
 *
 *  Declared rather than inherited. This engine's `Number` stops being exact past 2^53, PHP's
 *  integers silently become doubles on overflow, Python's are unbounded and Rust's `i128`
 *  wraps -- so if each refused at its own limit the four would disagree about which requests
 *  are answerable. Keys 3 and 4 multiply a summed volume by `PPM`, so `10^30 * 10^6` sits
 *  about 170-fold inside an `i128`. Everything guarded here is `BigInt`, because a ceiling a
 *  representation cannot hold is a ceiling it cannot enforce. */
const MAX_BOUND_SUM=10n**30n;
// Results cross the JSON/Number boundary. Intermediates may use the wider ceiling above,
// but every returned key must fit exactly in every binding before it becomes a Number.
const MAX_BOUND_VALUE=2n**53n-1n;
/** A sum in the bound path exceeded the declared ceiling. Structured rather than a number:
 *  a bound that is quietly wrong is worse than none, because it will be believed. */
export class BoundOverflowError extends Error{
  constructor(quantity,ceiling=MAX_BOUND_SUM,subject='sum'){
    super(`${quantity} ${subject} is past the ${ceiling} ceiling the bound path declares`);
    this.name='BoundOverflowError';
  }
}
function boundGuard(total,quantity){
  if(total>MAX_BOUND_SUM)throw new BoundOverflowError(quantity);
  return total;
}
function boundOutput(value,quantity){
  if(value>MAX_BOUND_VALUE){
    throw new BoundOverflowError(quantity,MAX_BOUND_VALUE,'bound');
  }
  return Number(value);
}
/** Can this item take up less room than its declared dimensions?
 *
 *  Three ways, and each breaks the same argument -- that nominal volumes sum to something a
 *  solution must carry. A nested item sinks into the one below it; a `convex_hull` occupies
 *  its hull and leaves the rest of its bounding box free; a `compressible` item gives up
 *  height under load. The design document named only the first until a soundness test over
 *  the corpus found the omission. */
function occupiesLessThanItsBox(item){
  if(item.nestingHeight!=null)return true;
  return item.shapeType==='convex_hull'||item.shapeType==='compressible';
}
const boundCeilDiv=(a,b)=>(a+b-1n)/b;
/** The largest n such that the n smallest values sum to at most the capacity. Smallest first
 *  is the whole soundness argument: the cheapest units maximise how many fit, so this
 *  over-estimates what any real packing achieves and the bound under-estimates. */
function boundFit(ascending,capacity){
  if(capacity===null)return ascending.length;
  let used=0n;
  for(let taken=0;taken<ascending.length;taken++){
    used+=ascending[taken];
    if(used>capacity)return taken;
  }
  return ascending.length;
}
/** Sum of limit*quantity, or null when any limit or inventory is undeclared. `zeroIsHarmless`
 *  is the volume rule: a container with no usable volume adds nothing however many there
 *  are, so an unlimited quantity only unbounds the total when the type holds something. */
function boundCapacity(values,quantities,zeroIsHarmless){
  let total=0n;
  for(let i=0;i<values.length;i++){
    if(values[i]===null)return null;
    if(quantities[i]===null){
      if(zeroIsHarmless&&values[i]<=0n)continue;
      return null;
    }
    total=boundGuard(total+values[i]*quantities[i],'container capacity');
  }
  return total;
}
/** The largest declared limit, or null if any type declares none: one unlimited type makes
 *  the maximum unbounded and every term conditioned on it vacuous. */
function boundFiniteMax(values){
  let best=null;
  for(const value of values){
    if(value===null)return null;
    best=best===null||value>best?value:best;
  }
  return best;
}
/** Every bound, from the numbers the formulas consume -- the shape the shared scene records,
 *  so this port is checked without reimplementing a request parser. `shrinks` is taken as
 *  given; whether this engine decides it correctly is asserted separately. */
function objectiveBounds(instances,containers){
  const volumes=instances.map(i=>i.volume).sort((a,b)=>a<b?-1:a>b?1:0);
  const weights=instances.map(i=>i.weight).sort((a,b)=>a<b?-1:a>b?1:0);
  const shrinks=instances.some(i=>i.shrinks);
  const count=instances.length;
  const usable=containers.map(c=>c.usable),inner=containers.map(c=>c.inner);
  const quantities=containers.map(c=>c.quantity);

  // The a-priori check, once, on the way in. Every later product is bounded by these totals
  // times PPM, so guarding them here is what makes the rest safe by derivation.
  boundGuard(volumes.reduce((a,b)=>a+b,0n),'instance volume');
  boundGuard(weights.reduce((a,b)=>a+b,0n),'instance weight');
  for(const container of containers){
    boundGuard(container.usable,'container capacity');
    boundGuard(container.costMinor,'opening cost');
  }

  let placeable=count;
  if(!shrinks)placeable=Math.min(placeable,boundFit(volumes,boundCapacity(usable,quantities,true)));
  placeable=Math.min(placeable,boundFit(weights,boundCapacity(containers.map(c=>c.payload),quantities,false)));
  const slotCapacity=boundCapacity(containers.map(c=>c.maxItems),quantities,false);
  if(slotCapacity!==null)placeable=Math.min(placeable,Number(slotCapacity));
  const unpacked=count-placeable,placed=placeable;

  let opened=0;
  if(placed>0&&containers.length){
    opened=1;
    if(!shrinks){
      const largest=usable.reduce((a,b)=>b>a?b:a,0n);
      if(largest>0n)opened=Math.max(opened,Number(boundCeilDiv(volumes.slice(0,placed).reduce((a,b)=>a+b,0n),largest)));
    }
    const payload=boundFiniteMax(containers.map(c=>c.payload));
    if(payload!==null&&payload>0n)opened=Math.max(opened,Number(boundCeilDiv(weights.slice(0,placed).reduce((a,b)=>a+b,0n),payload)));
    const slots=boundFiniteMax(containers.map(c=>c.maxItems));
    if(slots!==null&&slots>0n)opened=Math.max(opened,Number(boundCeilDiv(BigInt(placed),slots)));
  }

  let cost=0n;
  if(opened>0){
    const available=[];
    for(const c of containers){
      const repeat=c.quantity===null?opened:Math.min(Number(c.quantity),opened);
      for(let taken=0;taken<repeat;taken++)available.push(c.costMinor);
    }
    available.sort((a,b)=>a<b?-1:a>b?1:0);
    cost=available.slice(0,opened).reduce((a,b)=>a+b,0n);
  }

  let unused=0n;
  if(!shrinks&&opened>0&&containers.length){
    const smallest=inner.reduce((a,b)=>b<a?b:a,inner[0]);
    if(smallest>0n){
      const largestPlaced=placed>0?volumes.slice(volumes.length-placed).reduce((a,b)=>a+b,0n):0n;
      // In BigInt until it is clamped: `largestPlaced * PPM` can reach 10^36, which a
      // `Number` would round rather than carry.
      const filled=boundCeilDiv(largestPlaced*BOUND_PPM,smallest);
      const raw=BigInt(opened)*BOUND_PPM-filled-BigInt(opened-1);
      unused=raw>0n?raw:0n;
    }
  }

  let height=0n;
  if(!shrinks&&opened>0&&containers.length){
    const widest=containers.map(c=>c.baseArea).reduce((a,b)=>b>a?b:a,0n);
    const tallest=containers.map(c=>c.height).reduce((a,b)=>b>a?b:a,0n);
    if(widest>0n&&tallest>0n){
      const required=placed>0?boundCeilDiv(volumes.slice(0,placed).reduce((a,b)=>a+b,0n),widest):0n;
      const raw=required*BOUND_PPM/tallest-BigInt(opened-1);
      height=raw>0n?raw:0n;
    }
  }
  return [
    boundOutput(BigInt(unpacked),'unpacked count'),
    boundOutput(BigInt(opened),'container count'),
    boundOutput(boundGuard(cost,'opening cost'),'opening cost'),
    boundOutput(unused,'unused volume'),
    boundOutput(height,'stack height'),
  ];
}
/** Exposed for the cross-language scene test only, like `__inspectHullShapeForTests`: the
 *  bounds are internal until a contract freeze decides whether a caller ever sees a gap. */
export function __objectiveBoundsForTests(instances,containers){return objectiveBounds(instances,containers);}
export function __occupiesLessThanItsBoxForTests(item){return occupiesLessThanItsBox(item);}
function boxShape(dx,dy,dz){
  const v=[];
  for(const x of [0n,BigInt(dx)])for(const y of [0n,BigInt(dy)])for(const z of [0n,BigInt(dz)])v.push([x,y,z]);
  return {v,faces:UNIT_AXES,edges:UNIT_AXES,volume:BigInt(dx)*BigInt(dy)*BigInt(dz)};
}
/** Reorient a hull the way a rotation reorients its box, never mirroring it.
 *
 *  Three of the six rotations are odd permutations of the coordinate axes. On a cuboid that is
 *  invisible; on a hull a bare permutation returns the item's mirror image, a shape the caller
 *  does not own. One axis therefore changes sign when the permutation is odd. */
function hullRotate(vertices,code){
  const axes=ROT[code];
  let inversions=0;
  for(let i=0;i<3;i++)for(let j=i+1;j<3;j++)if(axes[i]>axes[j])inversions++;
  const sign=inversions%2?-1:1;
  const turned=vertices.map(v=>[sign*v[axes[0]],v[axes[1]],v[axes[2]]]);
  const low=[0,1,2].map(a=>Math.min(...turned.map(v=>v[a])));
  return turned.map(v=>[v[0]-low[0],v[1]-low[1],v[2]-low[2]]);
}
function separatingAxes(left,right){
  const axes=new Map();
  for(const axis of [...left.faces,...right.faces])axes.set(axisKey(axis),axis);
  for(const l of left.edges)for(const r of right.edges){
    const axis=primitiveAxis(cross3(l,r));
    if(axis)axes.set(axisKey(axis),axis);
  }
  return [...axes.values()];
}
/** Do two placed hulls overlap with positive volume? Touching is contact, not collision: the
 *  comparison is `<=`, matching the half-open convention cuboids already use. */
function hullsCollide(left,leftOrigin,right,rightOrigin){
  const lo=big3(leftOrigin),ro=big3(rightOrigin);
  for(const axis of separatingAxes(left,right)){
    const project=shape=>{let low=null,high=null;
      for(const v of shape.v){const value=dot3(v,axis);
        if(low===null||value<low)low=value;if(high===null||value>high)high=value}
      return [low,high]};
    const [ll,lh]=project(left),[rl,rh]=project(right);
    const ls=dot3(lo,axis),rs=dot3(ro,axis);
    if(lh+ls<=rl+rs||rh+rs<=ll+ls)return false;
  }
  return true;
}

// ---------------------------------------------------------------- compression

const COMPRESSION_PPM=1000000n;
const GRAVITY_NUMERATOR=980665n,GRAVITY_DENOMINATOR=100000n,PASCALS_PER_KPA=1000n;
/** Exact pressure in kPa from the cumulative mass above an item, over its footprint. Reduced,
 *  so the divisor in the height formula stays small and two engines agreeing on the value
 *  cannot disagree on the representation. */
function appliedPressure(loadTicks,footprintTicks){
  const metre=BigInt(LEN.mm)*1000n;
  const n=BigInt(loadTicks)*GRAVITY_NUMERATOR*metre*metre;
  const d=BigInt(WT.kg)*GRAVITY_DENOMINATOR*PASCALS_PER_KPA*BigInt(footprintTicks);
  const g=bigGcd(n,d)||1n;
  return {n:n/g,d:d/g};
}
/** Cross multiplication, so the inclusive boundary is decided without ever dividing. */
const pressureExceeds=(pressure,limitKpa)=>pressure.n>BigInt(limitKpa)*pressure.d;
/** Occupied height under load, rounded up, never below one tick. Rounding up keeps a discrete
 *  packer honest; the one-tick floor stops a fully compressible item reaching zero height,
 *  where it would slip past collision and support invariants entirely. */
function effectiveHeight(heightTicks,ratioPpm,limitKpa,pressure){
  if(limitKpa===0)return heightTicks;
  const divisor=BigInt(limitKpa)*COMPRESSION_PPM*pressure.d;
  const retained=divisor-BigInt(ratioPpm)*pressure.n;
  const rounded=(BigInt(heightTicks)*retained+divisor-1n)/divisor;
  return Number(rounded>1n?rounded:1n);
}
/** The published ratio rule, `floor(ratio * 1000000 + 0.5)`, applied once at the boundary so
 *  the float a caller supplied never reaches the geometry. */
function ratioToPpm(ratio){
  if(!(ratio>=0&&ratio<=1))throw new RangeError('compression_ratio must be between zero and one');
  return scaledRatio(ratio);
}
function validNesting(a,b){if(a.item.raw.id!==b.item.raw.id||a.item.nesting==null||b.item.nesting==null||a.item.nesting!==b.item.nesting)return false;
  if(a.x!==b.x||a.y!==b.y||a.x+a.ed[0]!==b.x+b.ed[0]||a.y+a.ed[1]!==b.y+b.ed[1])return false;
  const [low,high]=a.z<=b.z?[a,b]:[b,a];return low.z!==high.z&&low.z+low.ed[2]-high.z===a.item.nesting}
/** This placement's rotated hull, or `null` when its box is the honest answer.
 *
 *  `null` for every `rigid_cuboid` and for three cases that fall back to the box, always
 *  over-reserving space: a clearance has inflated the envelope past the physical box and a
 *  margin around a hull is not a hull; the item is on a route, where the sequence replay
 *  reasons with box sweeps only and packing tighter than it can verify would produce
 *  arrangements the engine then calls unloadable. */
function placedHull(placement){
  const item=placement.item;
  if(item.shapeType!=='convex_hull'||item.stopIndex!=null)return null;
  if(placement.ed[0]!==placement.pd[0]||placement.ed[1]!==placement.pd[1]||placement.ed[2]!==placement.pd[2])return null;
  return shapeFor(item.hullVertices,placement.r);
}
/** Do two placed items actually overlap? The axis-aligned envelope test is the broad phase and
 *  stays mandatory; this refines its answer only when a hull is one of the two solids. */
/** `solidsOverlap` for a candidate at (x, y, z) against a placement, without building either
 *  box when both are plain boxes -- the case of almost every pair the broad phase hands the
 *  candidate sweep. */
function solidsOverlapAt(candidateShape,x,y,z,ed,placed){
  const placedShape=placedHull(placed);
  if(candidateShape===null&&placedShape===null)return true;
  return solidsOverlap(candidateShape,{x,y,z,d:ed},placedShape,{x:placed.x,y:placed.y,z:placed.z,d:placed.ed});
}
function solidsOverlap(leftShape,leftBox,rightShape,rightBox){
  if(leftShape===null&&rightShape===null)return true;
  return hullsCollide(
    leftShape??boxShape(leftBox.d[0],leftBox.d[1],leftBox.d[2]),[leftBox.x,leftBox.y,leftBox.z],
    rightShape??boxShape(rightBox.d[0],rightBox.d[1],rightBox.d[2]),[rightBox.x,rightBox.y,rightBox.z]);
}
/** Space one placement actually takes, which is its box only if it is one.
 *
 *  A `convex_hull` item occupies its hull: counting the bounding box is not a conservative
 *  approximation of utilisation but a wrong number, putting two interlocking wedges at 200% of
 *  a crate. A `compressible` item occupies the height left after the load it reports. */
function occupiedVolume(placement,loadTicks=0){
  const item=placement.item;
  // Route and clearance can make collision conservatively use the envelope; neither changes
  // the physical solid used for utilisation and void-fill reserve accounting.
  if(item.shapeType==='convex_hull')return shapeFor(item.hullVertices,placement.r).volume;
  if(item.maxCompressionKpa==null)return volume(placement.pd);
  const footprint=placement.pd[0]*placement.pd[1];
  // The load is passed in rather than read off the placement: this engine computes top loads
  // at reporting time and never stores them, so a placement field would have been silently
  // zero and nothing would ever have compressed.
  const pressure=appliedPressure(loadTicks,footprint);
  // A crushed item has no meaningful occupied volume, and the arrangement is already invalid
  // -- the crush check refuses it and the validator reports it.
  if(pressureExceeds(pressure,item.maxCompressionKpa))return volume(placement.pd);
  return BigInt(footprint)*BigInt(effectiveHeight(placement.pd[2],item.compressionPpm,item.maxCompressionKpa,pressure));
}
/** The volume `occupiedVolume` counts for this item in any orientation, before any load.
 *
 *  A proper rotation keeps a hull's volume, so one orientation answers for all; the first
 *  allowed one is the shape placement has most likely cached already. Exact-small's capacity,
 *  unused-volume and height floors bound `usedVolume` with this: built from the box volume
 *  they put two interlocking wedges at twice a crate, pruning the packing that holds both,
 *  and left the unused-volume floor short of every reachable score. A compressible
 *  item keeps its declared volume, an upper bound on what it occupies, as in Rust. O(1)
 *  after the first `shapeFor` per distinct hull. */
function itemOccupiedVolume(item){
  if(item.shapeType==='convex_hull')return shapeFor(item.hullVertices,item.rots[0]??'LWH').volume;
  return volume(item.d);
}
/** How many more containers the plan's remaining items need at least: the largest available
 *  capacity is granted to every container still to open. A hull counts its own solid, as the
 *  beam and exact floors do; its box would overstate the need and misrank the plan.
 *  Nominal volume is not additive under nesting, so that half stands down there. O(n + t). */
function additionalContainerBound(plan,templates){const available=templates.filter(t=>plan.inventory.get(t.id)>0);if(!plan.remaining.length||!available.length)return 0;let lower=0;
  if(!plan.remaining.some(item=>item.nesting!=null)){const capacity=available.reduce((best,t)=>volume(t.d)>best?volume(t.d):best,0n),required=plan.remaining.reduce((sum,item)=>sum+itemOccupiedVolume(item),0n);if(capacity>0n)lower=Math.max(lower,Number((required+capacity-1n)/capacity))}
  if(available.every(t=>t.max!=null)){const capacity=Math.max(...available.map(t=>t.max)),required=plan.remaining.reduce((sum,item)=>sum+item.w,0);if(capacity>0)lower=Math.max(lower,Math.ceil(required/capacity))}return lower}
export function __additionalContainerBoundForTests(plan,templates){return additionalContainerBound(plan,templates)}
/** First compressible box carrying more pressure than it declared it can take.
 *
 *  Deliberately shaped like `overloaded` and reading the same propagated loads: the two answer
 *  one question in two currencies -- a mass the box below must bear, against a pressure the
 *  item itself must survive. An item can pass one and fail the other, so both are asked. */
function crushed(boxes,loads=null){
  if(boxes.every(b=>b.maxCompressionKpa==null))return false;
  if(loads==null)loads=topLoads(boxes);
  return boxes.some((b,i)=>{
    if(b.maxCompressionKpa==null)return false;
    const footprint=b.d[0]*b.d[1];
    return pressureExceeds(appliedPressure(Number(loads[i]),footprint),b.maxCompressionKpa);
  });
}
/** Parse and admit an item's shape, or refuse it with the reason.
 *
 *  Coordinates go through the length scale, which refuses a negative value, so a hull crossing
 *  the wire is authored as non-negative offsets from the corner of its own bounding box. The
 *  admission rule spans four fields at once -- which are required, which are forbidden, and
 *  what the survivors must agree with -- and mirrors the other three engines exactly. */
function parseShape(raw,d,unit,nesting){
  const shapeType=raw.shape_type??'rigid_cuboid';
  if(!['rigid_cuboid','convex_hull','compressible'].includes(shapeType))
    throw new RangeError(`item.shape_type ${shapeType} is not a known shape`);
  const hullVertices=raw.hull_vertices==null?null:raw.hull_vertices.map(v=>
    [scalar(v.x,unit,LEN),scalar(v.y,unit,LEN),scalar(v.z,unit,LEN)]);
  const compressionPpm=raw.compression_ratio==null?null:ratioToPpm(raw.compression_ratio);
  const maxCompressionKpa=raw.max_compression_pressure_kpa==null?null:Number(raw.max_compression_pressure_kpa);
  const foreign=shapeType==='convex_hull'
    ?[['compression_ratio',compressionPpm],['max_compression_pressure_kpa',maxCompressionKpa]]
    :shapeType==='compressible'?[['hull_vertices',hullVertices]]
    :[['hull_vertices',hullVertices],['compression_ratio',compressionPpm],['max_compression_pressure_kpa',maxCompressionKpa]];
  for(const [name,value] of foreign)
    if(value!=null)throw new RangeError(`${name} is not part of a ${shapeType} item`);
  // Both rewrite occupied height. Choosing an order silently would give four engines four
  // contracts, so the interaction is refused until a task defines it.
  if(nesting!=null&&shapeType!=='rigid_cuboid')
    throw new RangeError(`nesting_height with shape_type ${shapeType} is not supported yet`);
  if(shapeType==='convex_hull'){
    if(hullVertices===null)throw new RangeError('a convex_hull item requires hull_vertices');
    const points=hullValidate(hullVertices);
    for(let axis=0;axis<3;axis++){
      const span=Math.max(...points.map(v=>v[axis]))-Math.min(...points.map(v=>v[axis]));
      // `dimensions` stays the broad phase and the candidate-generation envelope, so a hull
      // poking out of it would be collision-tested against space never reserved.
      if(span>d[axis])throw new RangeError('hull_vertices span does not fit inside dimensions');
    }
  }
  if(shapeType==='compressible'){
    if(compressionPpm===null||maxCompressionKpa===null)
      throw new RangeError('a compressible item requires both compression_ratio and max_compression_pressure_kpa');
    if(maxCompressionKpa<0)throw new RangeError('max_compression_pressure_kpa cannot be negative');
  }
  return {shapeType,hullVertices,compressionPpm,maxCompressionKpa};
}
function usedVolume(placements){
  // Compression needs the cumulative mass above each item, which is the same propagation the
  // reported `top_load` uses -- one traversal, read twice.
  const loads=placements.some(p=>p.item.maxCompressionKpa!=null)
    ?topLoads(placements.map(constraintBox)):null;
  let total=placements.reduce((s,p,i)=>s+occupiedVolume(p,loads===null?0:Number(loads[i])),0n),overlap=0n;
  // Only a pair of nesting placements can overlap, so the pair scan runs over those alone, in
  // placement order: O(n + k^2) for k nesting placements instead of O(n^2) for every result.
  const nesting=[];for(const p of placements)if(p.item.nesting!=null)nesting.push(p);
  for(let i=0;i<nesting.length;i++)for(let j=i+1;j<nesting.length;j++)if(validNesting(nesting[i],nesting[j]))
    overlap+=BigInt(nesting[i].item.nesting)*BigInt(nesting[i].ed[0])*BigInt(nesting[i].ed[1]);
  return total-overlap}
// What `tentative` would add to `usedVolume(placements.concat(tentative))`, without
// recomputing it. Appending to the end only creates the pairs that include the new
// placement, so the delta is its own volume less the nesting overlap it forms against
// what is already there -- O(n) where `usedVolume` is O(n^2). The search calls this once
// per candidate orientation, which is what made the whole solve super-linear in item
// count before.
function usedVolumeDelta(placements,tentative){let delta=occupiedVolume(tentative);
  for(const placed of placements)if(validNesting(placed,tentative))
    delta-=BigInt(placed.item.nesting)*BigInt(placed.ed[0])*BigInt(placed.ed[1]);
  return delta}
// Candidate points are consumed smallest-first by (z, y, x) and only the leading
// `max_candidate_points` are ever read, so the search keeps one array in that order and
// inserts into it as placements are committed, rather than rebuilding and re-sorting the
// whole set for every item. Two points compare equal only when all three
// coordinates match, i.e. only when they are the same point, so insertion order among
// equals cannot change which set the slice returns.
// Broad-phase collision index: a uniform 3D cell grid over the container's own inner
// dimensions, sized so a typical container holds roughly `CELLS_PER_AXIS` cells along each
// axis -- coarse enough that a handful of placements do not each get a private cell, fine
// enough that hundreds spread across many. Mirrors Python's `spatial_index.SpatialIndex`
// and the PHP and Rust equivalents. The JavaScript fallback was the one engine
// still scanning every placement linearly for every candidate orientation, which is what
// made its collision work grow with the square of the item count: 212 million narrow-phase
// checks at 100 items, against Python's zero.
const CELLS_PER_AXIS=8;
function ceilDiv(a,b){return Math.floor((a+b-1)/b)}
// One numeric key per cell: a Map keyed by number avoids building a string per lookup in
// the innermost loop. Cell indices are bounded by CELLS_PER_AXIS plus the overshoot of a
// box wider than the container, so 4096 per axis cannot collide.
function cellKey(ix,iy,iz){return (ix*4096+iy)*4096+iz}
function makeIndex(d){return {cx:Math.max(1,ceilDiv(Math.max(1,d[0]),CELLS_PER_AXIS)),
  cy:Math.max(1,ceilDiv(Math.max(1,d[1]),CELLS_PER_AXIS)),
  cz:Math.max(1,ceilDiv(Math.max(1,d[2]),CELLS_PER_AXIS)),
  cells:new Map(),owned:new WeakSet(),seen:[],gen:0}}
function cellRange(index,box){return [
  Math.floor(box.x/index.cx),ceilDiv(Math.max(box.x+box.d[0],box.x+1),index.cx),
  Math.floor(box.y/index.cy),ceilDiv(Math.max(box.y+box.d[1],box.y+1),index.cy),
  Math.floor(box.z/index.cz),ceilDiv(Math.max(box.z+box.d[2],box.z+1),index.cz)]}
function indexAdd(index,position,box){const [ix1,ix2,iy1,iy2,iz1,iz2]=cellRange(index,box);
  index.seen[position]=0;
  for(let ix=ix1;ix<ix2;ix++)for(let iy=iy1;iy<iy2;iy++)for(let iz=iz1;iz<iz2;iz++){
    const key=cellKey(ix,iy,iz);let bucket=index.cells.get(key);
    if(!bucket||!index.owned.has(bucket)){
      bucket=bucket?bucket.slice():[];index.cells.set(key,bucket);index.owned.add(bucket)}
    bucket.push(position)}}
function copyIndex(index){
  // Both sides now share buckets; neither may append until it owns a private copy.
  index.owned=new WeakSet();
  return {cx:index.cx,cy:index.cy,cz:index.cz,cells:new Map(index.cells),owned:new WeakSet(),
    seen:index.seen.slice(),gen:index.gen}}

// Private-module test access to per-call index state; not re-exported by index.js.
export const __spatialIndexForTests=Object.freeze({make:makeIndex,add:indexAdd,copy:copyIndex});
function comparePoints(a,b){return a[2]-b[2]||a[1]-b[1]||a[0]-b[0]}
function insertPoint(points,point){let low=0,high=points.length;
  while(low<high){const mid=(low+high)>>1;if(comparePoints(points[mid],point)<=0)low=mid+1;else high=mid}
  points.splice(low,0,point)}
// A candidate point that falls inside a placed box can never host anything again: any
// positively-sized item originating there overlaps that box. Retiring those keeps the
// candidate list bounded instead of letting it grow with every placement, which is what
// left the fallback evaluating two orders of magnitude more points per item than Python
//. The half-open test matches `intersects`.
/** Retire the points a placement covers -- unless it is a hull.
 *
 *  Retiring a point because it falls inside a solid's box assumes the box *is* the solid. For a
 *  hull it is not: a placement origin is a corner of a bounding box, and a hull leaves most of
 *  that box -- including, for a wedge, the origin itself -- available to the next item. Pruning
 *  them first would mean the engine could describe an interlocking pack it could never propose,
 *  and the exact collision test would be correct and never consulted.
 *
 *  One wrapper rather than a guard at each call site: the Rust port found a *second* place that
 *  treated a box as the solid, and a single entry point is what makes a third impossible to
 *  forget. */
function retirePointsForPlacement(points,placement){
  if(placedHull(placement)!==null)return;
  retirePointsInside(points,{x:placement.x,y:placement.y,z:placement.z,d:placement.ed});
}
function retirePointsInside(points,box){const x2=box.x+box.d[0],y2=box.y+box.d[1],z2=box.z+box.d[2];
  let write=0;
  for(let read=0;read<points.length;read++){const p=points[read];
    if(p[0]>=box.x&&p[0]<x2&&p[1]>=box.y&&p[1]<y2&&p[2]>=box.z&&p[2]<z2)continue;
    points[write++]=p}
  points.length=write}
function pointsFrom(placement){const {x,y,z,ed,item}=placement;
  return item.nesting==null
    ?[[x+ed[0],y,z],[x,y+ed[1],z],[x,y,z+ed[2]]]
    :[[x+ed[0],y,z],[x,y+ed[1],z],[x,y,z+ed[2]],[x,y,z+ed[2]-item.nesting]]}
function centreOfMassOffsetPpm(container,placements,clearance=0){let total=0n,wx=0n,wy=0n;
  for(const p of placements){const w=BigInt(p.item.w);total+=w;wx+=w*BigInt(2*(p.x+clearance)+p.pd[0]);wy+=w*BigInt(2*(p.y+clearance)+p.pd[1])}
  if(total===0n)return 0;const length=BigInt(container.d[0]),width=BigInt(container.d[1]);
  const x=(wx-total*length)<0n?total*length-wx:wx-total*length,y=(wy-total*width)<0n?total*width-wy:wy-total*width;
  return Number((x*1000000n/(total*length))>(y*1000000n/(total*width))?x*1000000n/(total*length):y*1000000n/(total*width))}
function axleReactions(container,placements,extra=null){if(container.axleSpec==null)return null;
  const [front,rear]=container.axleSpec;let {total,moment:weighted}=axleLoad(container,placements);
  if(extra){const w=BigInt(extra.item.w);total+=w;weighted+=w*BigInt(2*extra.x+extra.ed[0])}
  const denominator=2n*BigInt(rear.position-front.position);
  return {denominator,front:2n*total*BigInt(rear.position)-weighted,rear:weighted-2n*total*BigInt(front.position)}}
function axleOverloaded(container,placements,extra=null){const reaction=axleReactions(container,placements,extra);if(reaction==null)return false;
  const [front,rear]=container.axleSpec;
  return (front.max!=null&&reaction.front>BigInt(front.max)*reaction.denominator)
    ||(rear.max!=null&&reaction.rear>BigInt(rear.max)*reaction.denominator)}
// Whether one item, alone in an empty container, has an x-origin that overloads
// neither axle. Each limit is linear in the item's doubled centre, so the feasible origins
// form one interval whose ends are exact BigInt quotients; O(1). Not a proof: a
// counterweight behind the rear axle can relieve the front one.
function floorDivBig(a,b){const q=a/b;return a%b!==0n&&a<0n?q-1n:q}
function axleAdmitsAlone(container,weight,envelopeLength){
  const last=container.d[0]-envelopeLength;if(last<0)return false;
  if(container.axleSpec==null)return true;
  if(weight<=0)return !axleOverloaded(container,[]);
  const {front,rear}=axleBalancedOrigins(container,axleLoad(container,[]),weight,envelopeLength);
  const lowest=front!=null&&front>0n?front:0n,highest=rear!=null&&rear<BigInt(last)?rear:BigInt(last);
  return lowest<=highest}
// What the tare and `placements` load onto the axles: total weight and doubled moment about
// x = 0, the tare at the container's centre. O(p), BigInt so no intermediate rounds.
function axleLoad(container,placements){const tare=BigInt(container.tare);let total=tare,moment=tare*BigInt(container.d[0]);
  for(const p of placements){const w=BigInt(p.item.w);total+=w;moment+=w*BigInt(2*p.x+p.ed[0])}
  return {total,moment}}
// The x-origins that seat an item of `weight` and envelope length `envelopeLength` exactly on
// each axle's own limit on top of `load`, as Python's `axle_balanced_origins`: each limit is
// linear in the item's doubled centre, so solving it for that centre gives one exact BigInt
// boundary per limited axle, rounded to its safe side (front: ceil, rear: floor). `null` for
// an axle with no limit. O(1).
function axleBalancedOrigins(container,load,weight,envelopeLength){
  const [front,rear]=container.axleSpec,w=BigInt(weight),l=BigInt(envelopeLength),total=load.total+w;
  const denominator=2n*BigInt(rear.position-front.position);
  const frontOrigin=front.max==null?null
    :-floorDivBig(-(-floorDivBig(-(2n*total*BigInt(rear.position)-BigInt(front.max)*denominator-load.moment),w)-l),2n);
  const rearOrigin=rear.max==null?null
    :floorDivBig(floorDivBig(BigInt(rear.max)*denominator+2n*total*BigInt(front.position)-load.moment,w)-l,2n);
  return {front:frontOrigin,rear:rearOrigin}}
// Extra floor-level candidates that seat the item on an axle's own limit, as Python's
// `_axle_balanced_points`. Every other point is flush against a wall or a placed box, which
// is complete for volume packing but not under axle limits: the only feasible spot can float
// in open floor space purely to keep the item's moment off one axle. Floor level only, where
// support needs no lateral contact. O(p + r*Y) for p placements, r rotations and Y distinct
// floor-level point ys; nothing for an item that weighs nothing or a container without axles.
// The envelopes are the item's declared rotations grown by the clearance, in that order, as
// the candidate sweep's own.
function axleBalancedPoints(container,placements,points,item,clearance){
  if(container.axleSpec==null||item.w<=0)return [];
  const floorYs=[...new Set(points.filter(point=>point[2]===0).map(point=>point[1]))].sort((a,b)=>a-b);
  if(!floorYs.length)floorYs.push(0);
  const load=axleLoad(container,placements),out=[];
  for(const r of item.rots){const length=rotate(item.d,r)[0]+2*clearance;
    const {front,rear}=axleBalancedOrigins(container,load,item.w,length),last=BigInt(container.d[0]-length);
    for(const origin of [front,rear])if(origin!=null&&origin>=0n&&origin<=last)for(const y of floorYs)out.push([Number(origin),y,0])}
  return out}
function fitsTemplateAlone(c,d){return d.every((edge,k)=>edge<=c.d[k])&&(!c.bag||(d[0]+d[2]<=c.d[0]&&d[1]+d[2]<=c.d[1]))}
// The container limit that left an item out, for the search_exhausted
// fallback, or null when none explains it. The same rule, in the same order, as every
// engine: an axle that refuses the item alone in every container otherwise admitting it,
// else stock or max_containers exhausted for every such container that would take it.
// max_items, cumulative payload, tag_limits, stop access and an axle's share of a full
// load can only refuse an item a fresh container would take, so they surface as the
// inventory. `opened` counts the layout's containers per template, built once; O(C*R).
function limitReason(i,templates,opened,maxContainers,clear){
  const envelopes=uniqueRotations(i.d,i.rots).map(([,d])=>d.map(x=>x+2*clear));
  let compatible=false;const admitting=[];
  for(const c of templates){
    const fitting=envelopes.filter(d=>fitsTemplateAlone(c,d));
    if(!fitting.length||(c.max!=null&&i.w>c.max))continue;
    if(i.eligibleTags.length&&!i.eligibleTags.some(tag=>(c.tags??[]).includes(tag)))continue;
    compatible=true;
    if(fitting.some(d=>axleAdmitsAlone(c,i.w,d[0])))admitting.push(c);
  }
  if(!compatible)return null;
  if(!admitting.length)return 'axle_overloaded';
  let total=0;for(const count of opened.values())total+=count;
  if(total>=maxContainers)return 'container_inventory_exhausted';
  return admitting.every(c=>c.quantity!=null&&(opened.get(c.id)??0)>=c.quantity)?'container_inventory_exhausted':null;
}
function overlapXY(a,b){const dx=Math.max(0,Math.min(a.x+a.d[0],b.x+b.d[0])-Math.max(a.x,b.x));const dy=Math.max(0,Math.min(a.y+a.d[1],b.y+b.d[1])-Math.max(a.y,b.y));return dx*dy}
// `overlapXY` on a placement's own fields: the same arithmetic without first copying the
// placement into a `{x,y,z,d}` box, which the candidate sweep did once per comparison.
function footprintOverlap(placement,x,y,length,width){const d=placementDimensions(placement);
  const dx=Math.max(0,Math.min(placement.x+d[0],x+length)-Math.max(placement.x,x));const dy=Math.max(0,Math.min(placement.y+d[1],y+width)-Math.max(placement.y,y));return dx*dy}
function placementDimensions(placement){return placement.ed??placement.d}
function placementItemType(placement){return placement.itemType??placement.item?.raw?.id??null}
function placementNesting(placement){return placement.nesting??placement.item?.nesting??null}
function sameNestingColumn(left,right){const leftNesting=placementNesting(left),rightNesting=placementNesting(right);
  const leftType=placementItemType(left),rightType=placementItemType(right);
  if(leftType==null||rightType==null||leftType!==rightType||leftNesting==null||rightNesting==null||leftNesting!==rightNesting)return false;
  const ld=placementDimensions(left),rd=placementDimensions(right);
  return left.x===right.x&&left.y===right.y&&left.x+ld[0]===right.x+rd[0]&&left.y+ld[1]===right.y+rd[1]}
// One candidate's exact direct supporters in O(n). A nested predecessor replaces only
// shadowed face contacts from its own type/footprint column; unrelated face supporters
// retain their original order and semantics.
// Shared by every floor candidate, which rests on nothing; never written to.
const NO_SUPPORTERS=Object.freeze([]);
function directSupporters(candidate,placed,topPlane=null){const dimensions=placementDimensions(candidate);let predecessor=null;
  // With the scene bucketed by top face, a non-nesting candidate reads only the placements
  // whose top is its own base: no predecessor can exist and no supporter is shadowed, so
  // the full scan below reduces to its second loop over that one bucket, in the same order.
  if(topPlane!==null&&placementNesting(candidate)==null){const supporters=[],level=topPlane.get(candidate.z);
    if(level===undefined)return supporters;
    for(let index=0;index<level.length;index++){const other=level[index];if(other===candidate)continue;
      const area=footprintOverlap(other,candidate.x,candidate.y,dimensions[0],dimensions[1]);
      if(area>0)supporters.push({placement:other,area})}
    return supporters}
  for(let index=0;index<placed.length;index++){const other=placed[index];if(other===candidate||other.z>=candidate.z||!sameNestingColumn(other,candidate))continue;
    if(predecessor==null||other.z>=predecessor.z)predecessor=other}
  if(predecessor!=null&&predecessor.z+placementDimensions(predecessor)[2]-candidate.z!==placementNesting(predecessor))predecessor=null;
  const supporters=[];
  for(let index=0;index<placed.length;index++){const other=placed[index];if(other===candidate)continue;const otherDimensions=placementDimensions(other);
    if(other.z+otherDimensions[2]!==candidate.z)continue;
    const area=overlapXY({x:other.x,y:other.y,z:other.z,d:otherDimensions},{x:candidate.x,y:candidate.y,z:candidate.z,d:dimensions});
    if(area<=0||(predecessor!=null&&sameNestingColumn(other,candidate)))continue;
    supporters.push({placement:other,area})}
  if(predecessor!=null)supporters.push({placement:predecessor,area:dimensions[0]*dimensions[1]});
  return supporters}
// Exact BigInt long division rounded to 8 places, ties to even, matching
// Python's Decimal.quantize default context -- not a float divide, which is neither
// exact for large tick counts nor consistent with the other three engines' rule.
const MAX_SAFE_BIGINT=BigInt(Number.MAX_SAFE_INTEGER);
function decimalString(v,divisor,places=8){
  if(Number.isSafeInteger(divisor*10)){
    if(typeof v==='number'){const truncated=Math.trunc(v);if(Number.isSafeInteger(truncated))return safeDecimalString(truncated,divisor,places)}
    else if(v>=-MAX_SAFE_BIGINT&&v<=MAX_SAFE_BIGINT)return safeDecimalString(Number(v),divisor,places)}
  let ticks=typeof v==='bigint'?v:BigInt(Math.trunc(v));const negative=ticks<0n;if(negative)ticks=-ticks;const div=BigInt(divisor);
  let whole=ticks/div,remainder=ticks%div,digits='';
  for(let i=0;i<places;i++){remainder*=10n;digits+=(remainder/div).toString();remainder%=div}
  const lastOdd=digits.length?Number(digits[digits.length-1])%2===1:whole%2n===1n;
  if(remainder*2n>div||(remainder*2n===div&&lastOdd)){
    const chars=digits.split('');let i=chars.length-1;
    for(;i>=0&&chars[i]==='9';i--)chars[i]='0';
    if(i>=0)chars[i]=String(Number(chars[i])+1);else whole+=1n;
    digits=chars.join('')
  }
  digits=digits.replace(/0+$/,'');
  const text=digits===''?whole.toString():`${whole}.${digits}`;
  return text==='0'?'0':(negative?'-':'')+text
}
// S13: a ratio written with six places, rounded half to even from the exact fraction, as Python's
// and PHP's formatting does -- `toFixed` rounds an exact half up (1/128 -> 0.007813, not 0.007812).
// Both operands are non-negative integers (Number or BigInt) and the denominator is positive. O(1).
function sixPlaces(numerator,denominator){
  const scaled=BigInt(numerator)*1000000n,divisor=BigInt(denominator);
  let quotient=scaled/divisor;const twice=(scaled%divisor)*2n;
  if(twice>divisor||(twice===divisor&&quotient%2n===1n))quotient+=1n;
  return `${quotient/1000000n}.${(quotient%1000000n).toString().padStart(6,'0')}`;
}
// The exact value of a finite non-negative double as [numerator, denominator], so a ratio the
// caller sent as a float formats as Python's `f"{ratio:.6f}"` does: on the double's own value.
function doubleFraction(value){
  const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,value);
  const bits=view.getBigUint64(0),exponent=Number((bits>>52n)&0x7ffn),fraction=bits&0xfffffffffffffn;
  const mantissa=exponent===0?fraction:fraction|(1n<<52n),shift=(exponent===0?1:exponent)-1075;
  return shift>=0?[mantissa<<BigInt(shift),1n]:[mantissa,1n<<BigInt(-shift)];
}
// `decimalString` for a safe-integer tick count, in Number arithmetic. Every intermediate is an
// integer below 10 * divisor or below |v|, so each `%` and each exact quotient is exact and the
// digits, the rounding and the text are the BigInt path's own; a result writes six of these per
// placement, which in BigInt was most of the writer's cost before the JIT warms up.
function safeDecimalString(v,divisor,places){const negative=v<0,ticks=negative?-v:v;
  let remainder=ticks%divisor,whole=(ticks-remainder)/divisor,digits='';
  for(let i=0;i<places;i++){remainder*=10;const digit=(remainder-remainder%divisor)/divisor;digits+=digit;remainder-=digit*divisor}
  const lastOdd=digits.length?Number(digits[digits.length-1])%2===1:whole%2===1;
  if(remainder*2>divisor||(remainder*2===divisor&&lastOdd)){
    const chars=digits.split('');let i=chars.length-1;
    for(;i>=0&&chars[i]==='9';i--)chars[i]='0';
    if(i>=0)chars[i]=String(Number(chars[i])+1);else whole+=1;
    digits=chars.join('')
  }
  digits=digits.replace(/0+$/,'');
  const text=digits===''?String(whole):`${whole}.${digits}`;
  return text==='0'?'0':(negative?'-':'')+text
}
function outLength(v,u){return {ticks:v,value:decimalString(v,LEN[u]),unit:u}}
function outDims(d,u){return {length:outLength(d[0],u),width:outLength(d[1],u),height:outLength(d[2],u)}}
function outPoint(p,u){return {x:outLength(p.x,u),y:outLength(p.y,u),z:outLength(p.z,u)}}
// JSON has no BigInt scalar, while the established result schema exposes `ticks` as a
// number. Keep the exact integer through every calculation and comparison, render the
// decimal value from it, and convert only the compatibility `ticks` field here.
function outWeight(v,u){const exact=typeof v==='bigint'?v:BigInt(v);return {ticks:Number(exact),value:decimalString(exact,WT[u]),unit:u}}
function proofForReason(reason,details=[]){const level=['no_compatible_container_dimensions','payload_exceeded','no_eligible_container','rotation_restricted','policy_rule'].includes(reason)?'proven':['time_limit','effort_limit'].includes(reason)?'unknown_due_to_limit':['no_feasible_placement','search_exhausted','exact_search_incomplete','insufficient_support'].includes(reason)?'observed':'inferred';return {level,observations:[{code:reason,count:1,details}]}}
function catalogVersionsUsed(raw=[]){
  if(!Array.isArray(raw))throw new TypeError('catalog_versions_used must be an array');
  const required=['catalog_id','effective_at','resolved_at','version'],seen=new Set();
  return raw.map((reference,index)=>{
    if(reference===null||typeof reference!=='object'||Array.isArray(reference)||JSON.stringify(Object.keys(reference).sort())!==JSON.stringify(required))throw new TypeError(`catalog_versions_used[${index}] must contain exactly the canonical fields`);
    if(typeof reference.catalog_id!=='string'||reference.catalog_id.length===0)throw new TypeError(`catalog_versions_used[${index}].catalog_id must be non-empty`);
    if(seen.has(reference.catalog_id))throw new TypeError(`catalog_versions_used contains ambiguous duplicate ${JSON.stringify(reference.catalog_id)}`);
    seen.add(reference.catalog_id);
    for(const [field,minimum] of [['version',1],['effective_at',0],['resolved_at',0]])if(!Number.isInteger(reference[field])||reference[field]<minimum)throw new TypeError(`catalog_versions_used[${index}].${field} must be >= ${minimum}`);
    return {...reference};
  });
}
export const REASON_MESSAGES=Object.freeze({
  no_compatible_container_dimensions:'does not fit inside any offered container in any rotation',
  rotation_restricted:'would fit in some container with more rotations allowed, but not with the rotations this item permits',
  payload_exceeded:'exceeds the maximum payload of every offered container',
  policy_rule:'is forbidden from every offered container by a policy rule the request declared -- the rule and version are in the details',
  no_eligible_container:'shares no eligible container tag with any offered container',
  time_limit:'was not reached before the configured time limit expired',
  effort_limit:'was not reached before the configured effort budget was exhausted',
  group_cannot_fit_together:'belongs to a group that could not all be placed together',
  insufficient_support:'would fit geometrically, but only by resting on support the minimum support ratio forbids',
  no_feasible_placement:'found no feasible placement in the containers offered, for a reason the search could not further isolate',
  search_exhausted:'was not placed before the configured search strategies were exhausted',
  exact_search_incomplete:'was not placed because the exact search ended before proving a final answer',
  container_inventory_exhausted:'requires another compatible container, but the declared inventory is exhausted',
  axle_overloaded:'would overload an axle wherever it stood alone in any container that otherwise admits it',
});
export function explainReason(reason){
  const message=REASON_MESSAGES[reason];
  if(message===undefined){const error=new RangeError(`no explanation registered for reason code ${JSON.stringify(reason)}`);error.code='unknown_reason';error.reason=reason;throw error}
  return message;
}
export function explanationForUnpackedItem(item){
  return {message_key:`packvium.unpacked.${item.reason}`,arguments:{item_id:item.item_id,evidence_level:item.proof?.level??'',details:(item.details??[]).join('; ')},default_message:explainReason(item.reason)};
}
export function explainUnpackedItem(item){
  const descriptor=explanationForUnpackedItem(item),prefix={proven:'Proven: ','unknown_due_to_limit':'Unknown (limit reached): ',observed:'Observed: ',inferred:'Inferred: '}[item.proof?.level]??'',details=item.details?.length?` (${item.details.join('; ')})`:'';
  return `${item.item_id}: ${prefix}${descriptor.default_message}${details}`;
}
export function aggregateTermination(starts,error=false){if(!Array.isArray(starts)||starts.length===0)throw new Error('termination aggregation requires at least one start record');const selected=starts.filter(start=>start.selected);if(selected.length!==1)throw new Error('termination aggregation requires exactly one selected start');const anyStartTruncated=starts.some(start=>start.truncated),allRequiredStartsCompleted=starts.every(start=>start.completed),winningStartTruncated=selected[0].truncated,globalDeadlineReached=starts.some(start=>start.global_deadline_reached);return {code:error?'error':winningStartTruncated||globalDeadlineReached?'time_limit':'complete',any_start_truncated:anyStartTruncated,all_required_starts_completed:allRequiredStartsCompleted,winning_start_truncated:winningStartTruncated,global_deadline_reached:globalDeadlineReached,starts}}
// S15: a deadline measures elapsed time, so it reads a monotonic clock; a wall clock steps when
// the host's time is set. The clock stays injectable, so tests drive time by hand.
const monotonicNow=()=>performance.now();
export class Deadline{constructor(limitMs,clock=monotonicNow){this.clock=clock;this.started=clock();this.limitMs=Math.max(1,limitMs)}elapsedMs(){return this.clock()-this.started}remainingMs(){return this.limitMs-this.elapsedMs()}expired(){return this.remainingMs()<=0}}

// Exact floor(baseArea * ratio / 1) with the ratio held at parts per million, so support
// is decided on integers rather than a float comparison against an epsilon.
function requiredArea(baseArea,ratioPpm){const whole=Math.floor(baseArea/SUPPORT_SCALE),rest=baseArea%SUPPORT_SCALE;return whole*ratioPpm+Math.floor(rest*ratioPpm/SUPPORT_SCALE)}

// Weight borne by each box once everything above it is accounted for. Boxes are settled
// from the top down and each one pushes its own weight plus its accumulated load onto the
// faces it touches, split by contact area.
// Direct support graph in expected O(n log n + e), where e is the number of nearby
// same-plane candidates returned by the broad phase. Nested instances are grouped by
// type and exact XY footprint, then sorted once so each instance transfers load to its
// adjacent predecessor instead of a non-adjacent face it happens to touch. Worst case
// remains O(n^2) when the physical contact graph itself is dense.
function contactGraph(boxes){const graph=buildContactGraph(boxes,overlapXY),groupKeys=boxes.map(()=>null),groups=new Map();
  boxes.forEach((box,index)=>{if(box.itemType==null||box.nesting==null)return;
    const key=JSON.stringify([box.itemType,box.nesting,box.x,box.y,box.d[0],box.d[1]]);groupKeys[index]=key;
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(index)});
  const predecessors=new Map();
  for(const indices of groups.values()){indices.sort((left,right)=>boxes[left].z-boxes[right].z||left-right);
    for(let offset=1;offset<indices.length;offset++){const lower=indices[offset-1],upper=indices[offset];
      if(boxes[lower].z+boxes[lower].d[2]-boxes[upper].z===boxes[lower].nesting)predecessors.set(upper,lower)}}
  if(predecessors.size===0)return graph;
  for(const [upper,lower] of predecessors){const key=groupKeys[upper];
    const supports=graph.supporters[upper].filter(([candidate])=>groupKeys[candidate]!==key);
    const edge=[lower,overlapXY(boxes[lower],boxes[upper])],position=supports.findIndex(([candidate])=>candidate>lower);
    if(position===-1)supports.push(edge);else supports.splice(position,0,edge);
    graph.supporters[upper]=supports}
  graph.children=boxes.map(()=>[]);
  graph.supporters.forEach((supports,upper)=>supports.forEach(([lower])=>graph.children[lower].push(upper)));
  return graph}

function constraintBox(placement){return {x:placement.x,y:placement.y,z:placement.z,d:placement.ed,w:placement.item.w,
  maxTop:placement.item.maxTop,maxStacked:placement.item.maxStacked,itemType:placement.item.raw.id,nesting:placement.item.nesting,
  // Load propagation already computes the cumulative mass above every box, which is exactly
  // the numerator the pressure model needs, so the crush check rides the graph that is built
  // anyway rather than a second one.
  maxCompressionKpa:placement.item.maxCompressionKpa,compressionPpm:placement.item.compressionPpm,
  stopIndex:placement.item.stopIndex}}

// Ties between equal scores fall to enumeration order unless a solver ranks them further.
const noTieBreak=()=>0;
// The extreme-point rank after the score, as Rust's `candidate_order_key`: the envelope's
// far corner z2, y2, x2, then its origin z, y, x and the rotation name. Compared field by
// field, never folded into one weighted number: on a long container x2 outweighs a
// sub-millimetre step in y2 under any fixed weights, and the sum leaves 2^53.
// A full tie between two cuboid rotations means the same box, which Rust sweeps once under
// the first allowed rotation; enumeration order is that choice, so only a hull, whose
// rotations Rust keeps apart, compares the names.
function compareFarCorner(a,b){const ae=a.ed,be=b.ed;
  return (a.z+ae[2])-(b.z+be[2])||(a.y+ae[1])-(b.y+be[1])||(a.x+ae[0])-(b.x+be[0])
    ||a.z-b.z||a.y-b.y||a.x-b.x
    ||(a.item.shapeType==='convex_hull'?(a.r<b.r?-1:a.r>b.r?1:0):0)}
// Keep only the requested prefix: the root is the worst score, latest tie first.
// Ordinals make heap eviction preserve the stable full-sort order exactly.
function compareRetained(a,b,tieBreak=noTieBreak){return a.score-b.score||tieBreak(a.candidate,b.candidate)||a.ordinal-b.ordinal}
function retainCandidate(heap,width,score,ordinal,candidate,tieBreak=noTieBreak){
  if(heap.length===width&&(score-heap[0].score||tieBreak(candidate,heap[0].candidate))>=0)return;
  const entry={score,ordinal,candidate};
  if(heap.length<width){
    let at=heap.length;heap.push(entry);
    while(at>0){const parent=Math.floor((at-1)/2);if(compareRetained(heap[parent],entry,tieBreak)>=0)break;
      heap[at]=heap[parent];at=parent}
    heap[at]=entry;return;
  }
  let at=0;
  while(at*2+1<heap.length){let child=at*2+1;
    if(child+1<heap.length&&compareRetained(heap[child+1],heap[child],tieBreak)>0)child++;
    if(compareRetained(entry,heap[child],tieBreak)>=0)break;
    heap[at]=heap[child];at=child}
  heap[at]=entry;
}
function groupBatches(items){const batches=[],groups=new Map();
  for(const item of items){
    if(item.group===null){batches.push([item]);continue}
    let batch=groups.get(item.group);
    if(batch===undefined){batch=[];groups.set(item.group,batch);batches.push(batch)}
    batch.push(item)}
  return batches;
}
// Internal test probes, deliberately absent from the package's index.js exports.
export function __candidatePrefixForTests(scores,width){const heap=[];
  scores.forEach((score,ordinal)=>retainCandidate(heap,width,score,ordinal,ordinal));
  return heap.sort(compareRetained).map(entry=>entry.candidate)}
export function __groupBatchesForTests(items){return groupBatches(items)}

// The order boxes settle in: highest top first, then highest base, then index. A strict
// total order, so the permutation it yields is unique -- which is what lets a candidate
// sweep insert one box into the scene's settled order rather than sort per candidate.
function settleOrder(boxes){return boxes.map((b,i)=>i).sort((a,b)=>(boxes[b].z+boxes[b].d[2])-(boxes[a].z+boxes[a].d[2])||boxes[b].z-boxes[a].z||a-b)}
// `settleOrder(boxes)` given the settled order of every box but the last. The last box has
// the highest index, so it follows every box it ties with, and the order is monotone in
// (top, base), so its slot is a binary search: O(n) for the copy against O(n log n) for the
// sort the load path used to pay per candidate.
function settleOrderWith(baseOrder,boxes){const last=boxes.length-1,top=boxes[last].z+boxes[last].d[2],base=boxes[last].z;
  let low=0,high=baseOrder.length;
  while(low<high){const mid=(low+high)>>1,box=boxes[baseOrder[mid]],boxTop=box.z+box.d[2];
    if(top>boxTop||(top===boxTop&&base>box.z))high=mid;else low=mid+1}
  const order=baseOrder.slice(0,low);order.push(last);for(let i=low;i<baseOrder.length;i++)order.push(baseOrder[i]);
  return order}
function topLoads(boxes,graph=contactGraph(boxes),order=settleOrder(boxes)){const loads=boxes.map(()=>0n);
  for(const upper of order){const supports=graph.supporters[upper];let total=0n;
    for(const [,area] of supports)total+=BigInt(area);
    if(total===0n)continue;
    // Both operands are individually safe integers, but their product need not be.
    // Keeping the whole distribution in BigInt makes floor(weight * area / total)
    // exact and also prevents rounding errors from accumulating down a tall stack.
    // Conversion to Number is deferred to `outWeight`, the existing JSON boundary.
    const downward=BigInt(boxes[upper].w)+loads[upper];let assigned=0n;
    supports.forEach(([i,area],n)=>{const share=n===supports.length-1?downward-assigned:downward*BigInt(area)/total;assigned+=share;loads[i]+=share})}
  return loads}

function overloaded(boxes,loads=null){if(boxes.every(b=>b.maxTop==null))return false;if(loads==null)loads=topLoads(boxes);
  return boxes.some((b,i)=>b.maxTop!=null&&loads[i]>BigInt(b.maxTop))}
function supportChildren(boxes,graph=null){return (graph??contactGraph(boxes)).children}
// Guarded like `overloaded` above: the transitive walk is unnecessary when no item
// declares a limit at all, which is the common case.
// The guard is a short circuit, not a semantic change -- with every `maxStacked` null the
// predicate below returns false for each box anyway.
function stackLimitsExceeded(boxes,graph=null){if(boxes.every(b=>b.maxStacked==null))return false;
  const children=supportChildren(boxes,graph);
  return boxes.some((box,root)=>{if(box.maxStacked==null)return false;const seen=new Set(),pending=[...children[root]];while(pending.length){const i=pending.pop();if(!seen.has(i)){seen.add(i);pending.push(...children[i])}}return seen.size>box.maxStacked})}
function stackDensityExceeded(boxes,maxDensity,loads=null){if(maxDensity==null)return false;if(loads==null)loads=topLoads(boxes);const squareMetre=16000000n*16000000n;
  return boxes.some((box,i)=>(BigInt(box.w)+loads[i])*squareMetre>BigInt(maxDensity)*BigInt(box.d[0])*BigInt(box.d[1]))}
function groundContactAllowed(candidate,placed,supports=null){const rule=candidate.item.groundRule;if(candidate.z===0||rule==null||rule==='free')return true;
  const box={x:candidate.x,y:candidate.y,z:candidate.z,d:placementDimensions(candidate)},supporters=supports??directSupporters(candidate,placed);
  if(rule==='single')return supporters.length===1;if(rule==='multiple')return supporters.length>=2;
  if(rule==='covered'){const corners=[[box.x,box.y],[box.x+box.d[0],box.y],[box.x,box.y+box.d[1]],[box.x+box.d[0],box.y+box.d[1]]];return corners.every(([x,y])=>supporters.some(({placement})=>{const d=placementDimensions(placement);return placement.x<=x&&x<=placement.x+d[0]&&placement.y<=y&&y<=placement.y+d[1]}))}return true}
function routeContactAllowed(candidate,placed,supports,sweep=null){
  // An item without a declared stop rides the whole route. Infinity is the shared
  // PHP/Python/Rust contract. Check only the new relations, as the existing scene was
  // already valid; the one same-column face above may need an O(n) predecessor lookup
  // to distinguish a real face support from a shadowed non-adjacent nested contact.
  const candidateStop=candidate.item.stopIndex??Infinity;
  // Every comparison below is `stop > Infinity` when nothing on the route declares a stop,
  // so the rule cannot refuse and the scan is skipped for the request that has no route at
  // all -- which is every request that is not a multi-drop route.
  if(sweep!==null&&candidateStop===Infinity&&!sweep.placedStops)return true;
  for(let index=0;index<supports.length;index++)if(candidateStop>(supports[index].placement.item.stopIndex??Infinity))return false;
  const dimensions=placementDimensions(candidate);let scene=null;
  if(sweep!==null){
    // A non-nesting candidate is never a nested predecessor, so only the placements whose
    // base is its top can rest on it: read that one bucket instead of the whole scene.
    if(candidate.item.nesting==null){const level=sweep.bottomPlane().get(candidate.z+dimensions[2]);
      if(level!==undefined)for(let index=0;index<level.length;index++){const upper=level[index];
        if(footprintOverlap(upper,candidate.x,candidate.y,dimensions[0],dimensions[1])>0&&(upper.item.stopIndex??Infinity)>candidateStop)return false}
      return true}
  }
  for(const upper of placed){const upperDimensions=placementDimensions(upper),upperStop=upper.item.stopIndex??Infinity;
    if(validNesting(candidate,upper)&&candidate.z<upper.z){if(upperStop>candidateStop)return false;continue}
    if(candidate.z+dimensions[2]!==upper.z||overlapXY({x:candidate.x,y:candidate.y,z:candidate.z,d:dimensions},{x:upper.x,y:upper.y,z:upper.z,d:upperDimensions})<=0)continue;
    if(sameNestingColumn(candidate,upper)){
      if(scene==null)scene=[...placed,candidate];
      if(!directSupporters(upper,scene).some(support=>support.placement===candidate))continue;
    }
    if(upperStop>candidateStop)return false;
  }
  return true}

/**
 * Decides whether one box may be added to a container.
 *
 * The fallback used to check only the container walls, obstacles, collisions and the
 * floor rule, and then reported `support_ratio: 1` and `top_load: 0` regardless. Every
 * physical rule the schema accepts is enforced here instead: a result that claims to
 * honour a rule it ignored is worse than no result at all.
 */
// `loadBase` is a thunk, not a graph: the caller knows the placed boxes cannot move for
// this item's whole candidate sweep, but most candidates never reach the load rules at
// all, and building a base none of them asks for would be pure cost. It yields null
// whenever the delta does not apply -- see `candidatesFor`.
// Dimensions reach this rule in two shapes and both are legitimate: the solver carries them
// as `[length, width, height]`, while a caller holding a request or a fixture carries the
// named object. `sweptVolume` reads the named form, and an array silently answers `3` for
// `.length` -- so normalising here is not tidiness. Before 's review this predicate
// returned the opposite verdict for the same scene depending on which shape it was handed,
// and nothing caught it because no request path supplies a direction list yet.
const namedDimensions=value=>Array.isArray(value)
  ?{length:value[0],width:value[1],height:value[2]}:value;
const innerDimensions=container=>namedDimensions(container.d!==undefined?container.d:container);
// Only position and envelope size matter to a corridor, so the box is built here rather than
// through `constraintBox`, which also carries load, nesting and item type -- none of which
// this rule reads, and all of which an embedder would have to supply to call it.
const corridorBox=p=>({x:p.x,y:p.y,z:p.z,d:namedDimensions(p.ed)});

/**
 * The corridors open in one immutable placement state.
 *
 * Built once per candidate sweep and reused by every candidate: the placed boxes cannot move
 * while one item is being placed, so the placed-versus-placed intersections give the same
 * answer every time. Construction is `O(m^2 * |D|)` and each candidate then costs
 * `O(m * |D|)`, matching what the Rust core does with the same state. Rebuilding per
 * candidate would make switching the doors on cost `O(m^2 * |D|)` for every candidate -- the
 * hoist exists so that wiring the field later does not also have to repair a hot loop.
 *
 * The base is keyed to one candidate stop, so it is valid for exactly one item's sweep.
 */
export function stopAccessibilityBase(candidateStop,placed,container,directions){
  const stop=candidateStop??Infinity,stops=placed.map(p=>p.item.stopIndex??Infinity);
  // No doors is the default on every request path, and one distinct stop means nothing is
  // due before anything else. Either way no corridor can be wrongly blocked. Checked over
  // the candidate too, or the first placement into an empty container would skip a check it
  // should make.
  if(!directions||directions.length===0||stops.every(each=>each===stop))
    return {inert:true,stop,stops,directions:[],inner:null,boxes:[],clear:[]};
  const inner=innerDimensions(container),boxes=placed.map(corridorBox);
  const clear=boxes.map((box,index)=>stops[index]===Infinity
    // Never unloaded, so it needs no door of its own -- it only ever blocks.
    ?[]
    :directions.map(direction=>sweptVolume(box,inner,direction))
      .filter(sweep=>!boxes.some((other,position)=>position!==index
        &&stops[position]>stops[index]&&sweptHits(sweep,other))));
  return {inert:false,stop,stops,directions:[...directions],inner,boxes,clear};
}

function accessibleAgainst(base,candidateBox){
  if(base.inert)return true;
  // Every already-placed item due before the candidate must keep a door the candidate does
  // not take.
  for(let index=0;index<base.clear.length;index++){
    if(base.stop<=base.stops[index])continue;
    if(!base.clear[index].length)continue;
    if(!base.clear[index].some(sweep=>!sweptHits(sweep,candidateBox)))return false;
  }
  // An item riding the whole route is never unloaded, so it needs no door of its own.
  if(base.stop===Infinity)return true;
  return base.directions.some(direction=>{
    const sweep=sweptVolume(candidateBox,base.inner,direction);
    return !base.boxes.some((other,index)=>base.stops[index]>base.stop&&sweptHits(sweep,other));
  });
}

// The horizontal half of route order: nothing due later may stand between an earlier item
// and a door. `routeContactAllowed` above enforces the vertical half -- nothing
// due later may rest *above* something due earlier. Both are necessary and neither implies
// the other; docs/STOP-ACCESSIBILITY.md derives the rule and the post-validator's
// whole-scene replay stays the sufficient check.
//
// Inert unless the container supplies exit directions. `container.access_directions` is
// canonicalised into `tmpl.doors` by the request decoder; omitting it preserves the
// pre-1.1.0 behaviour instead of pretending all six walls are doors. JavaScript has no
// separate programmatic configuration object, so the per-container request field is its
// only activation path.
//
// The blocker set is `{q : s(q) > s(p)}` -- strictly later. Same-stop items are excluded
// because the order within a stop is free: whichever is in the way comes off first.
//
// One implementation, not two: this builds the base and asks it, so the exported predicate
// and the solver's hot path cannot drift apart.
export function stopAccessible(candidate,placed,container,directions){
  return accessibleAgainst(
    stopAccessibilityBase(candidate.item.stopIndex,placed,container,directions),
    corridorBox(candidate));
}

// Half-open on every axis, matching the box intersection test, so a box flush against
// another's exit face is not standing in its way.
function sweptHits([sx1,sy1,sz1,sx2,sy2,sz2],box){
  return sx1<box.x+box.d.length&&box.x<sx2&&sy1<box.y+box.d.width&&box.y<sy2
    &&sz1<box.z+box.d.height&&box.z<sz2}

// A non-empty `accepts_stacking_groups` closes what may rest directly on an item;
// empty or absent leaves it open. Decoded once per item type into a Set, so a support edge
// costs one lookup. Names are only tested for membership, never ordered.
function acceptedStackingGroups(raw){const names=raw.accepts_stacking_groups;return names==null||names.length===0?null:new Set(names)}
// The code refusing `upper` resting directly on `lower`, or null. `non_stackable` is tested
// first, so a scene invalid before stacking groups existed keeps the code it reported.
function stackingRefusal(lower,upper){
  if(!lower.stackable)return 'non_stackable';
  if(lower.accepts!=null&&!lower.accepts.has(upper.stackingGroup))return 'stacking_group_incompatible';
  return null}
function refusesLoad(item){return !item.stackable||item.accepts!=null}
// Whether a column of this one item type passes every stacking edge: the lattice test.
function carriesItself(raw){const names=raw.accepts_stacking_groups;
  return raw.stackable!==false&&(names==null||names.length===0||names.includes(raw.stacking_group))}
// What one candidate sweep knows about its item and the placed scene before any position is
// tried. `allowed` used to rediscover each of these with its own pass over `placed` for every
// feasible candidate -- the tag conflict, four "does anything here declare X" gates and the
// supporter scan, on a scene that cannot change until the sweep commits -- which is where
// the profile put a fifth of the whole solve. Built once per (template, item) sweep, in
// O(n); the plane buckets are built on first demand because a floor candidate never asks.
// A caller without a sweep (the rebalance replay) builds one per call and loses nothing.
// Whether any tag in `wanted` is in `tags`: `some`/`includes` without a closure per call,
// which `sweepContext` would otherwise allocate for every placed item of every sweep.
// Scans of the placed scene a sweep makes once, written as loops so no closure is built per sweep.
function anyPlaced(placements,field){
  for(let index=0;index<placements.length;index++)if(placements[index].item[field]!=null)return true;
  return false
}
function anyCompressiblePlaced(placements){
  for(let index=0;index<placements.length;index++)if(placements[index].item.shapeType==='compressible')return true;
  return false
}
function sharesTag(wanted,tags){
  for(let index=0;index<wanted.length;index++)if(tags.includes(wanted[index]))return true;
  return false
}
function sweepContext(item,placed){
  const tags=item.tags,bad=item.incompatible;
  let tagConflict=false,anyRefusesLoad=false,placedMaxTop=false,placedCompressible=false,placedMaxStacked=false,placedStops=false;
  for(let index=0;index<placed.length;index++){const other=placed[index].item;
    if(sharesTag(bad,other.tags)||sharesTag(other.incompatible,tags))tagConflict=true;
    if(refusesLoad(other))anyRefusesLoad=true;
    if(other.maxTop!=null)placedMaxTop=true;
    if(other.maxCompressionKpa!=null)placedCompressible=true;
    if(other.maxStacked!=null)placedMaxStacked=true;
    if(other.stopIndex!=null)placedStops=true}
  let byTop=null,byBottom=null;
  return {tagConflict,anyRefusesLoad,placedMaxTop,placedCompressible,placedMaxStacked,placedStops,
    // Buckets keep `placed` order, which is the order every supporter list is contracted to.
    topPlane(){if(byTop===null)byTop=bucketByPlane(placed,p=>p.z+placementDimensions(p)[2]);return byTop},
    bottomPlane(){if(byBottom===null)byBottom=bucketByPlane(placed,p=>p.z);return byBottom}}}
function bucketByPlane(placed,planeOf){const buckets=new Map();
  for(let index=0;index<placed.length;index++){const p=placed[index],plane=planeOf(p),bucket=buckets.get(plane);if(bucket)bucket.push(p);else buckets.set(plane,[p])}
  return buckets}
function allowed(candidate,placed,container,globalSupportPpm,metrics,loadBase=null,accessBase=null,sweep=null){
  const box={x:candidate.x,y:candidate.y,z:candidate.z,d:candidate.ed};
  if(candidate.item.raw.must_be_on_floor&&box.z!==0)return false;
  const scene=sweep??sweepContext(candidate.item,placed);
  if(scene.tagConflict)return false;
  // Face-to-face contact can only refuse when one of the pair declines to carry, and the
  // nesting rule only when the candidate nests. A non-nesting candidate consults the two
  // planes it can touch; anything else walks the scene exactly as before.
  if(candidate.item.nesting!=null||sweep===null){if(scene.anyRefusesLoad||refusesLoad(candidate.item)||candidate.item.nesting!=null)for(const p of placed){
    const other={x:p.x,y:p.y,z:p.z,d:p.ed};
    if(overlapXY(other,box)<=0)continue;
    if(other.z+other.d[2]===box.z&&stackingRefusal(p.item,candidate.item)!==null)return false;
    // Sliding underneath is a stacking decision too: nothing may go below an item so
    // that the item comes to rest on a box that refuses to carry it.
    if(other.z===box.z+box.d[2]&&stackingRefusal(candidate.item,p.item)!==null)return false;
    if(validNesting(candidate,p)){
      const [lower,upper]=candidate.z<=p.z?[candidate,p]:[p,candidate];
      if(stackingRefusal(lower.item,upper.item)!==null)return false;
    }
  }}else{
    if(scene.anyRefusesLoad){const level=sweep.topPlane().get(box.z);
      if(level!==undefined)for(let index=0;index<level.length;index++){const p=level[index];if(stackingRefusal(p.item,candidate.item)!==null&&footprintOverlap(p,box.x,box.y,box.d[0],box.d[1])>0)return false}}
    if(refusesLoad(candidate.item)){const level=sweep.bottomPlane().get(box.z+box.d[2]);
      if(level!==undefined)for(let index=0;index<level.length;index++){const p=level[index];if(stackingRefusal(candidate.item,p.item)!==null&&footprintOverlap(p,box.x,box.y,box.d[0],box.d[1])>0)return false}}
  }
  metrics.support_checks++;
  const ratio=Math.max(globalSupportPpm,candidate.item.supportPpm);
  const supports=box.z===0?NO_SUPPORTERS:directSupporters(candidate,placed,sweep===null?null:sweep.topPlane());
  for(let index=0;index<supports.length;index++)if(stackingRefusal(supports[index].placement.item,candidate.item)!==null)return false;
  if(box.z!==0&&ratio>0){
    const area=supports.reduce((total,support)=>total+support.area,0);
    if(area<requiredArea(box.d[0]*box.d[1],ratio))return false;
  }
  // constraintBox mirrors item.maxTop/maxStacked verbatim, so both gates are
  // decidable from the items alone; when neither fires, the three skipped checks
  // return false for every box anyway, and building n+1 boxes per feasible
  // candidate was pure allocation.
  const needsLoads=container.maxStackDensity!=null||candidate.item.maxTop!=null||scene.placedMaxTop
    ||candidate.item.maxCompressionKpa!=null||scene.placedCompressible;
  const needsGraph=needsLoads||candidate.item.maxStacked!=null||scene.placedMaxStacked;
  if(!needsGraph)return groundContactAllowed(candidate,placed,supports)&&routeContactAllowed(candidate,placed,supports,scene)
    &&(accessBase===null||accessBase.inert||accessibleAgainst(accessBase,corridorBox(candidate)));
  // With a base for this sweep, both the box list and the graph come from it by
  // appending one box, rather than each candidate rebuilding both from every placement.
  // The two paths are required to agree exactly, which is what `contact-graph`'s append
  // property test holds them to.
  const candidateBox=constraintBox(candidate),base=loadBase===null?null:loadBase();
  const boxes=base===null?[...placed.map(constraintBox),candidateBox]:[...base.graph.boxes,candidateBox];
  const graph=base===null?contactGraph(boxes):appendContactBox(base.graph,candidateBox,overlapXY);
  const loads=!needsLoads?null:base===null?topLoads(boxes,graph):topLoads(boxes,graph,settleOrderWith(base.order,boxes));
  return !overloaded(boxes,loads)&&!crushed(boxes,loads)&&!stackLimitsExceeded(boxes,graph)&&!stackDensityExceeded(boxes,container.maxStackDensity,loads)
    &&groundContactAllowed(candidate,placed,supports)&&routeContactAllowed(candidate,placed,supports,scene)
    &&(accessBase===null||accessBase.inert||accessibleAgainst(accessBase,corridorBox(candidate)));
}

// `topPlane` is `placed` bucketed by top face, as a sweep holds it; a caller reading every
// placement of one container builds it once, so the writer is O(p + supporters), not O(p^2).
/** The supported share of a placement's base as the exact [area, base area]; a floor placement is whole. */
function supportFraction(placement,placed,topPlane=null){
  if(placement.z===0)return [1,1];
  const dimensions=placementDimensions(placement),area=directSupporters(placement,placed,topPlane).reduce((total,support)=>total+support.area,0);
  return [area,dimensions[0]*dimensions[1]];
}
function supportRatioOf(placement,placed,topPlane=null){const [area,base]=supportFraction(placement,placed,topPlane);return area/base}

// The leading `maximum_volume` key: the share of the requested nominal item volume left
// unpacked, in parts per million. Rounded up so an incomplete answer never scores zero,
// and a ratio rather than the raw volume because cubic ticks pass 2^53 for an ordinary
// container -- which is also why both operands arrive as BigInt.
function unpackedVolumePpm(unpackedVolume,requestedVolume){return requestedVolume>0n?Number((unpackedVolume*1000000n+requestedVolume-1n)/requestedVolume):0}
/** Two id lists in Python's tuple order: element by element in code points, a prefix first.
 *  Joining them with a separator is not that order, and lets two lists compare equal (S18). */
function compareIdLists(left,right){
  for(let i=0;i<Math.min(left.length,right.length);i++){const difference=compareCodePoints(left[i],right[i]);if(difference)return difference}
  return left.length-right.length;
}
/** A container plan's dominance key -- its remaining instances and its inventory -- spelt as JSON,
 *  so no id, whatever it contains, can make two different plans share one (S18). */
function planSignature(plan){
  const inventory=[...plan.inventory.entries()].sort(([left],[right])=>compareCodePoints(left,right));
  return JSON.stringify([plan.remaining.map(i=>i.id),inventory]);
}
function compareScore(left,right){for(let i=0;i<Math.max(left.length,right.length);i++){const difference=(left[i]??0)-(right[i]??0);if(difference!==0)return difference}return 0}

function uniqueRotations(dimensions,rotations){
  const seen=new Set(),choices=[];
  for(const rotation of rotations){
    const physical=rotate(dimensions,rotation),key=physical.join(':');
    if(!seen.has(key)){seen.add(key);choices.push([rotation,physical])}
  }
  return choices
}

function latticeCentreOfMassOffsetPpm(summary,inner){
  if(summary.weight===0||summary.count===0)return 0;
  const perLayer=summary.nx*summary.ny,fullLayers=Math.floor(summary.count/perLayer),remainder=summary.count%perLayer;
  const rows=Math.floor(remainder/summary.nx),columns=remainder%summary.nx,triangular=n=>BigInt(n)*BigInt(n-1)/2n;
  const sumX=BigInt(fullLayers*summary.ny+rows)*triangular(summary.nx)+triangular(columns);
  const sumY=BigInt(fullLayers*summary.nx)*triangular(summary.ny)+BigInt(summary.nx)*triangular(rows)+BigInt(columns*rows);
  const count=BigInt(summary.count),weight=BigInt(summary.weight),clearance=BigInt(summary.clearance);
  const doubledX=weight*(2n*BigInt(summary.envelope[0])*sumX+count*(2n*clearance+BigInt(summary.physical[0])));
  const doubledY=weight*(2n*BigInt(summary.envelope[1])*sumY+count*(2n*clearance+BigInt(summary.physical[1])));
  const total=weight*count,x=BigInt(inner[0]),y=BigInt(inner[1]);
  const offsetX=(doubledX-total*x)<0n?total*x-doubledX:doubledX-total*x;
  const offsetY=(doubledY-total*y)<0n?total*y-doubledY:doubledY-total*y;
  return Number((offsetX*1000000n/(total*x))>(offsetY*1000000n/(total*y))?offsetX*1000000n/(total*x):offsetY*1000000n/(total*y))
}

/**
 * O(c*r) regular-lattice fast path, where c is the number of container templates
 * actually consumed and r <= 6 is the number of physical rotations. The returned
 * result is O(c), independent of item quantity: per-instance coordinates are encoded
 * by `lattice_summary` and can be reconstructed on demand.
 */
/** Lexicographic ordering over equal-length ranking keys. Entries compare pairwise, so
 * a key may mix numbers and strings as long as each position is consistent. */
function lessThan(left,right){
  for(let i=0;i<left.length;i++){
    if(left[i]<right[i])return true;
    if(left[i]>right[i])return false;
  }
  return false
}

/**
 * Reject an item the contract does not admit.
 *
 * Called once per declared item type before any solver runs, so both the general search
 * and the compact lattice path admit exactly the same requests. Keeping this inside the
 * general path's own item-building loop is what let the two disagree.
 */
function admitItem(raw,u){
  if(!Number.isSafeInteger(raw.quantity??1)||(raw.quantity??1)<1)throw new RangeError('item quantity must be positive');
  if(!isUnitRatio(raw.minimum_support_ratio??0))throw new RangeError('minimum_support_ratio must be between 0 and 1');
  const d=dims(raw.dimensions,u),nesting=raw.nesting_height==null?null:scalar(raw.nesting_height,u,LEN);
  if(nesting!=null&&(nesting<0||nesting>=d[2]))throw new RangeError("nesting_height must be at least zero and strictly less than the item's own height");
  if(raw.max_stacked_items!=null&&(!Number.isSafeInteger(raw.max_stacked_items)||raw.max_stacked_items<1))throw new RangeError('max_stacked_items must be a positive safe integer');
  if(raw.stop_index!=null&&(!Number.isSafeInteger(raw.stop_index)||raw.stop_index<0))throw new RangeError('stop_index must be a non-negative safe integer');
  if(raw.value!=null&&(!Number.isSafeInteger(raw.value)||raw.value<0))throw new RangeError('value must be a non-negative safe integer');
  if(raw.ground_contact_rule!=null&&!['free','covered','single','multiple'].includes(raw.ground_contact_rule))throw new RangeError('ground_contact_rule must be free, covered, single or multiple');
  // The shape rules belong here for the reason this function exists: the compact lattice path
  // never builds an `items` entry, so an admission living only in the general path's item loop
  // would let the two disagree about which requests are legal.
  parseShape(raw,d,u,nesting);
  if(raw.eligible_container_tags!=null&&(!Array.isArray(raw.eligible_container_tags)||raw.eligible_container_tags.some(tag=>typeof tag!=='string')))throw new TypeError('eligible_container_tags must be an array of strings');
}

const isUnitRatio=value=>value>=0&&value<=1;
const isAtLeast=(value,floor)=>Number.isSafeInteger(value)&&value>=floor;

/**
 * Reject a container the contract does not admit, before either solver path runs -- the
 * compact lattice path returns before container templates are built (see `admitItem`).
 */
function admitContainer(raw){
  if(raw.quantity!=null&&!isAtLeast(raw.quantity,1))throw new RangeError('container quantity must be positive');
  if(raw.max_items!=null&&!isAtLeast(raw.max_items,1))throw new RangeError('container max_items must be at least 1');
  if(raw.cost_minor!=null&&!isAtLeast(raw.cost_minor,0))throw new RangeError('container cost cannot be negative');
  if(raw.void_fill_reserve_ratio!=null&&(typeof raw.void_fill_reserve_ratio!=='number'||!Number.isFinite(raw.void_fill_reserve_ratio)))throw new TypeError('void_fill_reserve_ratio must be a finite number');
  if(!isUnitRatio(raw.void_fill_reserve_ratio??0))throw new RangeError('void_fill_reserve_ratio must be between 0 and 1');
}

/** Reject configuration limits below the floors the reference engine enforces. */
function admitConfiguration(cfg){
  for(const name of ['time_limit_ms','alternatives','exact_item_limit'])
    if(cfg[name]!=null&&!isAtLeast(cfg[name],1))throw new RangeError('positive configuration values required');
  if(cfg.max_containers!=null&&!isAtLeast(cfg.max_containers,1))throw new RangeError('max_containers must be at least 1');
  if(cfg.max_candidate_points!=null&&!isAtLeast(cfg.max_candidate_points,MIN_CANDIDATE_POINTS))throw new RangeError(`max_candidate_points must be at least ${MIN_CANDIDATE_POINTS}`);
  if(!isUnitRatio(cfg.minimum_support_ratio??0))throw new RangeError('minimum_support_ratio must be between 0 and 1');
}

/**
 * The `count` placements of one regular lattice, in fill order (x fastest, then y, then
 * layer).
 *
 * Every quantity here is closed-form, and that is the point rather than an optimisation
 * detail: the general path derives support by scanning the placements already made and
 * top load by walking the support graph, both `O(n)` per placement, which is exactly the
 * `O(n^2)` this path exists to avoid. In a lattice neither scan can tell you anything you
 * do not already know -- every cell has identical footprint, so an item is either on the
 * floor or fully seated on the one below it, and the load above it is however many items
 * of its own column were actually placed.
 */
function latticePlacements({best,count,firstIndex,raw,weight,clear,ou,ow}){
  const perLayer=best.nx*best.ny,placements=[];
  for(let index=0;index<count;index++){
    const ix=index%best.nx,iy=Math.floor(index/best.nx)%best.ny,iz=Math.floor(index/perLayer);
    // Items strictly above this one in its own column, counting only those the container
    // actually received -- the last layer is partial whenever count is not a multiple of
    // perLayer, and charging this item for cells nobody filled would overstate the load.
    const above=Math.floor((count-1-index)/perLayer);
    placements.push({
      item_id:`${raw.id}#${firstIndex+index}`,item_type:raw.id,
      position:outPoint({x:ix*best.envelope[0]+clear,y:iy*best.envelope[1]+clear,z:iz*best.envelope[2]+clear},ou),
      dimensions:outDims(best.physical,ou),orientation:best.rotation,
      support_ratio:(1).toFixed(6),top_load:outWeight(BigInt(above)*BigInt(weight),ow),
    })
  }
  return placements
}

// Any `fixed_placements` but an empty list stands the closed-form path down; a malformed one
// goes on to admission, which refuses it, rather than being answered as if it were absent.
const hasFixedPlacements=req=>Array.isArray(req.fixed_placements)?req.fixed_placements.length>0:req.fixed_placements!=null;
function compactGridResult(req,{u,ou,ow,clear,objective,dimensionalWeight,solverAlias,metrics,effortExceeded,effortRemaining,deadline}){
  // Keep this path opt-in until its capacity-first container choice is
  // proven objective-equivalent to the general path. Admission, effort accounting,
  // injected deadlines and metrics now have direct parity tests; objective quality is
  // the only reason not to use it for coordinate-bearing requests. Materialising the
  // retained lattice in `latticePlacements` is O(count), while compact output remains
  // O(c*r) and keeps regression-many-container-types below the scaling budget.
  const wantCoordinates=req.configuration?.require_placement_coordinates!==false;
  // A container holding fixed items is not an empty box, and this path places every item of
  // the request by formula; it stands down for the whole request, as it does for obstacles.
  if((solverAlias!=null&&solverAlias!=='grid')||req.items?.length!==1||hasFixedPlacements(req))return null;
  const raw=req.items[0],quantity=raw.quantity??1;
  if(!Number.isSafeInteger(quantity)||quantity<1||raw.group!=null||(raw.tags??[]).length||(raw.incompatible_tags??[]).length
    ||(raw.eligible_container_tags??[]).length||raw.max_stacked_items!=null||raw.nesting_height!=null
    // The lattice is closed-form over boxes: it counts cells from envelope extents and reports
    // volume from its own summary. It can see neither a hull -- it would tile bounding boxes
    // and call the result exact -- nor pressure, so a compressible column would be sized
    // without ever asking whether its base survives, and reported uncompressed. The general
    // search checks both per candidate.
    ||(raw.shape_type!=null&&raw.shape_type!=='rigid_cuboid')
    ||!['free',null,undefined].includes(raw.ground_contact_rule))return null;
  const itemDimensions=dims(raw.dimensions,u),weight=scalar(raw.weight??0,'g',WT);
  const rotations=raw.allowed_rotations??(raw.keep_upright?['LWH','WLH']:Object.keys(ROT));
  if(!Array.isArray(rotations)||rotations.some(rotation=>ROT[rotation]===undefined))return null;
  const templates=[];
  for(const container of req.containers??[]){
    if((container.obstacles??[]).length||container.axles!=null||(container.void_fill_reserve_ratio??0)>0
      ||Object.keys(container.tag_limits??{}).length||container.max_stack_density!=null
      // The lattice counts cells against the rigid frame alone; a bag's girth rule couples
      // the axes, which the per-candidate check applies exactly.
      ||container.deformable_boundary!=null
      // A lattice sized against the machine maximum describes no box cut to measure (D12).
      ||container.made_to_measure!=null)return null;
    const inner=dims(container.inner_dimensions,u),outer=container.outer_dimensions?dims(container.outer_dimensions,u):inner;
    templates.push({...container,d:inner,outerD:outer,max:container.max_payload==null?null:scalar(container.max_payload,'g',WT),
      tare:scalar(container.tare_weight??0,'g',WT),rate:parseRateTable(container.rate_table)})
  }
  // `lowest_landed_cost` never reaches this path: packFallback forces `compact=null`
  // for that objective (see the exclusion beside the policy-rule gate), because this
  // path commits to one container from the billed-weight proxy with no priced
  // alternative to correct it. The branch below is kept only so the key stays whole for
  // `shipping_cost`, whose proxy it is; re-enabling compact for landed cost would
  // resurrect the MAX_SAFE_INTEGER leak, since this return path has no refusal.
  templates.sort((a,b)=>objective==='shipping_cost'||objective==='lowest_landed_cost'
    ?dimensionalWeight(a.outerD)-dimensionalWeight(b.outerD)||(a.cost_minor??0)-(b.cost_minor??0)||Number(volume(a.d)-volume(b.d))
    :(a.cost_minor??0)-(b.cost_minor??0)||Number(volume(a.d)-volume(b.d)));
  let remaining=quantity,scoreCost=0,scoreUnused=0,scoreHeight=0,scoreBillable=0,scoreLanded=0,scoreAchievedHeight=0;
  const containers=[],maxContainers=req.configuration?.max_containers??Infinity;
  // Per-unit capacity depends only on (item, template), both fixed for the
  // whole solve, so it is computed once per template rather than recomputed on
  // every copy opened. Picking greedily by capacity each round -- instead of
  // exhausting one (cost, volume)-cheapest template's entire inventory before a
  // roomier template is ever tried -- is what stops this from opening ten
  // single-item containers of the cheapest template when one larger template
  // would have held them all.
  // Whether the item's own geometry ever fits a container, before any payload,
  // max_items or stacking cap is applied. Zero capacity has several causes and they are
  // different answers to a caller: a crate too big for every box is a proven dimensional
  // rejection, while one that fits but is too heavy is a payload rejection. Collapsing
  // them lost that distinction, and the independent validator caught it.
  let dimensionsFitSomewhere=false;
  const plans=templates.map(template=>{
    let best=null;
    for(const [rotation,physical] of uniqueRotations(itemDimensions,rotations)){
      const envelope=physical.map(edge=>edge+2*clear),nx=Math.floor(template.d[0]/envelope[0]),ny=Math.floor(template.d[1]/envelope[1]);
      let nz=Math.floor(template.d[2]/envelope[2]);
      if(nx>0&&ny>0&&nz>0)dimensionsFitSomewhere=true;
      // Every lattice edge joins two items of this one type, so the stacking-group rule
      // holds for the whole lattice exactly when the type carries itself.
      if(raw.must_be_on_floor||!carriesItself(raw))nz=Math.min(nz,1);
      if(raw.max_top_load!=null&&weight>0){
        const safeLayers=BigInt(scalar(raw.max_top_load,'g',WT))/BigInt(weight)+1n;
        if(safeLayers<BigInt(nz))nz=Number(safeLayers)
      }
      let capacity=Math.min(Number.MAX_SAFE_INTEGER,nx*ny*nz);
      if(template.max_items!=null)capacity=Math.min(capacity,template.max_items);
      if(template.max!=null&&weight>0)capacity=Math.min(capacity,Math.floor(template.max/weight));
      // Among rotations that hold the same number, prefer the one that needs
      // fewer layers for the items actually being placed -- a lower centre of load is
      // the objective's fifth key, and ranking rotations by capacity alone left it to
      // chance, stacking higher than the general path on 21 fixtures (caught by the
      // native quality budget). Layers for the real count, not footprint area in the
      // abstract: with one item every rotation needs one layer, so this ties and the
      // declared orientation survives instead of the item being rotated for nothing.
      // Capacity counts only up to what is actually being placed. A rotation that could
      // hold thirty when eight remain is not better than one that holds eight -- the
      // surplus buys nothing and, when it is bought by stacking, costs the objective's
      // fifth key. Ranking by raw capacity made that trade invisibly and stacked higher
      // than the general path on 21 fixtures.
      // Then the stack top itself, which is what the objective's fifth key measures.
      // Without it the tie fell through to the rotation *name*: on gen-max-top-load-01
      // a 50x50x30 crate ties on capacity and layers, and 'HLW' sorts before 'LWH', so
      // the 50 mm edge stood vertical and the load sat higher than the same items laid
      // on their 30 mm side. Alphabetical order is not a packing preference.
      // Rank by the stack *top*, not the layer count. They disagree, and the objective
      // measures the top: a 950x1510x2300 crate in a 2690-high container fits sixteen
      // per box either as one layer standing 2300 tall or as two layers of eight lying
      // 950 tall. Fewer layers looks tidier and is worse -- 2300 against 1900 -- and
      // ranking by layer count chose it, costing 1710036 where the general path scored
      // 1059478 (caught by the native quality budget on
      // regression-multi-container-quantity-threshold).
      const useful=Math.min(capacity,quantity);
      const layers=nx*ny>0?Math.ceil(useful/(nx*ny)):0;
      const key=[-useful,layers*envelope[2],Number(volume(envelope)),rotation];
      // Lexicographic over the whole key, including the rotation name as the final
      // tie-break: a hand-rolled chain that stopped at the third element left the last
      // one to iteration order, which is deterministic but says so nowhere.
      if(best==null||lessThan(key,best.key))best={key,rotation,physical,envelope,nx,ny,nz,capacity}
    }
    return {template,best,opened:0,available:template.quantity??Infinity};
  }).filter(plan=>plan.best!=null&&plan.best.capacity>0);
  // The deadline is honoured here for the same reason it is in the general
  // path, even though this one is closed-form and fast: an already-expired injected
  // clock must produce a time_limit answer rather than a complete one, and a caller
  // cannot tell which path served the request.
  let timeLimitReached=deadline!=null&&deadline.expired();
  while(remaining>0&&containers.length<maxContainers&&!effortExceeded()&&!timeLimitReached){
    // Rank templates by what the objective actually rewards, not by raw
    // capacity. Capacity-first reads as "the biggest container wins", which minimises
    // container count and then stops caring -- on regression-many-container-types it
    // chose a box left half empty, scoring 500000 on unused volume where Python scored
    // 23437. The objective is lexicographic (unpacked, containers, cost, unused
    // volume, stack height), so the closed-form stand-in for it is: how many copies of
    // this template would finish the remaining items, then cost, then how much of the
    // one being opened is left empty, then how high it stacks. Every term is already
    // computed per template, so this is a comparator change, not new work per round.
    const rank=plan=>{
      const capacity=plan.best.capacity,count=Math.min(capacity,remaining);
      const inner=volume(plan.template.d),used=volume(plan.best.physical)*BigInt(count);
      const unusedPpm=inner>0n?Number((inner-used)*1000000n/inner):0;
      const layers=Math.ceil(count/(plan.best.nx*plan.best.ny));
      const heightPpm=plan.template.d[2]>0
        ?Number(BigInt(layers*plan.best.envelope[2])*1000000n/BigInt(plan.template.d[2])):0;
      // `-count` is the *last* discriminator, after every key the objective itself
      // ranks by. Placed any earlier it re-created the defect this ranking exists to
      // remove: ahead of unused volume and height it chose a taller stack on
      // regression-multi-container-quantity-threshold. Last, it only settles ties the
      // objective is indifferent to -- ten unit cubes against boxes holding 1..7 tie on
      // containers, cost, unused volume and height, and template order took the box
      // holding five, leaving a remainder of five no box fits exactly. Packing more when
      // nothing else distinguishes the choice cannot leave a worse remainder.
      return [Math.ceil(remaining/capacity),plan.template.cost_minor??0,unusedPpm,heightPpm,
        -count,templates.indexOf(plan.template)];
    };
    const plan=plans.filter(p=>p.opened<p.available).map(p=>({p,key:rank(p)}))
      .sort((a,b)=>{for(let i=0;i<a.key.length;i++)if(a.key[i]!==b.key[i])return a.key[i]-b.key[i];return 0})
      .map(entry=>entry.p)[0];
    if(plan==null)break;
    plan.opened++;
    const template=plan.template,best=plan.best;
    {
      // A compact result represents each placement without iterating over it, but each
      // placement still consumes the same three public effort counters as the general
      // path. Bound the closed-form batch by the smallest remaining allowance so this
      // optimisation cannot jump across a caller's exact deterministic limit.
      const count=Math.min(best.capacity,remaining,effortRemaining());
      if(count<=0)break;
      const layers=Math.ceil(count/(best.nx*best.ny));
      const summary={...best,count,weight,clearance:clear};
      const used=volume(best.physical)*BigInt(count),payload=weight*count;
      const firstIndex=quantity-remaining+1;
      remaining-=count;metrics.search_nodes_expanded+=count;
      metrics.candidate_points_considered+=count;metrics.orientations_considered+=count;metrics.feasible_candidates+=count;
      containers.push({
        id:`${template.id}#${plan.opened}`,container_type:template.id,inner_dimensions:outDims(template.d,ou),
        outer_dimensions:outDims(template.outerD,ou),payload_weight:outWeight(payload,ow),
        gross_weight:outWeight(payload+template.tare,ow),used_volume_ticks3:used.toString(),
        volume_utilization:sixPlaces(used,volume(template.d)),
        centre_of_mass_offset_ppm:latticeCentreOfMassOffsetPpm(summary,template.d),
        void_fill_reserve_ticks3:'0',
        placements:wantCoordinates?latticePlacements({best,count,firstIndex,raw,weight,clear,ou,ow}):[],
        ...(wantCoordinates?{}:{lattice_summary:{
          item_type:raw.id,orientation:best.rotation,physical_dimensions:outDims(best.physical,ou),
          envelope_dimensions:outDims(best.envelope,ou),nx:best.nx,ny:best.ny,layers_used:layers,
          layer_step:outLength(best.envelope[2],ou),count,
        }}),
      });
      scoreCost+=template.cost_minor??0;
      const inner=volume(template.d);if(inner>0n)scoreUnused+=Number((inner-used)*1000000n/inner);
      if(template.d[2]>0)scoreHeight+=Number(BigInt(layers*best.envelope[2])*1000000n/BigInt(template.d[2]));
      scoreAchievedHeight+=layers*best.envelope[2];
      // `lowest_landed_cost` cannot reach this path (packFallback excludes compact for
      // it); if it ever could again, `addLanded`'s UNPRICEABLE sentinel would flow into
      // `score` unrefused -- this return path never checks the finished answer against
      // the tariff the way the outermost general-path frame does.
      if(objective==='shipping_cost'||objective==='lowest_landed_cost'){
        const billed=Math.max(payload+template.tare,dimensionalWeight(template.outerD));
        if(objective==='shipping_cost')scoreBillable+=billed;else scoreLanded=addLanded(scoreLanded,template,billed);
      }
    }
    if(deadline!=null&&deadline.expired())timeLimitReached=true;
    if(remaining===0||containers.length>=maxContainers)break
  }
  // Same reason vocabulary and precedence the general path uses: an item left behind
  // because the clock or the effort budget ran out did not fail to fit, and reporting it
  // as exhausted inventory would send a caller looking for a container that was never
  // the problem.
  const effortLimitReached=effortExceeded();
  // An item no template can hold under any permitted rotation did not run out of
  // inventory -- there was never a container for it. `plans` drops every zero-capacity
  // template before the loop starts, so an empty `plans` with nothing opened is exactly
  // that case, and reporting it as exhausted inventory would send a caller looking for
  // more of a container that could never have worked. Same code and proof level the
  // general path uses.
  // Only a genuine dimensional rejection claims that code. Anything else that leaves
  // `plans` empty -- a payload or max_items cap driving capacity to zero -- is not
  // something the caller fixes by finding a bigger box, and this path has no evidence to
  // name the real cause, so it falls back to the general path rather than guessing.
  // `rotation_restricted` and `no_compatible_container_dimensions` are different claims
  // and the validator checks which one holds: the first says the item would have fitted
  // had its own `allowed_rotations` not forbidden the orientation that works, the second
  // says no orientation fits at all. Deciding between them needs the unrestricted set,
  // so it is computed here rather than guessed from the restricted pass above.
  const fitsUnrestricted=(()=>{
    for(const template of templates)
      for(const [,physical] of uniqueRotations(itemDimensions,Object.keys(ROT))){
        const envelope=physical.map(edge=>edge+2*clear);
        if(template.d[0]>=envelope[0]&&template.d[1]>=envelope[1]&&template.d[2]>=envelope[2])return true;
      }
    return false;
  })();
  const nothingPlaceable=plans.length===0&&containers.length===0;
  // Only a proven dimensional rejection claims that code. A payload or max_items cap
  // driving capacity to zero is not something a caller fixes with a bigger box, and this
  // path has no evidence to name the real cause, so it defers to the general path.
  const noCompatibleContainer=nothingPlaceable&&!dimensionsFitSomewhere&&!fitsUnrestricted;
  const rotationRestricted=nothingPlaceable&&!dimensionsFitSomewhere&&fitsUnrestricted;
  if(nothingPlaceable&&dimensionsFitSomewhere)return null;
  const unpacked=[];for(let index=quantity-remaining+1;index<=quantity;index++){
    const reason=timeLimitReached?'time_limit':effortLimitReached?'effort_limit'
      :noCompatibleContainer?'no_compatible_container_dimensions':rotationRestricted?'rotation_restricted':'container_inventory_exhausted',details=[];
    unpacked.push({item_id:`${raw.id}#${index}`,item_type:raw.id,reason,details,proof:proofForReason(reason,details)})
  }
  const complete=remaining===0,solverName=solverAlias?`${solverAlias}:javascript_fallback`:'javascript_fallback';
  const truncated=timeLimitReached||effortLimitReached;
  const starts=[{id:solverName,started:true,completed:!truncated,truncated,selected:true,global_deadline_reached:timeLimitReached}],termination=aggregateTermination(starts);
  if(effortLimitReached&&!timeLimitReached)termination.code='effort_limit';
  const defaultScore=[remaining,containers.length,scoreCost,scoreUnused,scoreHeight];
  const score=objective==='lowest_cost'?[defaultScore[0],defaultScore[2],defaultScore[1],defaultScore[3],defaultScore[4]]
    :objective==='shipping_cost'?[defaultScore[0],scoreBillable,defaultScore[1],defaultScore[3],defaultScore[4]]
      :objective==='lowest_landed_cost'?[defaultScore[0],scoreLanded,defaultScore[1],defaultScore[3],defaultScore[4]]
      :objective==='open_dimension_height'?[defaultScore[0],scoreAchievedHeight,defaultScore[1],defaultScore[2],defaultScore[3]]
        :objective==='maximum_value'?[defaultScore[0],remaining*(raw.value??0),defaultScore[1],defaultScore[2],defaultScore[3]]
          // One item type, so the most pieces is also the most volume and the lattice needs
          // no second search; only the vector it reports differs.
          :objective==='maximum_volume'?[unpackedVolumePpm(BigInt(remaining)*volume(itemDimensions),BigInt(quantity)*volume(itemDimensions)),defaultScore[0],defaultScore[1],defaultScore[2],defaultScore[3]]:defaultScore;
  return {status:complete?'feasible':timeLimitReached?'time_limit':'best_found',feasibility:{code:complete?'feasible':'unknown'},termination,
    optimality:{code:complete?'not_proven':'best_found'},complete,objective,
    algorithm:{profile:req.configuration?.solver_profile??'balanced',solver:solverName,duration_ms:0,seed:req.configuration?.seed??42,
      time_limit_reached:timeLimitReached,effort_limit_reached:effortLimitReached,candidates_evaluated:metrics.feasible_candidates,
      placements_attempted:metrics.orientations_considered,metrics},
    summary:{container_count:containers.length,packed_item_count:quantity-remaining,unpacked_item_count:remaining},
    score,containers,unpacked_items:unpacked,catalog_versions_used:catalogVersionsUsed(req.catalog_versions_used),
    warnings:['JavaScript fallback is active; build the Rust addon for the native portfolio'],alternatives:[]}
}

// Fisher-Yates driven by a 32-bit xorshift, so a start's ordering is a pure function of
// the request's own `seed` and the start index -- no wall clock, no Math.random.
const ORDER_INSENSITIVE_SOLVERS=new Set(['grid','layer','homogeneous_blocks']);
function seededOrder(items,seed,startIndex){
  const ordered=items.slice();
  let state=(seed^(startIndex*0x9e3779b1))>>>0||0x9e3779b1;
  const next=()=>{state^=state<<13;state>>>=0;state^=state>>>17;state^=state<<5;state>>>=0;return state};
  for(let i=ordered.length-1;i>0;i--){const j=next()%(i+1);[ordered[i],ordered[j]]=[ordered[j],ordered[i]]}
  return ordered
}
// A portfolio's reported effort is what the whole portfolio spent, not what its winner
// spent. Each run here is a separate `packFallback` call with its own metrics closure, so
// without this the record understates the work by the number of runs.
// The counters each effort limit caps, as `effortExceeded` reads them.
const EFFORT_COUNTERS=[['max_search_nodes','search_nodes_expanded'],['max_candidates_evaluated','feasible_candidates'],['max_placement_attempts','orientations_considered']];
/** What the request's effort budget leaves after `runs`; a spent limit is 0.
 *
 *  The budget belongs to the request, not to each start: Python, PHP and Rust share it across
 *  the portfolio, so a later start gets only what the earlier ones left, and one left with
 *  nothing still starts and stops at its first counted step, as in Python. Each start used to
 *  get the whole budget, which went unseen while `balanced` ran one ordering. O(r). */
function remainingEffort(effort,runs){
  const left={...effort};
  for(const [limit,counter] of EFFORT_COUNTERS)
    if(effort[limit]!=null)left[limit]=Math.max(0,effort[limit]-runs.reduce((total,run)=>total+run.algorithm.metrics[counter],0));
  return left
}
const withEffort=(request,effort)=>effort==null?request:{...request,configuration:{...(request.configuration??{}),effort_budget:effort}};
function withPortfolioEffort(winner,runs){
  const metrics={};
  for(const key of Object.keys(winner.algorithm.metrics))
    metrics[key]=runs.reduce((total,run)=>total+run.algorithm.metrics[key],0);
  return {...winner.algorithm,metrics,
    candidates_evaluated:runs.reduce((total,run)=>total+run.algorithm.candidates_evaluated,0),
    placements_attempted:runs.reduce((total,run)=>total+run.algorithm.placements_attempted,0)}
}
// What a start adds to its solver's name: nothing for the first ordering, its index for a
// later one, and the swapped position for a neighbour run in a start a repeat freed.
function startSuffix(index,swapAt=null){
  return (index===0?'':`:seeded_${index}`)+(swapAt===null?'':`+swap-${swapAt}`)
}
function startRecordId(solverAlias,index,swapAt=null){
  const solver=solverAlias?`${solverAlias}:javascript_fallback`:'javascript_fallback';
  return solver+startSuffix(index,swapAt)
}
function unstartedRecord(solverAlias,index,globalDeadlineReached,swapAt=null){return {
  id:startRecordId(solverAlias,index,swapAt),started:false,completed:false,truncated:false,selected:false,
  global_deadline_reached:globalDeadlineReached,
}}
/** The neighbour orders the starts a repeated item-type sequence freed run, as
 *  Rust's `distinct_start_orders`: one item swapped with the next where their types differ,
 *  the smallest change that gives a new type sequence, taken start by start and position by
 *  position, never one `seen` already holds. A neighbour keeps its order nearly sorted, so it
 *  costs about what the start it replaces did. Only positions whose two items share the lead
 *  keys are offered, so a neighbour, like a shuffle, never puts a low-priority item ahead of
 *  a high-priority one. At most `max(32, 16 * needed)` are examined; O(c * n) time and O(n)
 *  space per key for `c` examined. */
function neighbourStarts(ownStarts,seen,freed,needed){
  const neighbours=[],limit=Math.max(32,16*needed);let examined=0;
  for(const {index,sequence,swappable} of ownStarts)for(const at of swappable){
    if(neighbours.length>=freed||examined>=limit)return neighbours;
    examined++;
    const swapped=sequence.slice();[swapped[at],swapped[at+1]]=[swapped[at+1],swapped[at]];
    const key=swapped.join(',');
    if(!seen.has(key)){seen.add(key);neighbours.push({index,swapAt:at})}
  }
  return neighbours
}
// A portfolio's start records are its runs' own, in run order: only the winning run keeps
// its selected start, and a deadline that passed during a later run is every run's.
function portfolioStarts(runs,winnerIndex,globalDeadlineReached){
  return runs.flatMap((run,index)=>run.termination.starts.map(start=>({...start,
    selected:index===winnerIndex&&start.selected,
    global_deadline_reached:start.global_deadline_reached||globalDeadlineReached,
  })))
}
// Lattice nodes the block start added to `fast` and `balanced` may enumerate per mode --
// the bound `quality` gives the same solver through `container_plan_node_limit`, which
// those two profiles leave at one: too few for the enumeration to reach its first block.
const BLOCK_START_NODE_LIMIT=100000;
// Lattice nodes between two clock reads of the block enumeration.
const BLOCK_CLOCK_PERIOD=64;
// Leading blocks the `quality` block lookahead completes in each round, and its
// lattice-node budget per mode as a multiple of `container_plan_node_limit`.
const BLOCK_LOOKAHEAD_WIDTH=4;
const BLOCK_LOOKAHEAD_NODE_FACTOR=64;
// One (space, type, rotation) group of the block enumeration visits every (nx, ny) with
// nx <= maximumNx and nx*ny <= capacity, ny <= maximumY, one node each, in nx-major order.
// The three functions below replace that per-node walk without changing what it decides:
// how many nodes the group holds, the node a counted limit or the clock stops it at, and
// the group's first largest count. O(maximumNx) for the first, O(1 + clock reads) for the
// second, at most the group's own nodes for the third.
function blockGroupNodes(maximumNx,maximumY,capacity){let nodes=0;
  for(let nx=1;nx<=maximumNx;nx++)nodes+=Math.min(maximumY,Math.floor(capacity/nx));
  return nodes}
// The node a walk of `groupNodes` nodes from `nodes` stops at, or -1 if it walks them all. A
// node at or past `stopAt`, where the counted limits trip, stops it before the clock is read;
// before that the clock is read at every node whose index is a multiple of the period, as the
// per-node walk read it, so a wall-clock stop can only land on the nodes it could before.
function blockStopNode(nodes,groupNodes,stopAt,deadline){const end=nodes+groupNodes,counted=Math.min(end,stopAt);
  for(let tick=nodes+(BLOCK_CLOCK_PERIOD-nodes%BLOCK_CLOCK_PERIOD)%BLOCK_CLOCK_PERIOD;tick<counted;tick+=BLOCK_CLOCK_PERIOD)
    if(deadline.expired())return tick;
  return end>stopAt?stopAt:-1}
// The group's first largest count `nx*ny*nz`, nz = min(maximumZ, floor(capacity/(nx*ny))).
// `upper` bounds every count in the group, min(capacity, maximumNx*maximumY*maximumZ), and
// a later node replaces the incumbent only when strictly larger, so the walk ends at the
// first node that reaches it.
function blockGroupBest(maximumNx,maximumY,maximumZ,capacity,upper){let count=0,bestNx=0,bestNy=0,bestNz=0;
  walk:for(let nx=1;nx<=maximumNx;nx++)for(let ny=1,maximumNy=Math.min(maximumY,Math.floor(capacity/nx));ny<=maximumNy;ny++){
    const nz=Math.min(maximumZ,Math.floor(capacity/(nx*ny)));
    if(nx*ny*nz>count){count=nx*ny*nz;bestNx=nx;bestNy=ny;bestNz=nz;if(count===upper)break walk}}
  return {count,nx:bestNx,ny:bestNy,nz:bestNz}}
// Fields of one type's entry in a space's tally: the capacity it was counted for, the nodes
// of all its groups, its largest count, and the lattice and extents of the group that leads.
const BLOCK_TALLY_FIELDS=7;
// Every group of one type in one space at one capacity: the nodes they hold together and the
// group that leads among them. Inside one type and space the key's lead (count, fill and
// volume) is decided by the count alone, the type and the anchor are shared, and the
// rotations are distinct, so the leader is the largest count and, among equal counts, the
// rotation that sorts first; inside a group it is the group's first largest count. Nothing
// here depends on the incumbent, so it holds for the space until the capacity moves.
// O(R*maximumNx) plus the groups' own nodes for the counts.
function blockTypeTally(space,lattices,capacity,tally,offset){let nodes=0,count=0,leader=-1,bestNx=0,bestNy=0,bestNz=0;
  for(let index=0;index<lattices.length;index++){const ed=lattices[index].ed;if(ed[0]>space.d[0]||ed[1]>space.d[1])continue;
    const maximumNx=Math.min(Math.floor(space.d[0]/ed[0]),capacity),maximumY=Math.floor(space.d[1]/ed[1]),maximumZ=Math.floor(space.d[2]/ed[2]);
    nodes+=blockGroupNodes(maximumNx,maximumY,capacity);
    // No count in the group exceeds `upper`: a group bounded below the leader cannot lead.
    const upper=Math.min(capacity,maximumNx*maximumY*maximumZ);if(upper===0||upper<count)continue;
    const group=blockGroupBest(maximumNx,maximumY,maximumZ,capacity,upper);
    if(group.count>count||group.count===count&&compareCodePoints(lattices[index].rotation,lattices[leader].rotation)<0){
      count=group.count;leader=index;bestNx=group.nx;bestNy=group.ny;bestNz=group.nz}}
  tally[offset]=capacity;tally[offset+1]=nodes;tally[offset+2]=count;tally[offset+3]=leader;tally[offset+4]=bestNx;tally[offset+5]=bestNy;tally[offset+6]=bestNz}
// A free space of the block enumeration: its exact volume, and the tally `blockTypeTally`
// keeps for it while it survives.
function blockSpace(x,y,z,d){return {x,y,z,d,volume:volume(d),tally:null}}
const compareBlockValue=(a,b)=>typeof a==='bigint'?(a<b?-1:a>b?1:0):typeof a==='string'?compareCodePoints(a,b):a-b;
const compareBlockKey=(a,b)=>{for(let i=0;i<a.length;i++){const difference=compareBlockValue(a[i],b[i]);if(difference)return difference}return 0};
// Far above the few-ulp error of a float product of three lengths and a count.
const BLOCK_FLOAT_MARGIN=1e-12;
// The exact ranking key of one block: lead, then its anchor, type, rotation and extents.
const blockKey=(block,volumeFirst)=>{const used=BigInt(block.count)*block.volume,fill=used*1000000n/block.space.volume;
  const lead=volumeFirst?[-used,-fill,-BigInt(block.count)]:[-BigInt(block.count),-fill,-used];
  return [...lead,block.space.z,block.space.y,block.space.x,block.itemId,block.rotation,block.nx,block.ny,block.nz]};
// Whether a block ranks strictly before the incumbent under the exact key. A count, or a
// float volume with a relative error near 1e-16, already orders most pairs; only a pair
// that lead cannot separate pays for both exact BigInt keys, so the answer is unchanged.
const blockLeads=(candidate,best,volumeFirst)=>{
  if(!volumeFirst&&candidate.count!==best.count)return candidate.count>best.count;
  if(volumeFirst&&candidate.approximateUsed>best.approximateUsed*(1+BLOCK_FLOAT_MARGIN))return true;
  if(best.key==null)best.key=blockKey(best,volumeFirst);
  return compareBlockKey(blockKey(candidate,volumeFirst),best.key)<0};
// Whether the cheap lead alone already places a block after the incumbent.
const blockTrails=(count,approximateUsed,best,volumeFirst)=>volumeFirst?approximateUsed<best.approximateUsed*(1-BLOCK_FLOAT_MARGIN):count<best.count;
// One space's turn in a round of the block enumeration: its types' nodes are added to the
// round's count and the round's incumbent replaced by any block that ranks before it. A small
// function of its own, called once per space, so V8 optimises it early: the round loop around
// it runs once per solve and stays in the baseline tiers for most of a short request.
function blockScanSpace(space,types,round){const tally=space.tally,volumeFirst=round.volumeFirst;
  for(let typeIndex=0;typeIndex<types.length;typeIndex++){const type=types[typeIndex],offset=BLOCK_TALLY_FIELDS*type.slot;
    if(tally[offset]!==type.capacity){
      // A space narrower than every rotation's footprint on one axis holds none of its groups:
      // the tally `blockTypeTally` would write, without walking the rotations to find that out.
      if(space.d[0]<type.minimumX||space.d[1]<type.minimumY){tally[offset]=type.capacity;tally[offset+1]=0;tally[offset+2]=0;tally[offset+3]=-1;tally[offset+4]=0;tally[offset+5]=0;tally[offset+6]=0}
      else blockTypeTally(space,type.lattices,type.capacity,tally,offset)}
    round.nodes+=tally[offset+1];
    const count=tally[offset+2];if(count===0)continue;
    const lattice=type.lattices[tally[offset+3]],approximateUsed=count*lattice.approximateVolume,best=round.best;
    if(best!=null&&blockTrails(count,approximateUsed,best,volumeFirst))continue;
    const candidate={space,itemId:type.itemId,rotation:lattice.rotation,pd:lattice.pd,ed:lattice.ed,volume:lattice.volume,approximateUsed,
      nx:tally[offset+4],ny:tally[offset+5],nz:tally[offset+6],count,key:null};
    if(best==null||blockLeads(candidate,best,volumeFirst))round.best=candidate}}
// One space's per-rotation blocks for a lookahead round, kept in `scan.leading`, best first
// and at most `scan.leaders` long. The tally already counted the space's nodes and found
// each type's leading rotation; a later rotation of the same type in the same space can
// still be among the leaders, so each group's own first largest count is ranked here.
function blockRankSpace(space,types,scan){const tally=space.tally,volumeFirst=scan.volumeFirst,leading=scan.leading;
  for(let typeIndex=0;typeIndex<types.length;typeIndex++){const type=types[typeIndex];
    if(tally[BLOCK_TALLY_FIELDS*type.slot+2]===0)continue;
    for(const lattice of type.lattices){const ed=lattice.ed;if(ed[0]>space.d[0]||ed[1]>space.d[1])continue;
      const maximumNx=Math.min(Math.floor(space.d[0]/ed[0]),type.capacity),maximumY=Math.floor(space.d[1]/ed[1]),maximumZ=Math.floor(space.d[2]/ed[2]);
      const upper=Math.min(type.capacity,maximumNx*maximumY*maximumZ);if(upper===0)continue;
      const full=leading.length===scan.leaders;
      if(full&&blockTrails(upper,upper*lattice.approximateVolume,leading[leading.length-1],volumeFirst))continue;
      const group=blockGroupBest(maximumNx,maximumY,maximumZ,type.capacity,upper);
      const candidate={space,itemId:type.itemId,rotation:lattice.rotation,pd:lattice.pd,ed:lattice.ed,volume:lattice.volume,
        approximateUsed:group.count*lattice.approximateVolume,nx:group.nx,ny:group.ny,nz:group.nz,count:group.count,key:null};
      if(full&&!blockLeads(candidate,leading[leading.length-1],volumeFirst))continue;
      let position=leading.length;
      while(position>0&&blockLeads(candidate,leading[position-1],volumeFirst))position--;
      leading.splice(position,0,candidate);if(leading.length>scan.leaders)leading.pop()}}}
function containedByEarlier(spaces,index){const inner=spaces[index];
  for(let other=0;other<index;other++)if(containsSpace(spaces[other],inner))return true;
  return false}
function containsSpace(outer,inner){return outer.x<=inner.x&&outer.y<=inner.y&&outer.z<=inner.z
  &&outer.x+outer.d[0]>=inner.x+inner.d[0]&&outer.y+outer.d[1]>=inner.y+inner.d[1]&&outer.z+outer.d[2]>=inner.z+inner.d[2]}
// `spaces` is containment-free (a single whole space or this function's own output),
// so a survivor untouched by the carve can neither contain nor be contained by
// another survivor, and a new slab cannot contain one either (the slab's own parent
// could not); only new slabs need the dominance scan: O(new*s) instead of O(s^2).
// For the same reason no slab repeats a survivor (it would be contained in its parent), so
// only slabs are keyed to drop repeats, the first of equal slabs keeping its place.
function subtractBlock(spaces,box,metrics){metrics.space_partitions+=spaces.length;const out=[],fresh=new Set(),slabs=new Set();
  const push=(x,y,z,X,Y,Z)=>{if(X>x&&Y>y&&Z>z){const key=`${x}:${y}:${z}:${X-x}:${Y-y}:${Z-z}`;if(slabs.has(key))return;slabs.add(key);
    const part=blockSpace(x,y,z,[X-x,Y-y,Z-z]);out.push(part);fresh.add(part)}};
  for(const space of spaces){const X=space.x+space.d[0],Y=space.y+space.d[1],Z=space.z+space.d[2],bX=box.x+box.d[0],bY=box.y+box.d[1],bZ=box.z+box.d[2];
    if(!intersects(space,box)){out.push(space);continue}
    push(space.x,space.y,space.z,Math.min(X,box.x),Y,Z);push(Math.max(space.x,bX),space.y,space.z,X,Y,Z);
    push(space.x,space.y,space.z,X,Math.min(Y,box.y),Z);push(space.x,Math.max(space.y,bY),space.z,X,Y,Z);
    push(space.x,space.y,space.z,X,Y,Math.min(Z,box.z));push(space.x,space.y,Math.max(space.z,bZ),X,Y,Z)}
  // In this order a space that contains another sorts before it: its origin is no greater
  // on every axis, and at an equal origin its volume is larger (no two spaces here are equal),
  // so a slab is tested only against the spaces ahead of it.
  const kept=out.sort((a,b)=>a.z-b.z||a.y-b.y||a.x-b.x||(a.volume>b.volume?-1:1));
  let result=kept.filter((space,index)=>!fresh.has(space)||!containedByEarlier(kept,index));
  if(result.length>256)result=result.sort((a,b)=>a.volume>b.volume?-1:a.volume<b.volume?1:a.z-b.z||a.y-b.y||a.x-b.x).slice(0,256).sort((a,b)=>a.z-b.z||a.y-b.y||a.x-b.x);
  return result}
// The result writer's shortcuts, held to the code paths they bypass by
// `test/result-writer.test.mjs`.
export const __resultWriterForTests=Object.freeze({decimalString,usedVolume,validNesting,occupiedVolume});
export const __ratiosForTests=Object.freeze({scaledRatio,supportPpm,sixPlaces,doubleFraction});
export const __planBeamForTests=Object.freeze({compareIdLists,planSignature});
export const __blockGroupForTests=Object.freeze({nodes:blockGroupNodes,stop:blockStopNode,best:blockGroupBest,typeTally:blockTypeTally,
  space:blockSpace,subtract:subtractBlock});
// The engine's own unit tables and parser, handed to the preflight so a measure means there
// exactly what it means when the model is built.
const MEASURES=Object.freeze({length:{units:LEN,parse:(value,unit)=>scalar(value,unit,LEN)},weight:{units:WT,parse:(value,unit)=>scalar(value,unit,WT)}});
/**
 * Solve a JSON request. A request no engine may answer throws `InvalidRequestError` (or its
 * subclass `FixedPlacementError`) naming the bad value, and nothing is solved.
 *
 * The rule table runs first, over the raw JSON (`checkRequest`). Whatever it does not name and
 * still stops the request being read into the model reaches the caller as the same error with
 * reason `invalid_value` -- but only until the search starts (`phase.solving`), so a solver
 * defect is never dressed up as the caller's mistake. An error that already carries its own
 * `code` (unsupported feature, policy, fixed placement, direction) passes through unchanged.
 */
export function packFallback(req,clock=monotonicNow,solverAlias=null,startIndex=null,sharedDeadline=null){
  if(!isObject(req))throw new InvalidRequestError('wrong_type','','must be an object');
  rejectUnsupported(req);
  checkRequest(req,MEASURES);
  const result=solveChecked(req,clock,solverAlias,startIndex,sharedDeadline);
  warnUnsupportedPlacements(result,req.configuration?.minimum_support_ratio??0);
  return result;
}
// The default minimum_support_ratio of 0 is kept so that no packing answer changes,
// and a caller who never set it is told instead. The count reads the support ratio every
// placement already reports, O(placements) with no geometry: an obstacle is geometry only
// and gives no support, so an item on one counts, while a fixed placement is a supporter
// like any other. A lattice summary is always floor-up and has no placements. Every engine
// emits this text byte for byte; each alternative is a result and carries its own.
function warnUnsupportedPlacements(result,minimumSupportRatio){
  for(const alternative of result.alternatives??[])warnUnsupportedPlacements(alternative,minimumSupportRatio);
  if(minimumSupportRatio!==0)return;
  let count=0;
  for(const container of result.containers)for(const placement of container.placements??[])
    if(Number(placement.support_ratio)===0&&placement.position.z.ticks>0)count++;
  if(count>0)result.warnings=[...result.warnings,`unsupported_placements: ${count} placement(s) rest on nothing above the container floor; set configuration.minimum_support_ratio above 0 to require support`];
}
/**
 * The rule table alone, for a caller about to hand the request to the native engine: the
 * native binding reports errors as text, and a caller should get the same `InvalidRequestError`
 * whichever backend answers. Which fields a backend implements is its own business, so the
 * unsupported-feature check is not part of it.
 */
export function checkRequestShape(req){
  if(!isObject(req))throw new InvalidRequestError('wrong_type','','must be an object');
  checkRequest(req,MEASURES);
}
function solveChecked(req,clock,solverAlias,startIndex,sharedDeadline){
  const phase={solving:false};
  try{return solveFrame(req,clock,solverAlias,startIndex,sharedDeadline,phase)}
  catch(error){throw phase.solving?error:asRequestError(error)}
}
function asRequestError(error){
  if(!(error instanceof Error)||'code' in error||error instanceof CommerceInputError)return error;
  return new InvalidRequestError('invalid_value','',error.message)
}
// One frame of the solve: the outermost call, a portfolio member or one start of a multi-start
// run. Every frame reads the request into its model before it searches; `phase` is shared by
// all frames of one call and flips when the first search begins. `addedBlockStart` marks the
// frame as the block start `fast` and `balanced` add to their own; such a frame answers
// null, before it searches, for a request the lattice cannot express in full. `startOrder`
// is a multi-start run's say over one start's ordering: with `seen`, the start answers null
// for an item-type sequence already in it and otherwise reports its own; with `swapAt`, the
// start runs its ordering with that item and the next swapped.
function solveFrame(req,clock,solverAlias,startIndex,sharedDeadline,phase,addedBlockStart=false,startOrder=null){
// Admit the doors here, beside the other request-admission checks, and not
// where they are canonicalised. The container template is built after the
// uniform-lattice fast path has already returned, so validating there let a request
// that took that path name a wall this engine has never heard of and be answered --
// while Python, PHP and Rust refused the same request. The corpus could not see it:
// the schema's own enum rejects a bad direction before any engine is asked, so the
// divergence was reachable only from a library call, which is exactly how an
// embedder reaches this engine.
for(const container of req.containers??[])validateDirections(container.access_directions??[]);
admitConfiguration(req.configuration??{});
for(const container of req.containers??[])admitContainer(container);
const requestedSolvers=req.configuration?.solvers??[],knownSolvers=['grid','extreme_points','homogeneous_blocks','layer','maximal_spaces','exact_small'];
if(!Array.isArray(requestedSolvers)||requestedSolvers.some(name=>!knownSolvers.includes(name)))throw new RangeError(`unknown solver; expected one of ${knownSolvers.join(', ')}`);
const exactItemLimit=req.configuration?.exact_item_limit??7;
const requestedItemCount=(req.items??[]).reduce((total,item)=>total+(item.quantity??1),0)-(Array.isArray(req.fixed_placements)?req.fixed_placements.length:0);
if(requestedSolvers.includes('exact_small')&&requestedItemCount>exactItemLimit)throw new RangeError('exact-small item limit exceeded');
const effort=req.configuration?.effort_budget??null;
// A null limit is an absent one, as in every other engine (docs/ERRORS.md).
// Only the request's own budget is checked: a start inside the portfolio may be handed a
// spent limit of 0 by `remainingEffort`.
if(sharedDeadline===null)for(const [name,value] of Object.entries(effort??{}))if(value!=null&&(!Number.isSafeInteger(value)||value<=0))throw new RangeError(`effort_budget.${name} must be a positive safe integer`);
const requestedOrders=req.configuration?.multi_start_orders??8;
if(!Number.isSafeInteger(requestedOrders)||requestedOrders<1)throw new RangeError('multi_start_orders must be a positive safe integer');
// Eight orderings and one under `fast`, as in Python, PHP and Rust. The default was 1 until
// 1.6.0: faster, but `balanced` and `quality` never tried a large-items-first ordering.
const multiStartOrders=(req.configuration?.solver_profile??'balanced')==='fast'?1:requestedOrders;
const restartLimit=effort?.max_restarts??Number.MAX_SAFE_INTEGER;
// Every recursive solver/start shares one absolute deadline. Resetting it per child made
// a k-start request consume up to k*time_limit_ms while still reporting one portfolio
// deadline, which is both a determinism and an observability defect.
const deadline=sharedDeadline??new Deadline(req.configuration?.time_limit_ms??1000,clock);
// second review: the lowest_landed_cost refusal fires once, at the single
// outermost frame, on the packing actually selected for return -- the same choke point
// Rust, Python and PHP refuse at. A child solver/start run instead hands its result
// back sentinel and all, so a portfolio sibling with a priceable answer is not aborted
// by one run's refusal. Idempotent: the quality re-entry finalizes inside its callee.
const profile=req.configuration?.solver_profile??'balanced';
// Single-type blocks fill a carton load in milliseconds where a per-item search spends its
// whole budget, so the low-latency profiles run them as one more start and let the score
// decide. It runs last, so a restart budget drops it before any of the profile's own
// starts; one item type is the uniform lattice's case, which is exact there.
const addsBlockStart=solverAlias===null&&startIndex===null&&requestedSolvers.length===0&&(profile==='fast'||profile==='balanced')
  &&restartLimit>multiStartOrders&&new Set((req.items??[]).map(item=>item.id)).size>1;
// The start is there to improve an answer, not to replace an equal one: a lattice knows
// nothing of the ordering the profile's own starts honour, so on a tie or worse its
// packing is dropped and only the record that it ran, and what it spent, is kept. A start
// the deadline left no time for is recorded as never started, like any other restart.
const withAddedBlockStart=own=>{
  const late=deadline.expired(),left=effort==null?null:remainingEffort(effort,[own]);
  const blocks=solveFrame(withEffort({...req,configuration:{...(req.configuration??{}),multi_start_orders:1}},left),clock,'homogeneous_blocks',null,deadline,phase,true);
  if(blocks===null)return own;
  const runs=late?[own]:[own,blocks],winnerIndex=!late&&compareScore(blocks.score,own.score)<0?1:0,winner=runs[winnerIndex],globalDeadlineReached=deadline.expired();
  const starts=portfolioStarts(runs,winnerIndex,globalDeadlineReached);if(late)starts.push(unstartedRecord('homogeneous_blocks',0,globalDeadlineReached));
  winner.termination=aggregateTermination(starts);
  winner.algorithm=withPortfolioEffort(winner,runs);
  if(winner.algorithm.effort_limit_reached&&!winner.algorithm.time_limit_reached&&!globalDeadlineReached)winner.termination.code='effort_limit';
  // The profile's own answer is a real alternative to a winning lattice, as a losing
  // solver's is in the quality portfolio; the sentinel never is (review).
  if(winnerIndex===1&&!own.unpriceableDetail&&(req.configuration?.alternatives??3)>1)winner.alternatives=[own];
  return winner
};
const finalizeOutermost=answer=>{
  if(solverAlias!==null||startIndex!==null)return answer;
  const result=addsBlockStart?withAddedBlockStart(answer):answer;
  if(result.unpriceableDetail!=null)throw unpriceableRefusal(result.unpriceableDetail);
  // Belt and braces behind the portfolio branch's own filter: a sentinel-scored run
  // must never leave the outermost frame by any route.
  if(result.alternatives?.length)result.alternatives=result.alternatives.filter(a=>!a.unpriceableDetail);
  return result
};
if(solverAlias===null&&requestedSolvers.length===0&&profile==='quality'){
  const child={...req,configuration:{...(req.configuration??{}),solvers:['homogeneous_blocks','extreme_points','maximal_spaces','layer']}};
  return solveFrame(child,clock,null,null,deadline,phase)
}
if(solverAlias===null&&requestedSolvers.length){
  let remainingStarts=restartLimit;
  const plans=[];
  for(const name of requestedSolvers){
    // A lattice and the layer start sort by their own key, so a second ordering repeats the
    // first, as Python's order-insensitive solvers do.
    const count=Math.min(ORDER_INSENSITIVE_SOLVERS.has(name)?1:multiStartOrders,remainingStarts);
    if(count<1)break;
    plans.push({name,count});remainingStarts-=count;
  }
  const runs=[];
  for(const plan of plans){
    if(runs.length&&deadline.expired())break;
    const left=effort==null?null:remainingEffort(effort,runs);
    const childRequest=withEffort({...req,configuration:{...(req.configuration??{}),solvers:[],multi_start_orders:plan.count}},left);
    runs.push(solveFrame(childRequest,clock,plan.name,null,deadline,phase));
  }
  let winnerIndex=0;for(let index=1;index<runs.length;index++)if(compareScore(runs[index].score,runs[winnerIndex].score)<0)winnerIndex=index;
  const winner=runs[winnerIndex],globalDeadlineReached=deadline.expired();
  const starts=portfolioStarts(runs,winnerIndex,globalDeadlineReached);
  for(const plan of plans.slice(runs.length))
    for(let index=0;index<plan.count;index++)starts.push(unstartedRecord(plan.name,index,globalDeadlineReached));
  winner.termination=aggregateTermination(starts);
  winner.algorithm=withPortfolioEffort(winner,runs);
  if(winner.algorithm.effort_limit_reached&&!winner.algorithm.time_limit_reached&&!globalDeadlineReached)winner.termination.code='effort_limit';
  const alternativeLimit=Math.max(0,(req.configuration?.alternatives??3)-1);
  // The sentinel is a search device, never an answer -- alternatives included (review).
  winner.alternatives=runs.filter((run,index)=>index!==winnerIndex&&!run.unpriceableDetail).sort((a,b)=>compareScore(a.score,b.score)).slice(0,alternativeLimit);
  return finalizeOutermost(winner);
}
// This value used to be accepted and never read: raising it produced no extra
// work and no extra start record, so a caller asking for eight restarts got one. Each
// start now genuinely re-solves against its own deterministic ordering and the best
// score wins, which is what `termination.starts` has always claimed to describe.
if(startIndex===null&&multiStartOrders>1){
  const plannedStarts=Math.min(multiStartOrders,restartLimit),runs=[],labels=[],ownStarts=[],seen=new Set();
  const stagedPlanSearch=profile==='quality'&&(req.configuration?.container_plan_beam_width??16)>1;
  const child=stagedPlanSearch?{...req,configuration:{...(req.configuration??{}),max_candidates_per_item:1,container_plan_beam_width:1,container_plan_node_limit:1}}:req;
  const runStart=(request,index,startOrder,label)=>{
    const left=effort==null?null:remainingEffort(effort,runs);
    const run=solveFrame(withEffort(request,left),clock,solverAlias,index,deadline,phase,false,startOrder);
    if(run!==null){runs.push(run);labels.push(label)}
    return run!==null};
  // Instances of one item are interchangeable, so a start whose item-type sequence an earlier
  // start already ran packs alike: it answers null before it searches and frees its start
  //. The earlier start is the one that won the tie when the repeat still ran, so
  // the profile's own starts answer exactly as before.
  let reached=0;
  for(;reached<plannedStarts;reached++){
    if(runs.length&&deadline.expired())break;
    const startOrder={seen,swapAt:null,sequence:null,swappable:[]};
    if(runStart(child,reached,startOrder,{index:reached,swapAt:null})&&startOrder.sequence!==null)
      ownStarts.push({index:reached,sequence:startOrder.sequence,swappable:startOrder.swappable});
  }
  const freed=reached-runs.length;
  let refined=0;
  if(stagedPlanSearch)for(;refined<2;refined++){if(deadline.expired())break;runStart(req,refined,null,{index:plannedStarts+refined,swapAt:null})}
  // Last, so a freed start never takes time or effort from one the profile always ran.
  const neighbours=neighbourStarts(ownStarts,seen,freed,plannedStarts);
  let neighboursRun=0;
  for(const {index,swapAt} of neighbours){if(deadline.expired())break;runStart(child,index,{seen:null,swapAt,sequence:null,swappable:[]},{index,swapAt});neighboursRun++}
  // Ties go to the earlier run, and the neighbours run last: one counts only where it
  // strictly beats every other answer, so it can improve the answer but never replace an
  // equal one.
  let winnerIndex=0;for(let index=1;index<runs.length;index++)if(compareScore(runs[index].score,runs[winnerIndex].score)<0)winnerIndex=index;
  const winner=runs[winnerIndex],globalDeadlineReached=deadline.expired();
  const starts=runs.map((run,index)=>({
    ...run.termination.starts[0],id:startRecordId(solverAlias,labels[index].index,labels[index].swapAt),selected:index===winnerIndex,
    global_deadline_reached:run.termination.starts[0].global_deadline_reached||globalDeadlineReached,
  }));
  for(let index=reached;index<plannedStarts;index++)starts.push(unstartedRecord(solverAlias,index,globalDeadlineReached));
  if(stagedPlanSearch)for(let index=refined;index<2;index++)starts.push(unstartedRecord(solverAlias,plannedStarts+index,globalDeadlineReached));
  for(const {index,swapAt} of neighbours.slice(neighboursRun))starts.push(unstartedRecord(solverAlias,index,globalDeadlineReached,swapAt));
  winner.termination=aggregateTermination(starts);
  winner.algorithm=withPortfolioEffort(winner,runs);
  if(winner.algorithm.effort_limit_reached&&!winner.algorithm.time_limit_reached&&!globalDeadlineReached)winner.termination.code='effort_limit';
  const suffix=startSuffix(labels[winnerIndex].index,labels[winnerIndex].swapAt);
  if(suffix)winner.algorithm={...winner.algorithm,solver:`${winner.algorithm.solver}${suffix}`};
  return finalizeOutermost(winner);
}
const u=req.units?.length??'mm',ou=req.output?.length_unit??outputLengthUnit(u),ow=req.output?.weight_unit??'g',clear=scalar(req.configuration?.clearance??0,u,LEN);
const objective=req.configuration?.objective??'default';if(!['default','lowest_cost','shipping_cost','lowest_landed_cost','open_dimension_height','maximum_value','maximum_volume'].includes(objective))throw new RangeError(`unknown objective ${JSON.stringify(objective)}`);
// `maximum_volume` fills space before it counts pieces, so every comparison below that
// leads with a piece count leads with placed volume instead when this is set.
const byVolume=objective==='maximum_volume';
const dimDivisor=req.configuration?.dimensional_weight_divisor??null,dimLengthUnit=req.configuration?.dimensional_weight_length_unit??'in',dimWeightUnit=req.configuration?.dimensional_weight_weight_unit??'lb';
if(dimDivisor!=null&&(!Number.isSafeInteger(dimDivisor)||dimDivisor<=0))throw new RangeError('dimensional_weight_divisor must be a positive safe integer');
// Both objectives price the same billed weight, so both need the divisor. There is no
// library-chosen default: a wrong guess would silently misprice every shipment.
if((objective==='shipping_cost'||objective==='lowest_landed_cost')&&dimDivisor==null)throw new RangeError(`the ${objective} objective requires configuration.dimensional_weight_divisor`);
// Rating some containers and not others would rank a priced packing against an unpriced
// one as though the unpriced were free. Checked before either solver path runs.
if(objective==='lowest_landed_cost'){
  const unrated=(req.containers??[]).filter(c=>c?.rate_table==null).map(c=>c?.id);
  if(unrated.length)throw new RangeError(`the lowest_landed_cost objective requires a rate_table on every container; ${JSON.stringify(unrated[0])} has none`);
}
if(!['mm','cm','m','in','ft'].includes(dimLengthUnit))throw new RangeError('dimensional_weight_length_unit must be mm, cm, m, in or ft');
if(!['mg','g','kg','oz','lb'].includes(dimWeightUnit))throw new RangeError('dimensional_weight_weight_unit must be mg, g, kg, oz or lb');
const dimensionalWeight=d=>Number(volume(d)*BigInt(WT[dimWeightUnit])/(BigInt(LEN[dimLengthUnit])**3n*BigInt(dimDivisor??1)));
// A flat bag is billed on the package its placements make, which only grows as items
// are added, so the current extent is also a lower bound for any completion; an empty bag has
// no parcel yet and bills nothing by volume. O(p).
const billedDimensionalWeight=(tmpl,placements)=>!tmpl.bag?dimensionalWeight(tmpl.outerD)
  :placements.length?dimensionalWeight(bagExtent(placements)):0;
const globalSupportRatio=req.configuration?.minimum_support_ratio??0;
const globalSupportPpm=supportPpm(globalSupportRatio);
const maxCandidatePoints=req.configuration?.max_candidate_points??4096;
const qualityProfile=profile==='quality';
const maxCandidatesPerItem=req.configuration?.max_candidates_per_item??(qualityProfile?16:1);
const containerPlanBeamWidth=req.configuration?.container_plan_beam_width??(qualityProfile?16:1);
const containerPlanNodeLimit=req.configuration?.container_plan_node_limit??(qualityProfile?100000:1);
for(const [name,value] of Object.entries({max_candidates_per_item:maxCandidatesPerItem,container_plan_beam_width:containerPlanBeamWidth,container_plan_node_limit:containerPlanNodeLimit}))
  if(!Number.isSafeInteger(value)||value<1)throw new RangeError(`${name} must be a positive safe integer`);
let timeLimitReached=false;
// Orientations tried by the candidate sweep, so the clock is read at every 64th one, as
// Python, PHP and Rust read it every 64th node: a counted limit is still checked at each
// one, and only where a wall-clock stop lands can move.
let candidateClockTick=0;
const metrics={candidate_points_considered:0,orientations_considered:0,feasible_candidates:0,collision_checks:0,support_checks:0,space_partitions:0,search_nodes_expanded:0};
const candidateEffortExceeded=()=>effort!=null&&(
  (effort.max_candidates_evaluated!=null&&metrics.feasible_candidates>=effort.max_candidates_evaluated)
  ||(effort.max_placement_attempts!=null&&metrics.orientations_considered>=effort.max_placement_attempts)),
  effortExceeded=()=>candidateEffortExceeded()||(effort!=null&&effort.max_search_nodes!=null&&metrics.search_nodes_expanded>=effort.max_search_nodes);
const effortRemaining=()=>effort==null?Number.MAX_SAFE_INTEGER:Math.min(
  effort.max_candidates_evaluated==null?Number.MAX_SAFE_INTEGER:effort.max_candidates_evaluated-metrics.feasible_candidates,
  effort.max_placement_attempts==null?Number.MAX_SAFE_INTEGER:effort.max_placement_attempts-metrics.orientations_considered,
  effort.max_search_nodes==null?Number.MAX_SAFE_INTEGER:effort.max_search_nodes-metrics.search_nodes_expanded,
);
// Admission runs before either solver path, not inside the general one.
// These checks used to live in the item-building loop below, which the compact lattice
// path returns before -- so a request that reached that path was admitted under weaker
// rules than every other request. A negative `Item.value` was accepted and ignored
// whenever a caller set `require_placement_coordinates: false`, which the acceptance
// rules forbid in as many words.
for(const raw of req.items??[])admitItem(raw,u);
// Admission for the rule set too, and for the same reason: a malformed rule reaching a
// solver path would be dropped there, and a request that packs in a way its own policy
// forbids is exactly what the contract exists to prevent.
const policyRules=parsePolicy(req.policy);
// A fast path skips the constraint checks below, so it is gated on there being no
// rule at all rather than on which fields a rule happens to read. Every rule form keys
// on item tags, which both fast paths already exclude -- but that is a property of
// today's forms, and a path allowed to reason about it is one that silently stops
// honouring a rule the day a form stops keying on tags.
// This path commits to one container type from a monotone billed-weight proxy
// with no alternative to compare against, unlike the general search below, which prices
// every candidate exactly via the same scoring this path's own proxy approximates. A
// rate table's bracket step or minimum charge can make that proxy disagree with the real
// price, so this path can settle on an unpriceable container over a priced one before
// pricing ever entered the decision -- the same reason it already stands down for a
// registered policy rule.
const compact=(policyRules.length||objective==='lowest_landed_cost')?null:compactGridResult(req,{u,ou,ow,clear,objective,dimensionalWeight,solverAlias,metrics,effortExceeded,effortRemaining,deadline});
if(compact!==null)return compact;
const items=[];for(const raw of req.items){const d=dims(raw.dimensions,u),w=scalar(raw.weight??0,'g',WT),rots=raw.allowed_rotations??(raw.keep_upright?['LWH','WLH']:Object.keys(ROT)),nesting=raw.nesting_height==null?null:scalar(raw.nesting_height,u,LEN),accepts=acceptedStackingGroups(raw);
  // The ordering keys below are functions of the item alone, computed once per type here
  // rather than as fresh BigInts on both sides of every comparison the sort makes.
  const vol=volume(d),longest=Math.max(...d),base=BigInt(d[0])*BigInt(d[1]);
  for(let i=1;i<=(raw.quantity??1);i++)items.push({raw,d,w,rots,vol,longest,base,id:`${raw.id}#${i}`,
    stackable:raw.stackable!==false,maxTop:raw.max_top_load==null?null:scalar(raw.max_top_load,'g',WT),
    supportPpm:supportPpm(raw.minimum_support_ratio??0),priority:raw.priority??0,
    tags:raw.tags??[],incompatible:raw.incompatible_tags??[],group:raw.group??null,
    nesting,maxStacked:raw.max_stacked_items??null,groundRule:raw.ground_contact_rule??null,
    stopIndex:raw.stop_index??null,eligibleTags:raw.eligible_container_tags??[],value:raw.value??0,
    stackingGroup:raw.stacking_group??null,accepts,
    ...parseShape(raw,d,u,nesting)})}
const requestedVolume=items.reduce((sum,item)=>sum+item.vol,0n),nominalVolume=list=>list.reduce((sum,item)=>sum+item.vol,0n);
// Priority is a preference, not a guarantee: it leads the ordering so a caller can
// bias the search, but ties (the default, priority 0 for all items) fall through to
// the volume key unchanged.
// Identifiers use the same Unicode-code-point order as Python, PHP, Rust and the commerce
// API. Locale collation is host-dependent, while JavaScript's relational/default order is
// UTF-16-code-unit order; both violate the cross-platform determinism contract outside
// ASCII. Only the sign of a key matters to the sort, so the volume key compares BigInts
// directly instead of materialising their difference.
const compareId=compareCodePoints,ascendingVolume=(a,b)=>a.vol<b.vol?-1:a.vol>b.vol?1:0;
// Small items first places the most pieces; large items first fills the most space. The
// quality profile opens with its two small-first orderings, so under `maximum_volume` the
// large-first ordering at the bottom takes the first start and those two follow it.
const smallFirstStart=qualityProfile?(startIndex??0)-(byVolume?1:0):null;
// Whether the route unloads through -x alone: a property of the request, read once rather
// than by every comparison of the sort below.
const unloadsMinusX=(req.containers??[]).some(c=>(c.access_directions??[]).includes("-x")&&!(c.access_directions??[]).includes("+x"));
// The keys every ordering leads with, a shuffled one included, as Python's `ordering_lead`:
// priority, then value under `maximum_value`, then the route's stop order.
const leadOrder=(a,b)=>{
  const priority=b.priority-a.priority;if(priority)return priority;
  // Under `maximum_value` the second objective key is the value left behind, so the
  // most valuable item must get first refusal on the space. This single pass has no
  // portfolio to select a better-scoring arrangement from, which makes the ordering
  // the only place it can search for the objective it reports. Every value
  // defaults to 0, so an unset-value request keeps the ordering below untouched.
  if(objective==='maximum_value'){const value=b.value-a.value;if(value)return value}
  // A route is unloaded last-in-first-out, so the later a stop, the earlier its items
  // must be loaded to end up underneath. An item with no stop rides the whole route and
  // loads with the last one. Every stop is Infinity when nothing declares one, so an
  // unrouted request keeps the ordering below untouched.
  {const stop=unloadsMinusX?((a.stopIndex??Infinity)-(b.stopIndex??Infinity)):((b.stopIndex??Infinity)-(a.stopIndex??Infinity));if(stop)return stop}
  return 0};
items.sort((a,b)=>{
  const lead=leadOrder(a,b);if(lead)return lead;
  // The layer start keeps its own key in every profile, as Python's and Rust's
  // order-insensitive layer solvers do. Under `quality` it used to take the small-first
  // ordering every other start there takes, so no start tried large items first.
  if(solverAlias==='layer')return (b.base<a.base?-1:b.base>a.base?1:0)||ascendingVolume(b,a)||(b.w-a.w)||compareId(a.id,b.id);
  if(smallFirstStart===0)return a.longest-b.longest||ascendingVolume(a,b)||compareId(a.id,b.id);
  if(smallFirstStart===1)return ascendingVolume(a,b)||a.longest-b.longest||compareId(a.id,b.id);
  if(solverAlias==='maximal_spaces')return (b.longest-a.longest)||ascendingVolume(b,a)||compareId(a.id,b.id);
  // `exact_small` deliberately has no ordering of its own. It used to sort by id, which
  // was harmless while it was greedy-in-disguise and actively harmful once the search
  // became real: smallest-first is the worst descent order, so the first branch failed to
  // pack everything and the bound never pruned.
  // Equal volumes tie on the longest edge, then the heavier item, as Python's `volume`
  // order does; an id tie-break let a name decide which item took the last floor cell.
  return ascendingVolume(b,a)||(b.longest-a.longest)||(b.w-a.w)||compareId(a.id,b.id);
});
// Start 0 is the ordering above, so a single-start request is byte-identical to what it
// produced before restarts existed; every later start re-solves a plain shuffle of it, as
// Python's, PHP's and Rust's seeded orders are. Priority, value and stop order lead every
// named ordering, but a shuffle is the portfolio's only way to try a low-priority item
// first, and a hard rule can need exactly that: a `must_be_on_floor` item behind a
// higher-priority one that took the only floor footprint costs a second container.
// Priority is a preference, so the score, not the ordering, decides between the starts.
if(startIndex!==null&&startIndex>0&&(!qualityProfile||startIndex>2))items.splice(0,items.length,...seededOrder(items,req.configuration?.seed??42,startIndex));
if(startOrder?.swapAt!=null){const at=startOrder.swapAt;[items[at],items[at+1]]=[items[at+1],items[at]]}
// An item type is its request entry, so the sequence never depends on how ids collate.
if(startOrder?.seen!=null){const typeOf=new Map(req.items.map((raw,index)=>[raw,index])),sequence=items.map(item=>typeOf.get(item.raw)),key=sequence.join(',');
  if(startOrder.seen.has(key))return null;
  startOrder.seen.add(key);startOrder.sequence=sequence;
  for(let at=0;at+1<items.length;at++)if(sequence[at]!==sequence[at+1]&&leadOrder(items[at],items[at+1])===0)startOrder.swappable.push(at)}
const templates=req.containers.map(c=>{const d=dims(c.inner_dimensions,u),axleSpec=c.axles==null?null:c.axles.map(a=>({position:scalar(a.position,u,LEN),max:a.max_load==null?null:scalar(a.max_load,'g',WT)}));
  if(axleSpec&&(axleSpec.length!==2||axleSpec[0].position>=axleSpec[1].position||axleSpec[0].position<0||axleSpec[1].position>d[0]))throw new RangeError('axles must be [front, rear] inside the container');
  const reservePpm=scaledRatio(c.void_fill_reserve_ratio??0);
  if(c.tag_limits!=null&&(typeof c.tag_limits!=='object'||Array.isArray(c.tag_limits)||Object.values(c.tag_limits).some(limit=>!Number.isSafeInteger(limit)||limit<1)))throw new RangeError('tag_limits must map strings to positive safe integers');
  const maxStackDensity=c.max_stack_density==null?null:scalar(c.max_stack_density,'g',WT);if(maxStackDensity!=null&&maxStackDensity<0)throw new RangeError('max_stack_density must be non-negative');
  const outerD=c.outer_dimensions?dims(c.outer_dimensions,u):d;
  // innerVolume/reserve are pure functions of the immutable template, hoisted out of
  // candidatesFor's innermost (point x rotation) loop where they were recomputed as
  // fresh BigInts per orientation.
  // The walls this container may be unloaded through. Canonicalised into
  // ALL_DIRECTIONS order and deduplicated rather than kept as given, so two callers naming
  // the same doors in a different order search identically -- the same normalisation the
  // Python, PHP and Rust decoders apply, and the reason all four agree on the answer.
  validateDirections(c.access_directions??[]);
  const doors=Object.freeze(ALL_DIRECTIONS.filter(d=>(c.access_directions??[]).includes(d)));
  return {...c,d,outerD,doors,bag:c.deformable_boundary!=null,machine:parseMachine(c.made_to_measure,u),max:c.max_payload==null?null:scalar(c.max_payload,'g',WT),tare:scalar(c.tare_weight??0,'g',WT),axleSpec,reservePpm,
    innerVolume:volume(d),reserve:volume(d)*BigInt(reservePpm)/BigInt(SUPPORT_SCALE),
    rate:parseRateTable(c.rate_table),tagLimits:c.tag_limits??{},maxStackDensity,
    obs:(c.obstacles??[]).flatMap(o=>[o,...(o.additional_boxes??[])]).map(o=>({x:scalar(o.origin?.x??0,u,LEN),y:scalar(o.origin?.y??0,u,LEN),z:scalar(o.origin?.z??0,u,LEN),d:dims(o.dimensions,u)}))}}).sort((a,b)=>objective==='shipping_cost'||objective==='lowest_landed_cost'?(dimensionalWeight(a.outerD)-dimensionalWeight(b.outerD)||(a.cost_minor??0)-(b.cost_minor??0)||Number(volume(a.d)-volume(b.d))):((a.cost_minor??0)-(b.cost_minor??0)||Number(volume(a.d)-volume(b.d))));
// Admission of fixed placements, before any search: the containers they name, each holding
// only its fixed items, in opening order. Their instances leave the free list.
const fixedGroups=admitFixedPlacements(req,{items,templates,u,clear});
// The request is read: from here on a failure is the solver's, not the caller's. The compact
// path above reads and answers in one closed-form step, so everything it throws is reading.
phase.solving=true;
const fixedIds=new Set(fixedGroups.flatMap(group=>group.placements.map(p=>p.item.id)));
const inventory=new Map(templates.map(c=>[c.id,c.quantity??Infinity])),remaining=items.filter(item=>!fixedIds.has(item.id)),packed=[];let seq=0;
// A fresh per-container search state: candidate points, spatial index and running volume,
// with the template's fixed items (`tmpl.fixed`, set only on a seeded copy) already placed
// exactly as search would place them, so every solver starts from them unaware they exist.
const seedState=tmpl=>{const node={state:{tmpl,placements:[],payload:0},used:0n,
    points:[[0,0,0],...tmpl.obs.flatMap(o=>[[o.x+o.d[0],o.y,o.z],[o.x,o.y+o.d[1],o.z],[o.x,o.y,o.z+o.d[2]]])].sort(comparePoints),
    index:makeIndex(tmpl.d)};
  for(const placement of tmpl.fixed??[]){const placements=node.state.placements;node.state.payload+=placement.item.w;
    const compressionSensitive=placement.item.shapeType==='compressible'||placements.some(p=>p.item.shapeType==='compressible');
    node.used=compressionSensitive?usedVolume([...placements,placement]):node.used+usedVolumeDelta(placements,placement);
    placements.push(placement);indexAdd(node.index,placements.length-1,{x:placement.x,y:placement.y,z:placement.z,d:placement.ed});
    retirePointsForPlacement(node.points,placement);for(const point of pointsFrom(placement))insertPoint(node.points,point)}
  return node};
const maxContainers=req.configuration?.max_containers??Infinity;
// Trial-packs `itemsRemaining` into one instance of `tmpl`, batching group members
// together so they land in one container or none of them do. Returns the resulting
// state (possibly with no placements, if nothing fit) and whatever did not fit.
// Metrics/timeLimitReached accumulate into the shared closures even for a trial
// that is ultimately discarded, matching Python's `_across_containers`/PHP's
// `acrossContainers`, which pay for the same per-template work regardless of which
// template wins.
// Group members travel together: one container takes all of them or none. Batching them
// here is what both the greedy pass and the exact search branch over.
const batchesOf=groupBatches;
// Every feasible (candidate point, rotation) for `item`, ordered by the solver's own
// candidate score, best first. The greedy path asks for one and takes it; the exact search
// asks for all of them and branches on each, which is the only difference between the two
//. Ties keep insertion order, which is the sorted point order crossed with the
// item's declared rotations -- deterministic without a tiebreak key.
//
// Kept as the one loop over `candidates` it was in 1.6.0, with eight plain parameters that
// every caller passes. The axle pass as a second iteration of an enclosing loop, and the
// support ratio as a default parameter, each cost about half of a 7% slower cold br7 `fast`
// process in the frontier's Node 22 image, where this sweep runs mostly before TurboFan has
// compiled it (docs/PERFORMANCE-PRACTICE.md, "The 1.7 candidate sweep on a cold process").
const sweepCandidates=(tmpl,item,state,candidates,index,used,width,supportRatioPpm)=>{
  if(item.eligibleTags.length&&!item.eligibleTags.some(tag=>(tmpl.tags??[]).includes(tag)))return [];
  if(item.tags.length&&item.tags.some(tag=>tmpl.tagLimits[tag]!=null&&state.placements.filter(p=>p.item.tags.includes(tag)).length>=tmpl.tagLimits[tag]))return [];
  // Every rule form is a statement about this item, this container and what the container
  // already holds -- none of them depends on where in the container the item would go, so
  // the check belongs here beside the eligibility and tag-limit gates rather than inside
  // the point loop, and costs O(m + r) per (template, item) instead of per candidate.
  if(policyRules.length&&policyRejection(policyRules,item.tags,tmpl.tags??[],tagOccurrences(state.placements))!==null)return [];
  // The placed boxes do not move for the whole of this item's candidate sweep, so
  // their contact graph is built once here -- on first demand, since most candidates never
  // reach a load rule -- and every candidate appends to it instead of rebuilding.
  //
  // Nesting is excluded: a nesting predecessor *replaces* the face edges of everything in
  // its column, so one new placement can rewrite edges arbitrarily far from itself and the
  // delta is no longer local. Nesting keeps the from-scratch path.
  const nestingPresent=item.nesting!=null||anyPlaced(state.placements,'nesting');
  let loadBaseGraph;
  const loadBase=nestingPresent?null:()=>{
    if(loadBaseGraph===undefined){
      // The cell must cover every box hashed into the broad phase or queried against it,
      // and the candidate is a new item that may be wider than anything placed -- so the
      // hint comes from this item's own rotations, which are known here.
      const widest=Math.max(1,...item.rots.flatMap(r=>{const pd=rotate(item.d,r);
        return [pd[0]+2*clear,pd[1]+2*clear]}));
      const graph=buildContactGraph(state.placements.map(constraintBox),overlapXY,widest);
      // The settled order of the base scene, sorted once here: each candidate then slots
      // itself in rather than re-sorting the scene (`settleOrderWith`).
      loadBaseGraph={graph,order:settleOrder(graph.boxes)};
    }
    return loadBaseGraph;
  };
  // The same argument, for the other rule that reads the whole placed scene. The
  // doors now come from the container, which is why the hoist mattered: switching the field
  // on inside `allowed` would have turned an O(m*|D|) check into O(m^2*|D|) per candidate.
  // A container that states no doors leaves the base inert at the cost of one pass over the
  // stops, which is what every request that is not a multi-drop route pays.
  // With no doors the base is inert and admits every candidate, so the sweep skips building it.
  const accessBase=tmpl.doors.length?stopAccessibilityBase(item.stopIndex,state.placements,tmpl,tmpl.doors):null;
  const compressionSensitive=item.shapeType==='compressible'||anyCompressiblePlaced(state.placements);
  const found=[];let bestScore=0;
  // Fixed for the sweep: neither the doors nor any placed stop change inside it.
  const routeSensitive=tmpl.doors.length>0&&(item.stopIndex!=null||state.placements.some(p=>p.item.stopIndex!=null));
  // JavaScript registers no candidate scorers, so the extreme-point score is Rust's empty
  // scorer sum and the far-corner order decides alone.
  const farCornerRanked=solverAlias!=='grid'&&solverAlias!=='layer'&&solverAlias!=='maximal_spaces'&&!routeSensitive;
  const tieBreak=farCornerRanked?compareFarCorner:noTieBreak;
  // Everything that is a function of (item, rotation) alone -- the rotated envelope, the
  // volume it occupies, its hull -- is computed once per sweep here rather than once per
  // point, the class of waste docs/PERFORMANCE-PRACTICE.md ranks first. The volume gate is
  // also a function of `used`, fixed for the sweep, so it collapses to one boolean per
  // orientation; only a nesting item keeps the per-position delta, because what it can
  // nest into depends on where it lands. The payload and count gates depend on nothing
  // the point loop changes. Every gate is pure, so the order they are asked in is free.
  const placements=state.placements,nests=item.nesting!=null,sweep=sweepContext(item,placements);
  const payloadBlocked=tmpl.max!=null&&state.payload+item.w>tmpl.max,countBlocked=tmpl.max_items!=null&&placements.length>=tmpl.max_items;
  const exactHull=item.shapeType==='convex_hull'&&item.stopIndex==null&&clear===0;
  // The free volume the gate below compares against, fixed for the sweep: used + v + reserve
  // exceeds the inner volume exactly when v exceeds it, so each orientation pays one BigInt
  // comparison instead of two additions and a comparison.
  // A box occupies its own volume in every rotation, the item's `vol`, so only a hull or a
  // compressible item asks `occupiedVolume` per orientation.
  const volumeRoom=tmpl.innerVolume-tmpl.reserve-used,orientations=[],volumeGated=!compressionSensitive&&!nests;
  const boxVolumeBlocked=item.shapeType!=='convex_hull'&&item.maxCompressionKpa==null?volumeGated&&item.vol>volumeRoom:null;
  for(const r of item.rots){const pd=rotate(item.d,r),ed=grown(pd,2*clear);
    orientations.push({r,pd,ed,shape:exactHull?shapeFor(item.hullVertices,r):null,
      volumeBlocked:boxVolumeBlocked??(volumeGated&&occupiedVolume({pd,r,item})>volumeRoom)})}
  const [innerX,innerY,innerZ]=tmpl.d,obstacles=tmpl.obs;
  // A flat bag also needs a + c <= L and b + c <= W over the extents grown by the candidate
  //: O(p) once per sweep, O(1) per candidate, and a verdict never flips later.
  // Read as scalars, not destructured, so a rigid container pays nothing for the rule.
  const bag=Boolean(tmpl.bag),bagExtents=bag?bagExtent(placements):null,bagX=bag?bagExtents[0]:0,bagY=bag?bagExtents[1]:0,bagZ=bag?bagExtents[2]:0;
  candidatePoints:for(let pointIndex=0;pointIndex<candidates.length;pointIndex++){const pt=candidates[pointIndex];if(candidateEffortExceeded())break;metrics.candidate_points_considered++;const x=pt[0],y=pt[1],z=pt[2];
    for(let orientationIndex=0;orientationIndex<orientations.length;orientationIndex++){const orientation=orientations[orientationIndex];if(candidateEffortExceeded())break candidatePoints;metrics.orientations_considered++;if((candidateClockTick++&63)===0&&deadline.expired()){timeLimitReached=true;break candidatePoints}
    const {r,pd,ed}=orientation,x2=x+ed[0],y2=y+ed[1],z2=z+ed[2];
    if(x2>innerX||y2>innerY||z2>innerZ)continue;
    if(bag&&(Math.max(x2,bagX)+Math.max(z2,bagZ)>innerX||Math.max(y2,bagY)+Math.max(z2,bagZ)>innerY))continue;
    if(payloadBlocked||countBlocked||orientation.volumeBlocked)continue;
    let candidate=nests?{x,y,z,pd,ed,r,item}:null,box=null;
    if(nests&&!compressionSensitive&&usedVolumeDelta(placements,candidate)>volumeRoom)continue;
    let collision=false;
    const candidateShape=orientation.shape;
    for(let obstacleIndex=0;obstacleIndex<obstacles.length;obstacleIndex++){const obstacle=obstacles[obstacleIndex];metrics.collision_checks++;
      if(intersects(box||(box={x,y,z,d:ed}),obstacle)&&solidsOverlap(candidateShape,box,null,obstacle)){collision=true;break}}
    // Broad phase: visit only the placements sharing a cell with `box`, stamping each
    // so a placement spanning several cells is narrow-phase-checked once. A generation
    // counter does that without allocating a set per candidate orientation.
    if(!collision){
      const ix1=Math.floor(x/index.cx),ix2=ceilDiv(Math.max(x2,x+1),index.cx);
      const iy1=Math.floor(y/index.cy),iy2=ceilDiv(Math.max(y2,y+1),index.cy);
      const iz1=Math.floor(z/index.cz),iz2=ceilDiv(Math.max(z2,z+1),index.cz);
      if(ix2===ix1+1&&iy2===iy1+1&&iz2===iz1+1){
        const bucket=index.cells.get(cellKey(ix1,iy1,iz1));
        if(bucket){
          for(let slot=0;slot<bucket.length;slot++){
            const position=bucket[slot],placed=placements[position],pe=placed.ed;metrics.collision_checks++;
            if(x<placed.x+pe[0]&&x2>placed.x&&y<placed.y+pe[1]&&y2>placed.y&&z<placed.z+pe[2]&&z2>placed.z
              &&!(nests&&validNesting(candidate,placed))
              &&solidsOverlapAt(candidateShape,x,y,z,ed,placed)){collision=true;break}
          }
        }
      }else{
        const stamp=++index.gen;
        scan:for(let ix=ix1;ix<ix2;ix++)for(let iy=iy1;iy<iy2;iy++)for(let iz=iz1;iz<iz2;iz++){
          const bucket=index.cells.get(cellKey(ix,iy,iz));if(!bucket)continue;
          for(let slot=0;slot<bucket.length;slot++){const position=bucket[slot];if(index.seen[position]===stamp)continue;index.seen[position]=stamp;
            const placed=placements[position],pe=placed.ed;metrics.collision_checks++;
            if(x<placed.x+pe[0]&&x2>placed.x&&y<placed.y+pe[1]&&y2>placed.y&&z<placed.z+pe[2]&&z2>placed.z
              &&!(nests&&validNesting(candidate,placed))
              &&solidsOverlapAt(candidateShape,x,y,z,ed,placed)){collision=true;break scan}}
        }
      }
    }
    if(collision)continue;
    if(candidate===null)candidate={x,y,z,pd,ed,r,item};
    if(axleOverloaded(tmpl,placements,candidate))continue;
    if(!allowed(candidate,placements,tmpl,supportRatioPpm,metrics,loadBase,accessBase,sweep))continue;
    // With zero load the candidate is at its largest, and appending it can only shrink
    // existing compressible supports. If that upper bound fits, the exact support-graph
    // refresh cannot reject it; only a candidate near the reserve boundary pays the
    // non-local calculation. Ordinary requests retain the incremental O(1) path above.
    if(compressionSensitive){const upperBound=used+occupiedVolume(candidate);
      if(upperBound+tmpl.reserve>tmpl.innerVolume
        &&usedVolume([...placements,candidate])+tmpl.reserve>tmpl.innerVolume)continue}
    metrics.feasible_candidates++;
    const score=farCornerRanked?0:solverAlias==='grid'
      ?z*1e12+y*1e6+x
      :solverAlias==='layer'
        ?z2*1e12+z*1e8+y*1e4+x
        :solverAlias==='maximal_spaces'
          ?x2+y2+z2*1e6
          :x2*1e9+y2*1e4+z2;
    if(width===1){if(!found.length||(score-bestScore||tieBreak(candidate,found[0]))<0){found[0]=candidate;bestScore=score}continue}
    if(width!=null){retainCandidate(found,width,score,metrics.feasible_candidates,candidate,tieBreak);continue}
    found.push({score,candidate})}}
  // A returned candidate is the box itself, without its score: it becomes a placement, and a
  // placement of the block start is the same seven fields, so every reader of placements
  // meets one object shape instead of two, which deoptimised them on the second.
  if(width===1)return found;
  if(width!=null)return found.sort((a,b)=>compareRetained(a,b,tieBreak)).map(entry=>entry.candidate);
  found.sort((a,b)=>a.score-b.score||tieBreak(a.candidate,b.candidate));
  return found.map(entry=>entry.candidate)
};
// Two sweeps over the same checks: the contact points, then -- only when none of them is
// feasible and the search may go on -- the axle-balanced ones. Such a point floats the item
// away from every wall and box, so it is the last resort that keeps an item an axle limit
// would otherwise strand, never a rival to a contact point. A container without axles, and
// every item with a feasible contact point, sweeps once, exactly as before. The container
// test leads so that a sweep finding nothing reaches no code the optimised caller has not
// already run.
const candidatesFor=(tmpl,item,state,points,index,used,width,supportRatioPpm)=>{
  const found=sweepCandidates(tmpl,item,state,points.length>maxCandidatePoints?points.slice(0,maxCandidatePoints):points,index,used,width,supportRatioPpm);
  if(tmpl.axleSpec==null||item.w<=0||found.length||timeLimitReached||candidateEffortExceeded())return found;
  return sweepCandidates(tmpl,item,state,axleBalancedPoints(tmpl,state.placements,points,item,clear),index,used,width,supportRatioPpm)};
const tryPackIntoTemplate=(tmpl,itemsRemaining)=>{const seeded=seedState(tmpl),state=seeded.state;const next=[];
  // Running `usedVolume` of `state.placements`, maintained incrementally rather than
  // recomputed per candidate. Kept local to this call, not on `state`, so it
  // cannot leak into the packed container the caller spreads.
  let used=seeded.used;
  // Whether a compressible item is placed, kept alongside the placements (and restored with
  // them) rather than rediscovered by a scan of every placement per placed item.
  let placedCompressible=state.placements.some(placement=>placement.item.shapeType==='compressible');
  const points=seeded.points,index=seeded.index;
  for(const batch of batchesOf(itemsRemaining)){
    const snapshotPlacements=state.placements.slice(),snapshotPayload=state.payload,snapshotUsed=used,snapshotCompressible=placedCompressible;
    const snapshotPoints=batch.length>1?points.slice():null,snapshotIndex=batch.length>1?copyIndex(index):null;let ok=true;
    for(const item of batch){
      if(deadline.expired()){timeLimitReached=true;ok=false;break}
      if(effortExceeded()){ok=false;break}
      metrics.search_nodes_expanded++;
      const best=candidatesFor(tmpl,item,state,points,index,used,1,globalSupportPpm)[0];
      if(!best){ok=false;break}
      state.payload+=item.w;
      const compressionSensitive=item.shapeType==='compressible'||placedCompressible;
      used=compressionSensitive?usedVolume([...state.placements,best]):used+usedVolumeDelta(state.placements,best);
      state.placements.push(best);if(item.shapeType==='compressible')placedCompressible=true;
      indexAdd(index,state.placements.length-1,{x:best.x,y:best.y,z:best.z,d:best.ed});
      retirePointsForPlacement(points,best);
      for(const point of pointsFrom(best))insertPoint(points,point)}
    if(!ok){state.placements=snapshotPlacements;state.payload=snapshotPayload;used=snapshotUsed;placedCompressible=snapshotCompressible;
      if(snapshotPoints)points.splice(0,points.length,...snapshotPoints);
      if(snapshotIndex){index.cells=snapshotIndex.cells;index.owned=snapshotIndex.owned;index.seen=snapshotIndex.seen}next.push(...batch)}}
  return {state,next,used}
};
const packBeamIntoTemplate=(tmpl,itemsRemaining)=>{
  const batches=batchesOf(itemsRemaining);
  const fresh=()=>({...seedState(tmpl),unplaced:[]});
  const clone=node=>({state:{tmpl,placements:node.state.placements.slice(),payload:node.state.payload},used:node.used,
    points:node.points.slice(),index:copyIndex(node.index),unplaced:node.unplaced.slice()});
  // What a placement changes that ranking reads: the placements, payload and used volume.
  const placeState=(node,candidate)=>{node.state.payload+=candidate.item.w;
    const compressionSensitive=candidate.item.shapeType==='compressible'
      ||node.state.placements.some(placement=>placement.item.shapeType==='compressible');
    node.used=compressionSensitive?usedVolume([...node.state.placements,candidate]):node.used+usedVolumeDelta(node.state.placements,candidate);
    node.state.placements.push(candidate)};
  // What it changes that only a later expansion reads: the spatial index and the points.
  const placeGeometry=(node,candidate)=>{indexAdd(node.index,node.state.placements.length-1,{x:candidate.x,y:candidate.y,z:candidate.z,d:candidate.ed});
    retirePointsForPlacement(node.points,candidate);for(const point of pointsFrom(candidate))insertPoint(node.points,point)};
  const place=(node,candidate)=>{placeState(node,candidate);placeGeometry(node,candidate)};
  // A one-item child is ranked before it has points or a spatial index of its own: only the
  // beam's survivors are expanded again, so only they copy their parent's. The
  // parent is never queried or placed into after its children exist, so a late copy is the
  // copy an early one would have made.
  const lazyChild=(node,candidate)=>{const child={state:{tmpl,placements:node.state.placements.slice(),payload:node.state.payload},used:node.used,
    points:null,index:null,unplaced:node.unplaced.slice(),parent:node,candidate};
    if(candidate!==null)placeState(child,candidate);return child};
  const materialize=node=>{if(node.points!==null)return node;
    node.points=node.parent.points.slice();node.index=copyIndex(node.parent.index);
    if(node.candidate!==null)placeGeometry(node,node.candidate);
    node.parent=node.candidate=null;return node};
  // Prefix sums of the ascending costs. Costs are non-negative, so the sums never decrease
  // and `maxCount` is one binary search: O(log f) per node instead of the O(f) walk.
  const cumulativeCosts=costs=>{costs.sort((a,b)=>a<b?-1:a>b?1:0);let used=0n;return costs.map(cost=>used+=cost)};
  const maxCount=(cumulative,capacity)=>{let low=0,high=cumulative.length;while(low<high){const middle=(low+high)>>1;if(cumulative[middle]<=capacity)low=middle+1;else high=middle}return low};
  // `future` is the same array for every comparison inside one `expansions.sort(...)`
  // call, so its cumulative volume/weight arrays are hoisted by the caller and
  // passed in here -- falls back to building them on the fly for the trivial future=[]
  // call sites below, which never reach the sort's cost. Reused arrays are read-only.
  // Each future item counts what it occupies, as `node.used` does: two wedges each
  // declaring the whole crate both fit in it.
  const lowerBound=(node,future,cumulativeVolumes=null,cumulativeWeights=null)=>{let possible=future.length;
    if(!future.some(item=>item.nesting!=null))possible=Math.min(possible,maxCount(cumulativeVolumes??cumulativeCosts(future.map(itemOccupiedVolume)),volume(tmpl.d)-node.used));
    if(tmpl.max!=null)possible=Math.min(possible,maxCount(cumulativeWeights??cumulativeCosts(future.map(item=>BigInt(item.w))),BigInt(Math.max(0,tmpl.max-node.state.payload))));
    return node.unplaced.length+future.length-possible};
  // Compared states are complete; placement always mutates a fresh clone first.
  // Weak keys let discarded branches release their cached strings with their state.
  const stateKeys=new WeakMap();
  const stateKey=state=>{let key=stateKeys.get(state);if(key===undefined){
    key={maxZ:state.placements.reduce((z,p)=>Math.max(z,p.z+p.ed[2]),0),signature:undefined};stateKeys.set(state,key)}return key};
  const segment=p=>`${p.item.id}@${p.x},${p.y},${p.z}`;
  const signature=state=>{const key=stateKey(state);if(key.signature===undefined)key.signature=state.placements.map(segment).join('|');return key.signature};
  // The order of two states' signatures, without comparing the prefix they share. Beam
  // siblings hold the same placement objects up to their parent's length, and the same
  // object gives the same segment, so both signatures open with that prefix and a '|';
  // past it, only the tails decide. A state whose placements are all shared is a proper
  // prefix of the other's signature, which sorts it first, as the whole strings would.
  const compareSignatures=(a,b)=>{const left=a.placements,right=b.placements,shared=Math.min(left.length,right.length);
    let common=0;while(common<shared&&left[common]===right[common])common++;
    if(common===0)return compareCodePoints(signature(a),signature(b));
    if(common===left.length)return common===right.length?0:-1;
    if(common===right.length)return 1;
    return compareCodePoints(left.slice(common).map(segment).join('|'),right.slice(common).map(segment).join('|'))};
  // An upper bound on the volume a node can still end with: what is placed, plus the
  // future items' total volume capped by the free space. Nominal volumes are not additive
  // under nesting (`futureVolume` is null), so the free space alone is the bound there.
  const reachableVolume=(node,future,futureVolume)=>{if(!future.length)return node.used;
    const inner=volume(tmpl.d),free=inner>node.used?inner-node.used:0n;
    return node.used+(futureVolume===null||futureVolume>free?free:futureVolume)};
  const compareNodeByVolume=(a,b,bounds)=>{const reachA=bounds===null?a.used:bounds.get(a),reachB=bounds===null?b.used:bounds.get(b);
    if(reachA!==reachB)return reachA>reachB?-1:1;if(a.used!==b.used)return a.used>b.used?-1:1;
    const difference=a.unplaced.length-b.unplaced.length;if(difference)return difference;
    const az=stateKey(a.state).maxZ,bz=stateKey(b.state).maxZ;if(az!==bz)return az-bz;
    return compareSignatures(a.state,b.state)};
  const compareNode=(a,b,bounds=null)=>{if(byVolume)return compareNodeByVolume(a,b,bounds);
    let difference=bounds===null?a.unplaced.length-b.unplaced.length:bounds.get(a)-bounds.get(b);if(difference)return difference;
    difference=a.unplaced.length-b.unplaced.length;if(difference)return difference;
    difference=b.state.placements.length-a.state.placements.length;if(difference)return difference;
    const az=stateKey(a.state).maxZ,bz=stateKey(b.state).maxZ;
    if(az!==bz)return az-bz;if(a.used!==b.used)return a.used>b.used?-1:1;
    return compareSignatures(a.state,b.state)};
  const greedy=tryPackIntoTemplate(tmpl,itemsRemaining);let beam=[fresh()],incumbent=fresh();incumbent.state=greedy.state;incumbent.used=greedy.used;incumbent.unplaced=greedy.next;let nodes=0;
  // The batch the loop stopped before, when it stopped early (node limit, deadline or
  // effort). Surviving beam nodes have consumed only the batches before it, so completing
  // one means adding every batch from here on to its unplaced list -- mirrors Rust's
  // `try_pack_into_beam` `pending_from`.
  let pendingFrom=null;
  for(let position=0;position<batches.length;position++){
    const batch=batches[position],future=batches.slice(position+1).flat(),expansions=[];let exhausted=false;
    for(const node of beam){if(nodes>=containerPlanNodeLimit||deadline.expired()||effortExceeded()){exhausted=true;break}nodes++;metrics.search_nodes_expanded++;
      const children=[];
      if(batch.length===1){for(const candidate of candidatesFor(tmpl,batch[0],node.state,node.points,node.index,node.used,maxCandidatesPerItem,globalSupportPpm))
        children.push(lazyChild(node,candidate))}else{
        const child=clone(node);let accepted=true;for(const item of batch){const candidate=candidatesFor(tmpl,item,child.state,child.points,child.index,child.used,1,globalSupportPpm)[0];if(!candidate){accepted=false;break}place(child,candidate)}if(accepted)children.push(child)}
      expansions.push(...children);const skipped=lazyChild(node,null);skipped.unplaced.push(...batch);expansions.push(skipped)}
    // The incumbent is only ever compared and returned (state + unplaced); it never
    // re-enters the beam, so cloning the candidate points and spatial index for it
    // was pure allocation per expansion.
    // More unplaced items -- less placed volume under `maximum_volume` -- already loses
    // compareNode's first criterion, so the copies below are made only for a candidate
    // that can displace the incumbent.
    for(const node of expansions){if(byVolume?node.used<incumbent.used:node.unplaced.length+future.length>incumbent.unplaced.length)continue;const complete={state:{tmpl,placements:node.state.placements.slice(),payload:node.state.payload},used:node.used,unplaced:[...node.unplaced,...future]};if(compareNode(complete,incumbent)<0)incumbent=complete}
    if(!expansions.length||exhausted){pendingFrom=position;break}
    const futureVolumes=future.some(item=>item.nesting!=null)?null:cumulativeCosts(future.map(itemOccupiedVolume));
    const futureWeights=tmpl.max!=null?cumulativeCosts(future.map(item=>BigInt(item.w))):null;
    const futureVolume=futureVolumes===null?null:futureVolumes.length?futureVolumes[futureVolumes.length-1]:0n;
    const bounds=new Map(expansions.map(node=>[node,byVolume?reachableVolume(node,future,futureVolume):lowerBound(node,future,futureVolumes,futureWeights)]));
    expansions.sort((a,b)=>compareNode(a,b,bounds));beam=expansions.slice(0,containerPlanBeamWidth).map(materialize)}
  // Without the unreached tail a beam leader looks better than every complete incumbent,
  // and choosing it dropped those items outright: neither placed nor reported unpacked.
  const pending=pendingFrom===null?[]:batches.slice(pendingFrom).flat();
  const completed=beam.map(node=>({state:node.state,used:node.used,unplaced:[...node.unplaced,...pending]})).sort((a,b)=>compareNode(a,b));
  if(completed.length&&compareNode(completed[0],incumbent)<0)incumbent=completed[0];
  return {state:incumbent.state,next:incumbent.unplaced}
};
// Depth-first branch and bound over the same group batches, mirroring Python's
// `ExactSmallSolver` and PHP's: place a batch at one of its feasible candidates, or skip
// it, and abandon any branch whose remaining items cannot beat the best packing already
// found. This alias used to only reorder items and run the greedy pass above,
// then label the answer `exact_small` -- on a three-item bin-packing instance that
// left twice as many items behind as the three real engines while claiming to be exact.
//
// Exact only for the discrete candidate model and the item-count objective, which is why
// the result still reports `best_found` rather than a global optimality claim, exactly as
// the reference engines do. Bounded by `exact_item_limit`, already enforced at admission.
const packExactIntoTemplate=(tmpl,itemsRemaining)=>{
  const batches=batchesOf(itemsRemaining);
  const freshWork=()=>seedState(tmpl);
  // Fixed items are in every state and in no item list, so item counts leave them out.
  const fixedCount=(tmpl.fixed??[]).length;
  const cloneWork=w=>({state:{tmpl,placements:w.state.placements.slice(),payload:w.state.payload},
    used:w.used,points:w.points.slice(),index:copyIndex(w.index)});
  const placeInto=(w,candidate)=>{
    w.state.payload+=candidate.item.w;w.used+=usedVolumeDelta(w.state.placements,candidate);
    w.state.placements.push(candidate);
    indexAdd(w.index,w.state.placements.length-1,{x:candidate.x,y:candidate.y,z:candidate.z,d:candidate.ed});
    retirePointsForPlacement(w.points,candidate);
    for(const point of pointsFrom(candidate))insertPoint(w.points,point)};
  // One child per feasible candidate for a lone item; a group is all-or-nothing, so it
  // contributes at most one child placed greedily member by member.
  const childrenOf=(w,batch)=>{
    if(batch.length===1)return candidatesFor(tmpl,batch[0],w.state,w.points,w.index,w.used,null,globalSupportPpm)
      .map(candidate=>{const child=cloneWork(w);placeInto(child,candidate);return child});
    const child=cloneWork(w);
    for(const item of batch){
      const best=candidatesFor(tmpl,item,child.state,child.points,child.index,child.used,1,globalSupportPpm)[0];
      if(!best)return [];
      placeInto(child,best)}
    return [child]};
  // Rank every incumbent by the same complete objective vector returned to the caller.
  // Equal-count branches can still improve cost, used volume, height, landed cost or
  // value, so item count alone is not a sufficient exact-search tie-break. Computing a
  // key is O(n^2) because `planScore` includes nesting-aware used volume; with n bounded
  // by `exact_item_limit`, this stays inside the solver's existing O(B^n) search bound.
  // Equal vectors deliberately keep the first incumbent. DFS order is deterministic and
  // the public contract ranks solutions by the objective vector, not by a private string
  // made from placement coordinates. This matches Rust and makes the admissible >= cut
  // below sound: an equal-score subtree cannot change the selected result.
  const rankedWork=work=>{const placed=new Set(work.state.placements.map(p=>p.item.id));
    const next=itemsRemaining.filter(item=>!placed.has(item.id));
    const packed=work.state.placements.length?[work.state]:[];
    return planScore({packed,remaining:next})};
  const profiles=new Map(itemsRemaining.map(item=>[item.id,{
    occupiedVolume:itemOccupiedVolume(item),weight:item.w,
    minimumHeight:Math.min(...item.rots.map(rotation=>rotate(item.d,rotation)[2]+2*clear)),
  }]));
  const suffixItems=Array.from({length:batches.length+1},()=>[]);
  for(let index=batches.length-1;index>=0;index--)suffixItems[index]=[...batches[index],...suffixItems[index+1]];
  const ascendingBigInts=values=>values.sort((a,b)=>a<b?-1:a>b?1:0);
  // The least nominal volume any descendant of `work` leaves unpacked, as the leading
  // `maximum_volume` key: what was skipped for good, plus whatever of the suffix cannot
  // fit the free space. That cap holds only while occupied volume is nominal volume --
  // nesting, a hull and compression all occupy less -- so otherwise the whole suffix is
  // assumed placeable. O(n) per node.
  const volumesAdditive=[...itemsRemaining,...(tmpl.fixed??[]).map(p=>p.item)].every(item=>item.nesting==null&&item.shapeType==='rigid_cuboid');
  const remainingVolume=nominalVolume(itemsRemaining);
  const unpackedVolumeFloorPpm=(work,future)=>{
    const futureVolume=nominalVolume(future),placedVolume=work.state.placements.reduce((sum,p)=>sum+(p.fixed?0n:p.item.vol),0n);
    const inner=volume(tmpl.d),free=inner>work.used?inner-work.used:0n;
    const placeable=volumesAdditive&&free<futureVolume?free:futureVolume;
    return unpackedVolumePpm(remainingVolume-placedVolume-placeable,requestedVolume)};
  // Lexicographic lower bound for every descendant of `work`. Volume and payload cap
  // how many suffix items can still be placed. If that count can tie the incumbent, the
  // largest possible used volume and the smallest possible stack top / billed weight
  // bound the remaining objective terms. Nesting disables the additive-volume terms.
  // Per node this is O(n log n) time and O(n) temporary space, strictly below the
  // existing O(n^2) canonical score computation and inside the exponential search tree.
  const optimisticCompletionScore=(work,future)=>{
    if(work.state.placements.length===0&&future.length===0)return [0,0,0,0,0];
    const containerVolume=volume(tmpl.d),nestingInvolved=work.state.placements.some(p=>p.item.nesting!=null)||future.some(item=>item.nesting!=null);
    const volumes=ascendingBigInts(future.map(item=>profiles.get(item.id).occupiedVolume));
    let placeable=future.length,smallestVolumeSum=volumes.reduce((sum,value)=>sum+value,0n);
    if(!nestingInvolved&&containerVolume>0n){
      placeable=0;smallestVolumeSum=0n;
      for(const itemVolume of volumes){if(work.used+smallestVolumeSum+itemVolume>containerVolume)break;smallestVolumeSum+=itemVolume;placeable++}
    }
    if(tmpl.max!=null){
      const weights=future.map(item=>profiles.get(item.id).weight).sort((a,b)=>a-b);
      let count=0,total=0;const capacity=Math.max(0,tmpl.max-work.state.payload);
      for(const weight of weights){if(total+weight>capacity)break;total+=weight;count++}
      placeable=Math.min(placeable,count);
    }
    // Payload can tighten the count after the volume pass. Every equal-count floor
    // below must then use the smallest volumes for that final count; retaining the
    // earlier, longer prefix would overstate the necessary height and be inadmissible.
    smallestVolumeSum=volumes.slice(0,placeable).reduce((sum,value)=>sum+value,0n);
    const permanentlySkipped=itemsRemaining.length-(work.state.placements.length-fixedCount)-future.length;
    const unpackedFloor=permanentlySkipped+future.length-placeable;
    if(placeable===0&&work.state.placements.length===0)return byVolume?[unpackedVolumeFloorPpm(work,future),unpackedFloor,0,0,0]:[unpackedFloor,0,0,0,0];
    const largestVolumeSum=volumes.slice(Math.max(0,volumes.length-placeable)).reduce((sum,value)=>sum+value,0n);
    const usedCeiling=work.used+largestVolumeSum<(containerVolume>work.used?containerVolume:work.used)
      ?work.used+largestVolumeSum:(containerVolume>work.used?containerVolume:work.used);
    const unused=containerVolume>0n?Number((containerVolume-usedCeiling)*1000000n/containerVolume):0;
    let minimumHeight=work.state.placements.reduce((top,p)=>Math.max(top,p.z+p.ed[2]),0);
    const footprint=BigInt(tmpl.d[0])*BigInt(tmpl.d[1]);
    if(!nestingInvolved&&footprint>0n){
      const volumeHeight=Number((work.used+smallestVolumeSum+footprint-1n)/footprint);
      minimumHeight=Math.max(minimumHeight,volumeHeight)
    }
    if(placeable===future.length)minimumHeight=Math.max(minimumHeight,...future.map(item=>profiles.get(item.id).minimumHeight));
    const height=tmpl.d[2]>0?Math.floor(minimumHeight*1000000/tmpl.d[2]):0;
    const weights=future.map(item=>profiles.get(item.id).weight).sort((a,b)=>a-b);
    const grossWeight=weights.slice(0,placeable).reduce((sum,value)=>sum+value,work.state.payload+tmpl.tare);
    const billable=objective==='shipping_cost'||objective==='lowest_landed_cost'?Math.max(grossWeight,billedDimensionalWeight(tmpl,work.state.placements)):0;
    // A promotional bracket may be cheaper than a lighter bracket, so pricing the
    // lightest possible completion is not an admissible lower bound. Tariff charges are
    // non-negative; zero is the general money floor and only loosens this exact search.
    const landed=0;
    const cost=tmpl.cost_minor??0;
    if(objective==='lowest_cost')return [unpackedFloor,cost,1,unused,height];
    if(objective==='shipping_cost')return [unpackedFloor,billable,1,unused,height];
    if(objective==='lowest_landed_cost')return [unpackedFloor,landed,1,unused,height];
    if(objective==='open_dimension_height')return [unpackedFloor,minimumHeight,1,cost,unused];
    if(objective==='maximum_value')return [unpackedFloor,0,1,cost,unused];
    if(byVolume)return [unpackedVolumeFloorPpm(work,future),unpackedFloor,1,cost,unused];
    return [unpackedFloor,1,cost,unused,height]
  };
  let best=freshWork(),bestRank=rankedWork(best);
  const completeLowerBound=optimisticCompletionScore(freshWork(),suffixItems[0]);
  const dfs=(depth,work,reachable)=>{
    if(deadline.expired()){timeLimitReached=true;return}
    if(effortExceeded())return;
    metrics.search_nodes_expanded++;
    const unpackedHere=itemsRemaining.length-(work.state.placements.length-fixedCount);
    // Both count gates -- this one and the reachable-count cut below -- assume the vector
    // leads with the piece count. Under `maximum_volume` fewer pieces can be more volume,
    // so every node is ranked and only the objective bound prunes.
    if(byVolume||unpackedHere<=bestRank[0]){const workRank=rankedWork(work);if(compareScore(workRank,bestRank)<0){best=work;bestRank=workRank}}
    if(compareScore(bestRank,completeLowerBound)===0)return;
    if(depth>=batches.length)return;
    if(!byVolume&&work.state.placements.length+reachable<best.state.placements.length)return;
    if(compareScore(optimisticCompletionScore(work,suffixItems[depth]),bestRank)>=0)return;
    const batch=batches[depth],rest=reachable-batch.length;
    for(const child of childrenOf(work,batch)){
      dfs(depth+1,child,rest);
      if(compareScore(bestRank,completeLowerBound)===0)return;
      if(deadline.expired()){timeLimitReached=true;return}
      if(effortExceeded())return}
    dfs(depth+1,work,rest)};
  dfs(0,freshWork(),itemsRemaining.length);
  const placed=new Set(best.state.placements.map(p=>p.item.id));
  return {state:best.state,next:itemsRemaining.filter(i=>!placed.has(i.id))}
};
// Deterministic solid single-type block search. Candidate enumeration is
// O(B*S*T*R*X*Y) time and O(S+n) space; the shared deadline/effort counters and
// containerPlanNodeLimit bound it exactly as in Python, PHP and Rust. The start added to
// `fast` and `balanced` carries its own node bound, and `fast`, being latency-bound, runs
// only the one enumeration its objective ranks by.
const blockNodeLimit=addedBlockStart?BLOCK_START_NODE_LIMIT:containerPlanNodeLimit;
const blockModes=addedBlockStart&&profile==='fast'?[byVolume]:[false,true];
// A block set on a smaller one overhangs it, so a request that asks for support is left
// to the per-item search.
const homogeneousBlocksSupported=()=>policyRules.length===0&&globalSupportRatio===0&&templates.every(t=>!t.obs.length&&t.axleSpec==null
    &&Object.keys(t.tagLimits).length===0&&t.maxStackDensity==null&&t.reservePpm===0&&!t.bag)
  &&items.every(i=>i.group==null&&!i.tags.length&&!i.incompatible.length&&!i.eligibleTags.length
    &&i.stackable&&!i.raw.must_be_on_floor&&i.maxTop==null&&i.maxStacked==null
    &&i.supportPpm===0&&(i.groundRule==null||i.groundRule==='free')&&i.nesting==null&&i.stopIndex==null
    // Block-on-block contacts would need a second implementation of the stacking-group
    // rule; the per-item search already walks every edge.
    &&i.accepts==null);
// The distinct rotations of one item type, with what every lattice of them shares.
const blockLattices=prototype=>{const seen=new Set(),lattices=[];
  for(const rotation of prototype.rots){const pd=rotate(prototype.d,rotation),physicalKey=pd.join(':');if(seen.has(physicalKey))continue;seen.add(physicalKey);
    lattices.push({rotation,pd,ed:grown(pd,2*clear),volume:volume(pd),approximateVolume:pd[0]*pd[1]*pd[2]})}
  return lattices};
// One mode's state between rounds: what is placed, the free spaces, and what is left of
// each type. Spaces and lattices are shared between copies: a space's tally is a function
// of the space and a capacity alone, and a lattice of the type alone.
const blockStart=(tmpl,itemsRemaining)=>{const byType=new Map();
  for(const item of itemsRemaining){const values=byType.get(item.raw.id)??[];values.push(item);byType.set(item.raw.id,values)}
  return {state:{tmpl,placements:[],payload:0},spaces:[blockSpace(0,0,0,tmpl.d.slice())],byType,itemIds:[...byType.keys()].sort(),lattices:new Map()}};
const blockOpen=round=>round.spaces.length>0&&[...round.byType.values()].some(values=>values.length);
const blockCopy=round=>({state:{tmpl:round.state.tmpl,placements:round.state.placements.slice(),payload:round.state.payload},
  spaces:round.spaces,byType:new Map([...round.byType].map(([key,values])=>[key,values.slice()])),itemIds:round.itemIds,lattices:round.lattices});
const blockFinish=(round,reached)=>({state:round.state,next:round.itemIds.flatMap(key=>round.byType.get(key)),reached});
// One round's `leaders` leading blocks, best first, under `nodeLimit` and the effort budget,
// and whether a limit stopped the round (which then commits nothing). `counter.nodes` is the
// mode's node count so far.
const blockLeading=(round,volumeFirst,leaders,nodeLimit,counter)=>{const {state,spaces,byType,itemIds,lattices}=round,tmpl=state.tmpl,nodes=counter.nodes;
  // The counted limits cannot move during one round's enumeration: the candidate counters
  // change only when a block is placed, and the search-node counter moves with `nodes`.
  const stopAt=candidateEffortExceeded()?nodes:Math.min(nodeLimit,
    effort?.max_search_nodes==null?Infinity:nodes+Math.max(0,effort.max_search_nodes-metrics.search_nodes_expanded));
  // A type's capacity and lattices do not depend on the space they are tried in.
  const types=[];
  for(let slot=0;slot<itemIds.length;slot++){const itemId=itemIds[slot];
    const available=byType.get(itemId);if(!available.length)continue;const prototype=available[0];
    let capacity=available.length;if(tmpl.max_items!=null)capacity=Math.min(capacity,tmpl.max_items-state.placements.length);
    if(tmpl.max!=null&&prototype.w>0)capacity=Math.min(capacity,Math.floor(Math.max(0,tmpl.max-state.payload)/prototype.w));
    if(capacity<=0)continue;
    if(!lattices.has(itemId))lattices.set(itemId,blockLattices(prototype));
    const typeLattices=lattices.get(itemId);let minimumX=Infinity,minimumY=Infinity;
    for(const lattice of typeLattices){minimumX=Math.min(minimumX,lattice.ed[0]);minimumY=Math.min(minimumY,lattice.ed[1])}
    types.push({itemId,slot,capacity,lattices:typeLattices,minimumX,minimumY})}
  // Indexed loops: this nest runs mostly before the JIT has warmed up, where for-of and
  // destructuring pay for the iterator protocol.
  const scan={nodes,best:null,volumeFirst,leading:[],leaders};
  for(let spaceIndex=0;spaceIndex<spaces.length;spaceIndex++){const space=spaces[spaceIndex];
    // Each type's groups in a space are tallied once per capacity, and a space that survives
    // a round keeps its tally: only a type whose capacity moved is tallied again.
    if(space.tally==null)space.tally=new Array(BLOCK_TALLY_FIELDS*itemIds.length).fill(-1);
    blockScanSpace(space,types,scan);
    if(leaders>1)blockRankSpace(space,types,scan)}
  // Every node is counted, and a counted limit stops on the exact node it always did; the
  // clock is read at every 64th node index, the indices the per-node walk read it at. One
  // check over the round's nodes stops where checks over its groups in turn would, and a
  // stopped round places nothing, so its incumbent and the nodes past the stop never count.
  const stop=blockStopNode(nodes,scan.nodes-nodes,stopAt,deadline),end=stop>=0?stop:scan.nodes;
  metrics.search_nodes_expanded+=end-nodes;counter.nodes=end;
  if(stop>=0)return {leading:[],reached:true};
  return {leading:leaders>1?scan.leading:scan.best==null?[]:[scan.best],reached:false}};
// Place every member of `best`, bottom layer first, and carve it from the free spaces.
const blockCommit=(round,best)=>{const chosen=round.byType.get(best.itemId).splice(0,best.count),state=round.state;let index=0;
  for(let z=0;z<best.nz;z++)for(let y=0;y<best.ny;y++)for(let x=0;x<best.nx;x++){
    const placement={x:best.space.x+x*best.ed[0],y:best.space.y+y*best.ed[1],z:best.space.z+z*best.ed[2],pd:best.pd,ed:best.ed,r:best.rotation,item:chosen[index++]};
    state.placements.push(placement);state.payload+=placement.item.w;metrics.feasible_candidates++;metrics.orientations_considered++}
  round.spaces=subtractBlock(round.spaces,{x:best.space.x,y:best.space.y,z:best.space.z,d:[best.nx*best.ed[0],best.ny*best.ed[1],best.nz*best.ed[2]]},metrics)};
// Commit each round's leading block until nothing more fits.
const blockComplete=(round,volumeFirst,nodeLimit,counter)=>{let reached=false;
  while(blockOpen(round)){const step=blockLeading(round,volumeFirst,1,nodeLimit,counter);
    if(step.reached){reached=true;break}
    if(!step.leading.length)break;
    blockCommit(round,step.leading[0])}
  return blockFinish(round,reached)};
const blockMode=(tmpl,itemsRemaining,volumeFirst)=>blockComplete(blockStart(tmpl,itemsRemaining),volumeFirst,blockNodeLimit,{nodes:0});
const blockModeKey=candidate=>{const placements=candidate.state.placements,used=usedVolume(placements),top=placements.reduce((z,p)=>Math.max(z,p.z+p.ed[2]),0);
  return byVolume?[-used,candidate.next.length,top]:[candidate.next.length,-used,top]};
const blockModeSignature=candidate=>candidate.state.placements.map(p=>`${p.item.id}@${p.x},${p.y},${p.z}`).join('|');
// Negative when block answer `a` ranks before `b`: (lead, top), then the placement signature.
const blockAnswerOrder=(a,b)=>compareBlockKey(blockModeKey(a),blockModeKey(b))||compareCodePoints(blockModeSignature(a),blockModeSignature(b));
// `greedy`, or a better answer from completing each round's leading blocks. Each
// round ranks its BLOCK_LOOKAHEAD_WIDTH leading blocks, completes each one greedily on a
// copy, and commits the block whose completion ranks best. The greedy answer is the first
// completion, so the result is never worse than it. The round's first block is the greedy
// choice after the block committed last, so its completion is the one already known --
// unless the greedy pass was stopped by the node limit, when the first round completes it
// under the lookahead's larger budget. When that budget runs out the best completion so far
// stands; only the deadline or the effort budget marks it as stopped.
// O(K*B^2*S*T*R*X*Y) time, bounded by that budget, and O(K*(S+n)) space.
const blockLookahead=(tmpl,itemsRemaining,volumeFirst,greedy)=>{const round=blockStart(tmpl,itemsRemaining),counter={nodes:0},nodeLimit=blockNodeLimit*BLOCK_LOOKAHEAD_NODE_FACTOR;
  let best=greedy,known=greedy.reached?null:greedy;
  while(blockOpen(round)){const step=blockLeading(round,volumeFirst,BLOCK_LOOKAHEAD_WIDTH,nodeLimit,counter);
    if(step.reached||!step.leading.length)break;
    let chosen=known,chosenBlock=step.leading[0],reached=false;
    for(let index=known==null?0:1;index<step.leading.length;index++){const trial=blockCopy(round);blockCommit(trial,step.leading[index]);
      const answer=blockComplete(trial,volumeFirst,nodeLimit,counter);
      if(answer.reached){reached=true;break}
      if(chosen==null||blockAnswerOrder(answer,chosen)<0){chosen=answer;chosenBlock=step.leading[index]}}
    if(reached||chosen==null)break;
    if(blockAnswerOrder(chosen,best)<0)best=chosen;
    blockCommit(round,chosenBlock);known=chosen}
  return {...best,reached:best.reached||deadline.expired()}};
const packBlocksIntoTemplate=(tmpl,itemsRemaining)=>{if(!homogeneousBlocksSupported()||tmpl.fixed)return tryPackIntoTemplate(tmpl,itemsRemaining);
  // Modes are ranked by (lead, top, placement signature). A single mode is never ranked, and
  // the signature, a string over every placement, is built only for two modes the rest ties.
  let best=null,bestKey=null;for(const volumeFirst of blockModes){if(deadline.expired()){timeLimitReached=true;break}let candidate=blockMode(tmpl,itemsRemaining,volumeFirst);
    if(profile==='quality'&&!deadline.expired())candidate=blockLookahead(tmpl,itemsRemaining,volumeFirst,candidate);
    if(candidate.reached&&deadline.expired())timeLimitReached=true;
    if(best==null){best=candidate;continue}
    if(bestKey==null)bestKey=blockModeKey(best);
    const key=blockModeKey(candidate),order=compareBlockKey(key,bestKey);
    if(order<0||order===0&&compareCodePoints(blockModeSignature(candidate),blockModeSignature(best))<0){best=candidate;bestKey=key}}
  return best??{state:{tmpl,placements:[],payload:0},next:itemsRemaining.slice()}}
// The added start runs only where the lattice can express the whole request -- a start
// that fell back to the per-item search would repeat one the profile already ran -- and
// only where every item leads the ordering alike: a lattice takes whichever type fills
// best, so it cannot honour a caller's say over which item goes first. A stop index is
// already outside the lattice's support. The lattice also reads an item as its nominal
// box and never checks what a block rests on, so a hull, a compressible item and a
// request-wide support ratio are left to the per-item search.
if(addedBlockStart&&!(homogeneousBlocksSupported()&&globalSupportPpm===0
  &&items.every(i=>i.shapeType==='rigid_cuboid'&&i.priority===items[0].priority&&(objective!=='maximum_value'||i.value===items[0].value))))return null;
const packIntoTemplate=solverAlias==='exact_small'?packExactIntoTemplate:solverAlias==='homogeneous_blocks'?packBlocksIntoTemplate:containerPlanBeamWidth>1?packBeamIntoTemplate:tryPackIntoTemplate;
const planScore=(plan,unpacked=plan.remaining)=>{let cost=0,unused=0,height=0,billable=0,landed=0,achieved=0;
  for(const state of plan.packed){cost+=state.tmpl.cost_minor??0;const inner=volume(state.tmpl.d),used=usedVolume(state.placements);unused+=Number((inner-used)*1000000n/inner);
    const top=state.placements.reduce((z,p)=>Math.max(z,p.z+p.ed[2]),0);height+=Number(BigInt(top)*1000000n/BigInt(state.tmpl.d[2]));achieved+=top;
    if(objective==='shipping_cost'||objective==='lowest_landed_cost'){
      const billed=Math.max(state.payload+state.tmpl.tare,billedDimensionalWeight(state.tmpl,state.placements));
      if(objective==='shipping_cost')billable+=billed;else landed=addLanded(landed,state.tmpl,billed)}}
  const base=[unpacked.length,plan.packed.length,cost,unused,height];
  if(objective==='lowest_cost')return [base[0],base[2],base[1],base[3],base[4]];
  if(objective==='shipping_cost')return [base[0],billable,base[1],base[3],base[4]];
  if(objective==='lowest_landed_cost')return [base[0],landed,base[1],base[3],base[4]];
  if(objective==='open_dimension_height')return [base[0],achieved,base[1],base[2],base[3]];
  if(objective==='maximum_value')return [base[0],unpacked.reduce((sum,item)=>sum+(item.value??0),0),base[1],base[2],base[3]];
  if(byVolume)return [unpackedVolumePpm(nominalVolume(unpacked),requestedVolume),base[0],base[1],base[2],base[3]];
  return base};
const planBound=(plan)=>{const key=planScore(plan,[]),index=objective==='default'?1:2;key[index]+=additionalContainerBound(plan,templates);return key};
// The greedy round's key for one trial, read from the container the trial built: a
// made-to-measure trial carries its fabricated box, so the key prices the box that ships, never
// the machine maximum. The id closes every key, so ties go to the smaller id.
// `lowest_landed_cost` ranks the round in money: the trial's charge first, then estimated
// rounds remaining, then progress -- the key order Rust, Python and PHP use.
// `planScore`'s finished vector leads with unpacked count, which is right for whole plans but
// inverted for one round: an unpriceable-but-roomier trial out-ranked a priceable one on
// progress, refusing or over-paying requests the other three engines ship. The greedy loop
// commits the trial verbatim, so its billed weight is final here and the tariff can be read
// now; an unpriceable trial still sorts behind every priceable alternative via `addLanded`'s
// sentinel. Otherwise the round's lead is its progress: pieces placed, or exact (BigInt) volume
// placed under `maximum_volume`; both sides of a comparison always carry the same type.
const roundScore=(trial,itemsRemaining)=>{const tmpl=trial.state.tmpl,placed=trial.state.placements.length;
  if(objective==='lowest_landed_cost'){
    const billed=Math.max(trial.state.payload+tmpl.tare,billedDimensionalWeight(tmpl,trial.state.placements));
    return [addLanded(0,tmpl,billed),Math.ceil(itemsRemaining.length/Math.max(placed,1)),-placed,tmpl.id]}
  if(solverAlias==='exact_small')return [...planScore({packed:[trial.state],remaining:trial.next}),tmpl.id];
  const used=usedVolume(trial.state.placements);
  return [byVolume?-used:-placed,tmpl.cost_minor??0,Number(volume(tmpl.d)-used),tmpl.id]};
const compareRound=(left,right)=>{for(let i=0;i<left.length;i++)if(left[i]!==right[i])return left[i]<right[i]?-1:1;return 0};
// One container's trial for a round, and how many single-container solves it spent: a stock
// container is one solve, a made-to-measure one the rung chain.
const trialFor=(tmpl,itemsRemaining)=>tmpl.machine==null?{trial:packIntoTemplate(tmpl,itemsRemaining),trials:1}:madeToMeasureTrial(tmpl,itemsRemaining);
// Try each solving envelope in ascending order and keep the first that places every item;
// failing that, the trial the round's own key prefers, the smaller rung on a tie. At most four
// solves. A rung choice is a heuristic, so nothing here is ever claimed exhaustive (D13).
const madeToMeasureTrial=(tmpl,itemsRemaining)=>{
  const rungs=solvingEnvelopes(tmpl.machine,tmpl.d,itemsRemaining.map(item=>item.d.map(edge=>edge+2*clear)));
  let best=null,bestScore=null,last=null,trials=0;
  for(const rung of rungs){
    const trial=packIntoTemplate({...tmpl,d:rung,innerVolume:volume(rung),reserve:0n},itemsRemaining);trials++;last=trial;
    if(trial.state.placements.length){const cut=fabricatedTrial(tmpl,trial);if(!trial.next.length)return {trial:cut,trials};
      const score=roundScore(cut,itemsRemaining);if(bestScore==null||compareRound(score,bestScore)<0){best=cut;bestScore=score}}
    if(deadline.expired()){timeLimitReached=true;break}
    if(effortExceeded())break}
  return {trial:best??last,trials}};
// A rung trial as the box cut for it: the achieved extent of its placements, envelope far faces
// with clearance, rounded up onto the machine grid (D14). O(p).
const fabricatedTrial=(tmpl,trial)=>{const box=fabricate(tmpl.machine,tmpl.d,bagExtent(trial.state.placements),tmpl.cost_minor??0,tmpl.tare);
  return {...trial,state:{...trial.state,tmpl:{...tmpl,d:box.sides,outerD:box.outer,innerVolume:volume(box.sides),reserve:0n,cost_minor:box.cost,tare:box.tare}}}};
// Containers holding fixed items open first, in request order then instance order, each
// filled by one ordinary single-container search from its seeded state. They are kept
// whatever that search gets -- nothing, or nothing at all once the deadline or effort is
// spent -- because dropping one would drop items the request says are already loaded.
let fixedReached=false;
for(const group of fixedGroups){const seeded={...group.tmpl,fixed:group.placements};let trial=null;
  if(deadline.expired())timeLimitReached=true;else if(!fixedReached)trial=packIntoTemplate(seeded,remaining);
  if(trial===null||timeLimitReached||effortExceeded())fixedReached=true;
  inventory.set(seeded.id,inventory.get(seeded.id)-1);seq++;
  packed.push({...(trial===null?seedState(seeded).state:trial.state),seq});
  if(trial!==null)remaining.splice(0,remaining.length,...trial.next)}
if(containerPlanBeamWidth>1&&solverAlias!=='exact_small'){
  const initial={packed:packed.slice(),remaining:remaining.slice(),inventory:new Map(inventory),seq};let beam=fixedReached?[]:[initial],incumbent=initial,planNodes=0;
  while(beam.length&&planNodes<containerPlanNodeLimit){const expansions=[];let exhausted=false;
    for(const plan of beam){if(!plan.remaining.length||plan.packed.length>=maxContainers){if(compareScore(planScore(plan),planScore(incumbent))<0)incumbent=plan;continue}
      for(const tmpl of templates){if(planNodes>=containerPlanNodeLimit)break;if(deadline.expired()||effortExceeded()){exhausted=true;break}if(plan.inventory.get(tmpl.id)<=0)continue;
        // Each rung is one single-container solve, so the node limit keeps bounding the work
        // of a made-to-measure chain.
        const {trial,trials}=trialFor(tmpl,plan.remaining);planNodes+=trials;if(!trial.state.placements.length)continue;const nextInventory=new Map(plan.inventory);nextInventory.set(tmpl.id,nextInventory.get(tmpl.id)-1);
        const child={packed:[...plan.packed,{...trial.state,seq:plan.seq+1}],remaining:trial.next,inventory:nextInventory,seq:plan.seq+1};expansions.push(child);if(compareScore(planScore(child),planScore(incumbent))<0)incumbent=child}
      if(exhausted)break}
    if(exhausted||!expansions.length)break;
    const dominant=new Map();for(const plan of expansions){const signature=planSignature(plan);
      const previous=dominant.get(signature);if(!previous||compareScore(planScore(plan,[]),planScore(previous,[]))<0)dominant.set(signature,plan)}
    beam=[...dominant.values()].sort((a,b)=>compareScore(planBound(a),planBound(b))||compareIdLists(a.remaining.map(i=>i.id),b.remaining.map(i=>i.id))).slice(0,containerPlanBeamWidth)}
  packed.splice(0,packed.length,...incumbent.packed);remaining.splice(0,remaining.length,...incumbent.remaining);seq=incumbent.seq;
}else while(remaining.length&&packed.length<maxContainers&&!fixedReached){
  if(deadline.expired()){timeLimitReached=true;break}
  if(effortExceeded())break;
  const eligible=templates.filter(c=>inventory.get(c.id)>0&&remaining.some(i=>(!i.eligibleTags.length||i.eligibleTags.some(tag=>(c.tags??[]).includes(tag)))&&i.rots.some(r=>{const d=rotate(i.d,r).map(x=>x+2*clear);return d.every((x,k)=>x<=c.d[k])})));
  if(!eligible.length)break;
  // Evaluate every eligible template against the same `remaining` items
  // and commit to whichever placed the most, rather than committing up front to
  // the cheapest/smallest eligible template regardless of how few of the
  // remaining items it can actually hold -- ten single-item containers of the
  // cheapest template when one larger template would have held them all.
  let winner=null,winnerScore=null;
  for(const tmpl of eligible){
    if(deadline.expired()){timeLimitReached=true;break}
    const {trial}=trialFor(tmpl,remaining);
    if(!trial.state.placements.length)continue;
    const score=roundScore(trial,remaining);
    if(winnerScore==null||compareRound(score,winnerScore)<0){winner={tmpl,...trial};winnerScore=score}
  }
  if(!winner)break;
  inventory.set(winner.tmpl.id,inventory.get(winner.tmpl.id)-1);
  seq++;packed.push({...winner.state,seq});
  remaining.splice(0,remaining.length,...winner.next);
}
// Containers are numbered per type in opening order, `T#n`, as in every engine; fixed
// containers open first, so a fixed placement's instance n is the container emitted as `T#n`.
{const counts=new Map();
  for(const c of packed){const n=(counts.get(c.tmpl.id)??0)+1;counts.set(c.tmpl.id,n);c.seq=n}}
const containers=packed.map(c=>{const loads=topLoads(c.placements.map(constraintBox)),used=usedVolume(c.placements),topPlane=bucketByPlane(c.placements,p=>p.z+placementDimensions(p)[2]);
  const reaction=axleReactions(c.tmpl,c.placements);
  return {id:`${c.tmpl.id}#${c.seq}`,container_type:c.tmpl.id,inner_dimensions:outDims(c.tmpl.d,ou),outer_dimensions:outDims(c.tmpl.machine?c.tmpl.outerD:c.tmpl.outer_dimensions?dims(c.tmpl.outer_dimensions,u):c.tmpl.d,ou),...(c.tmpl.bag||c.tmpl.machine?{achieved_dimensions:outDims(bagExtent(c.placements),ou)}:{}),...(c.tmpl.machine?{made_to_measure:{cost_minor:c.tmpl.cost_minor,tare_weight:outWeight(c.tmpl.tare,ow)}}:{}),payload_weight:outWeight(c.payload,ow),gross_weight:outWeight(c.payload+c.tmpl.tare,ow),used_volume_ticks3:used.toString(),volume_utilization:sixPlaces(used,volume(c.tmpl.d)),centre_of_mass_offset_ppm:centreOfMassOffsetPpm(c.tmpl,c.placements,clear),...(reaction==null?{}:{axle_reactions:{basis:'gross',denominator:reaction.denominator.toString(),front_numerator:reaction.front.toString(),rear_numerator:reaction.rear.toString()}}),void_fill_reserve_ticks3:(volume(c.tmpl.d)*BigInt(c.tmpl.reservePpm)/BigInt(SUPPORT_SCALE)).toString(),placements:c.placements.map((p,i)=>({item_id:p.item.id,item_type:p.item.raw.id,position:outPoint({x:p.x+clear,y:p.y+clear,z:p.z+clear},ou),dimensions:outDims(p.pd,ou),orientation:p.r,support_ratio:sixPlaces(...(p.fixed?p.fixedSupport:supportFraction(p,c.placements,topPlane))),top_load:outWeight(loads[i],ow),...(p.fixed?{fixed:true}:{})}))}});
const fitsWithRotations=(i,rots)=>templates.some(c=>rots.some(r=>fitsTemplateAlone(c,rotate(i.d,r).map(x=>x+2*clear))));
const openedByType=new Map();for(const c of packed)openedByType.set(c.tmpl.id,(openedByType.get(c.tmpl.id)??0)+1);
// Python's and PHP's `support_is_the_blocker`. Each packed container's final scene is
// replayed once, and an item type is asked once whether it fits with the support rules -- the
// minimum ratio and the ground contact rule -- set aside but not with them: two one-candidate
// sweeps per scene. An observed fact about this layout, so its proof is `observed`. The sweeps
// share the search's counters and flags, which are put back so the replay leaves no trace.
const supportCanRefuse=i=>Math.max(globalSupportPpm,i.supportPpm)>0||(i.groundRule!=null&&i.groundRule!=='free');
const supportVerdicts=new Map();let finishedScenes=null;
const supportIsTheBlocker=i=>{
  if(!supportCanRefuse(i))return false;
  if(supportVerdicts.has(i.raw.id))return supportVerdicts.get(i.raw.id);
  if(finishedScenes==null)finishedScenes=packed.map(c=>{const tmpl={...c.tmpl,fixed:c.placements};return {tmpl,...seedState(tmpl)}});
  const unsupported={...i,supportPpm:0,groundRule:null},counters={...metrics},reached=timeLimitReached,tick=candidateClockTick;
  const fits=(scene,item,ratio)=>candidatesFor(scene.tmpl,item,scene.state,scene.points,scene.index,scene.used,1,ratio).length>0;
  const blocked=finishedScenes.some(scene=>fits(scene,unsupported,0)&&!fits(scene,i,globalSupportPpm));
  Object.assign(metrics,counters);timeLimitReached=reached;candidateClockTick=tick;
  supportVerdicts.set(i.raw.id,blocked);return blocked};
const unpacked=remaining.map(i=>{
  // Same geometric check with every physical orientation allowed, not only the
  // item's own restricted set: distinguishes "genuinely too big in any rotation"
  // from "this exact rotation restriction, and only it, rules every container out"
  //. Both are pure geometry, so both are provable without a complete search.
  const fitsAnyRotation=fitsWithRotations(i,Object.keys(ROT)),dimensionFit=fitsWithRotations(i,i.rots),weightFit=templates.some(c=>c.max==null||i.w<=c.max);
  const eligibleFit=!i.eligibleTags.length||templates.some(c=>i.eligibleTags.some(tag=>(c.tags??[]).includes(tag)));
  // Ranked after the geometric proofs: an item too big for every container is impossible
  // whatever a policy says, and naming the policy first would send a caller to change the
  // wrong thing.
  const cited=policyRules.length?provesUnplaceable(policyRules,i.tags,templates):null;
  const reason=!fitsAnyRotation?'no_compatible_container_dimensions':!dimensionFit?'rotation_restricted':!weightFit?'payload_exceeded':!eligibleFit?'no_eligible_container':cited!==null?'policy_rule':timeLimitReached?'time_limit':effortExceeded()?'effort_limit':i.group!==null?'group_cannot_fit_together':supportIsTheBlocker(i)?'insufficient_support':limitReason(i,templates,openedByType,maxContainers,clear)??'search_exhausted',details=reason==='policy_rule'?[cited]:[];
  return {item_id:i.id,item_type:i.raw.id,reason,details,proof:proofForReason(reason,details)}
});
// Canonical objective vector — see docs/OBJECTIVE.md. Five lexicographic keys,
// ascending, lower is better. Ratios are floored per container in BigInt at
// parts-per-million scale so Python, PHP, Rust and this fallback agree exactly.
const SCORE_SCALE=1000000n;let scoreCost=0,scoreUnused=0,scoreHeight=0,scoreBillable=0,scoreLanded=0,scoreAchievedHeight=0;
for(const c of packed){scoreCost+=c.tmpl.cost_minor??0;
  const inner=volume(c.tmpl.d),used=usedVolume(c.placements);
  if(inner>0n)scoreUnused+=Number((inner-used)*SCORE_SCALE/inner);
  const top=c.placements.reduce((z,p)=>Math.max(z,p.z+p.ed[2]),0),innerHeight=BigInt(c.tmpl.d[2]);
  scoreAchievedHeight+=top;
  if(innerHeight>0n)scoreHeight+=Number(BigInt(top)*SCORE_SCALE/innerHeight);
  if(objective==='shipping_cost'||objective==='lowest_landed_cost'){
    const billed=Math.max(c.payload+c.tmpl.tare,billedDimensionalWeight(c.tmpl,c.placements));
    if(objective==='shipping_cost')scoreBillable+=billed;else scoreLanded=addLanded(scoreLanded,c.tmpl,billed);}}
// The search ranks an unpriceable packing worst so that any priceable alternative beats
// it; reaching here means none existed in this run. Returning such a packing would
// quote a number the carrier never published -- the one outcome `chargeMinor` refuses
// to invent -- so the refusal fires, but once, at the outermost frame, on the packing
// actually selected for return: a portfolio sibling with a priceable answer must not be
// aborted by this run's refusal. Rust, Python and PHP refuse at the same single choke
// point (second review). The detail rides the result as a non-enumerable property
// below, a search device that never serializes.
let unpriceableDetail=null;
if(objective==='lowest_landed_cost')for(const c of packed){
  const grams=billedGrams(Math.max(c.payload+c.tmpl.tare,billedDimensionalWeight(c.tmpl,c.placements))),table=c.tmpl.rate;
  if(table!=null&&chargeMinor(table,grams)!=null)continue;
  // A missing table is already refused at admission, so `0` here is unreachable rather
  // than a real bound -- but reading a bracket off `null` would replace the refusal
  // with a TypeError, which is the one thing a refusal must not do. Rust, Python and PHP
  // report the same `0` on the same unreachable branch.
  unpriceableDetail={id:c.tmpl.id,grams,bound:table==null?0:table.brackets[table.brackets.length-1]};
  break
}
const status=unpacked.length?(timeLimitReached?'time_limit':'best_found'):'feasible',complete=!unpacked.length,effortLimitReached=effortExceeded();
const solverName=solverAlias?`${solverAlias}:javascript_fallback`:'javascript_fallback';
const starts=[{id:solverName,started:true,completed:!timeLimitReached&&!effortLimitReached,truncated:timeLimitReached||effortLimitReached,selected:true,global_deadline_reached:timeLimitReached}],termination=aggregateTermination(starts);if(effortLimitReached&&!timeLimitReached)termination.code='effort_limit';
const scoreValueForgone=remaining.reduce((sum,i)=>sum+(i.value??0),0);
const defaultScore=[unpacked.length,containers.length,scoreCost,scoreUnused,scoreHeight],score=objective==='lowest_cost'?[defaultScore[0],defaultScore[2],defaultScore[1],defaultScore[3],defaultScore[4]]:objective==='shipping_cost'?[defaultScore[0],scoreBillable,defaultScore[1],defaultScore[3],defaultScore[4]]:objective==='lowest_landed_cost'?[defaultScore[0],scoreLanded,defaultScore[1],defaultScore[3],defaultScore[4]]:objective==='open_dimension_height'?[defaultScore[0],scoreAchievedHeight,defaultScore[1],defaultScore[2],defaultScore[3]]:objective==='maximum_value'?[defaultScore[0],scoreValueForgone,defaultScore[1],defaultScore[2],defaultScore[3]]:byVolume?[unpackedVolumePpm(nominalVolume(remaining),requestedVolume),defaultScore[0],defaultScore[1],defaultScore[2],defaultScore[3]]:defaultScore;
const result={status,feasibility:{code:complete?'feasible':'unknown'},termination,optimality:{code:complete?'not_proven':'best_found'},complete,objective,algorithm:{profile:req.configuration?.solver_profile??'balanced',solver:solverName,duration_ms:0,seed:req.configuration?.seed??42,time_limit_reached:timeLimitReached,effort_limit_reached:effortLimitReached,candidates_evaluated:metrics.feasible_candidates,placements_attempted:metrics.orientations_considered,metrics},summary:{container_count:containers.length,packed_item_count:items.length-unpacked.length,unpacked_item_count:unpacked.length},score,containers,unpacked_items:unpacked,catalog_versions_used:catalogVersionsUsed(req.catalog_versions_used),warnings:['JavaScript fallback is active; build the Rust addon for the native portfolio'],alternatives:[]};
if(unpriceableDetail!=null)Object.defineProperty(result,'unpriceableDetail',{value:unpriceableDetail,enumerable:false,writable:false,configurable:true});
return finalizeOutermost(result)}

function resultTicks(value,name){
  const ticks=value&&typeof value==='object'&&Number.isSafeInteger(value.ticks)?value.ticks:null;
  if(ticks==null)throw new TypeError(`${name} must contain exact integer ticks`);
  return ticks
}
function rebalanceContext(req,result){
  rejectUnsupported(req);
  const unit=req.units?.length??'mm',clear=scalar(req.configuration?.clearance??0,unit,LEN);
  const globalSupportPpm=supportPpm(req.configuration?.minimum_support_ratio??0);
  const items=new Map();
  for(const raw of req.items??[]){
    const d=dims(raw.dimensions,unit),w=scalar(raw.weight??0,'g',WT),accepts=acceptedStackingGroups(raw);
    for(let sequence=1;sequence<=(raw.quantity??1);sequence++)items.set(`${raw.id}#${sequence}`,{
      raw,d,w,id:`${raw.id}#${sequence}`,
      rots:raw.allowed_rotations??(raw.keep_upright?['LWH','WLH']:Object.keys(ROT)),
      stackable:raw.stackable!==false,maxTop:raw.max_top_load==null?null:scalar(raw.max_top_load,'g',WT),
      supportPpm:supportPpm(raw.minimum_support_ratio??0),
      tags:raw.tags??[],incompatible:raw.incompatible_tags??[],group:raw.group??null,
      nesting:raw.nesting_height==null?null:scalar(raw.nesting_height,unit,LEN),
      maxStacked:raw.max_stacked_items??null,groundRule:raw.ground_contact_rule??null,
      stopIndex:raw.stop_index??null,eligibleTags:raw.eligible_container_tags??[],
      stackingGroup:raw.stacking_group??null,accepts,
      ...parseShape(raw,dims(raw.dimensions,unit),unit,
        raw.nesting_height==null?null:scalar(raw.nesting_height,unit,LEN)),
    })
  }
  const templates=new Map((req.containers??[]).map(raw=>{
    const d=dims(raw.inner_dimensions,unit);
    const axleSpec=raw.axles==null?null:raw.axles.map(axle=>({
      position:scalar(axle.position,unit,LEN),
      max:axle.max_load==null?null:scalar(axle.max_load,'g',WT),
    }));
    const template={...raw,d,outerD:raw.outer_dimensions?dims(raw.outer_dimensions,unit):d,bag:raw.deformable_boundary!=null,
      max:raw.max_payload==null?null:scalar(raw.max_payload,'g',WT),
      tare:scalar(raw.tare_weight??0,'g',WT),axleSpec,
      reservePpm:scaledRatio(raw.void_fill_reserve_ratio??0),
      tagLimits:raw.tag_limits??{},
      maxStackDensity:raw.max_stack_density==null?null:scalar(raw.max_stack_density,'g',WT),
      obs:(raw.obstacles??[]).flatMap(obstacle=>[obstacle,...(obstacle.additional_boxes??[])]).map(obstacle=>({
        x:scalar(obstacle.origin?.x??0,unit,LEN),y:scalar(obstacle.origin?.y??0,unit,LEN),
        z:scalar(obstacle.origin?.z??0,unit,LEN),d:dims(obstacle.dimensions,unit),
      })),
    };
    return [raw.id,template]
  }));
  const states=(result.containers??[]).map((container,index)=>{
    const template=templates.get(container.container_type);
    if(!template)throw new TypeError(`containers[${index}].container_type is not in the request`);
    return {publicContainer:container,tmpl:template,placements:(container.placements??[]).map((placement,pindex)=>{
      const item=items.get(placement.item_id);
      if(!item)throw new TypeError(`containers[${index}].placements[${pindex}].item_id is not in the request`);
      const position={
        x:resultTicks(placement.position?.x,`placements[${pindex}].position.x`),
        y:resultTicks(placement.position?.y,`placements[${pindex}].position.y`),
        z:resultTicks(placement.position?.z,`placements[${pindex}].position.z`),
      };
      const pd=[
        resultTicks(placement.dimensions?.length,`placements[${pindex}].dimensions.length`),
        resultTicks(placement.dimensions?.width,`placements[${pindex}].dimensions.width`),
        resultTicks(placement.dimensions?.height,`placements[${pindex}].dimensions.height`),
      ];
      return {x:position.x-clear,y:position.y-clear,z:position.z-clear,pd,ed:grown(pd,2*clear),
        r:placement.orientation,item,publicPlacement:placement}
    })}
  });
  return {items,states,clear,globalSupportPpm,policyRules:parsePolicy(req.policy)}
}
function rebalanceValid(context,result){
  const expected=new Set(context.items.keys()),seen=new Set(),groups=new Map();
  for(const state of context.states){
    let payload=0;
    const tagCounts=new Map();
    for(let index=0;index<state.placements.length;index++){
      const placement=state.placements[index],id=placement.item.id;
      if(seen.has(id)||!expected.has(id))return false;seen.add(id);payload+=placement.item.w;
      if(!placement.item.rots.includes(placement.r))return false;
      if(placement.item.group!=null){
        const prior=groups.get(placement.item.group);
        if(prior!=null&&prior!==state.publicContainer.id)return false;
        groups.set(placement.item.group,state.publicContainer.id)
      }
      if(placement.item.eligibleTags.length&&!placement.item.eligibleTags.some(tag=>(state.tmpl.tags??[]).includes(tag)))return false;
      for(const tag of placement.item.tags)tagCounts.set(tag,(tagCounts.get(tag)??0)+1);
      const box={x:placement.x,y:placement.y,z:placement.z,d:placement.ed};
      if(box.x<0||box.y<0||box.z<0||box.x+box.d[0]>state.tmpl.d[0]||box.y+box.d[1]>state.tmpl.d[1]||box.z+box.d[2]>state.tmpl.d[2])return false;
      if(state.tmpl.obs.some(obstacle=>intersects(box,obstacle)))return false;
      for(const other of state.placements.slice(index+1)){
        if(intersects(box,{x:other.x,y:other.y,z:other.z,d:other.ed})&&!validNesting(placement,other))return false
      }
    }
    if(state.tmpl.max!=null&&payload>state.tmpl.max)return false;
    if(state.tmpl.max_items!=null&&state.placements.length>state.tmpl.max_items)return false;
    for(const [tag,maximum] of Object.entries(state.tmpl.tagLimits))if((tagCounts.get(tag)??0)>maximum)return false;
    if(usedVolume(state.placements)+volume(state.tmpl.d)*BigInt(state.tmpl.reservePpm)/BigInt(SUPPORT_SCALE)>volume(state.tmpl.d))return false;
    if(axleOverloaded(state.tmpl,state.placements))return false;
    if(state.tmpl.bag&&!bagAdmits(state.tmpl,state.placements))return false;
    const placed=[];
    for(const candidate of [...state.placements].sort((a,b)=>a.z-b.z||a.y-b.y||a.x-b.x||compareCodePoints(a.item.id,b.item.id))){
      if(!allowed(candidate,placed,state.tmpl,context.globalSupportPpm,{support_checks:0}))return false;
      if(candidate.z!==0&&candidate.publicPlacement&&Number(candidate.publicPlacement.support_ratio)>0&&supportRatioOf(candidate,placed)<=0)return false;
      // A move the rules forbid must fail the same check a placement did. Replaying the
      // container in this order is what makes a cap or a segregation answerable at all:
      // both are statements about what an item joins, so they need a partial container to
      // be asked about, and this loop already builds one.
      if(context.policyRules.length&&policyRejection(context.policyRules,candidate.item.tags,state.tmpl.tags??[],tagOccurrences(placed))!==null)return false;
      placed.push(candidate)
    }
  }
  for(const unpacked of result.unpacked_items??[]){
    if(seen.has(unpacked.item_id)||!expected.has(unpacked.item_id))return false;
    seen.add(unpacked.item_id)
  }
  return seen.size===expected.size
}
function rebalanceCandidatePoints(state){
  const keys=new Set(['0,0,0']);
  for(const placement of state.placements){
    keys.add(`${placement.x+placement.ed[0]},${placement.y},${placement.z}`);
    keys.add(`${placement.x},${placement.y+placement.ed[1]},${placement.z}`);
    keys.add(`${placement.x},${placement.y},${placement.z+placement.ed[2]}`);
    if(placement.item.nesting!=null)keys.add(`${placement.x},${placement.y},${placement.z+placement.ed[2]-placement.item.nesting}`)
  }
  return [...keys].map(key=>key.split(',').map(Number)).sort((a,b)=>a[2]-b[2]||a[1]-b[1]||a[0]-b[0])
}
function publicRebalancedContainers(req,context){
  const outputLength=req.output?.length_unit??outputLengthUnit(req.units?.length??'mm'),outputWeight=req.output?.weight_unit??'g';
  return context.states.map(state=>{
    const loads=topLoads(state.placements.map(constraintBox));
    const payload=state.placements.reduce((total,placement)=>total+placement.item.w,0);
    const used=usedVolume(state.placements),reaction=axleReactions(state.tmpl,state.placements);
    const container={...state.publicContainer,payload_weight:outWeight(payload,outputWeight),
      gross_weight:outWeight(payload+state.tmpl.tare,outputWeight),used_volume_ticks3:used.toString(),
      volume_utilization:sixPlaces(used,volume(state.tmpl.d)),
      centre_of_mass_offset_ppm:centreOfMassOffsetPpm(state.tmpl,state.placements,context.clear),
      placements:state.placements.map((placement,index)=>({...placement.publicPlacement,
        position:outPoint({x:placement.x+context.clear,y:placement.y+context.clear,z:placement.z+context.clear},outputLength),
        dimensions:outDims(placement.pd,outputLength),orientation:placement.r,
        support_ratio:sixPlaces(...supportFraction(placement,state.placements)),
        top_load:outWeight(loads[index],outputWeight),
      })),
    };
    // A moved item changes a bag's package, so its extent is reported afresh.
    if(state.tmpl.bag)container.achieved_dimensions=outDims(bagExtent(state.placements),outputLength);
    if(reaction==null)delete container.axle_reactions;
    else container.axle_reactions={basis:'gross',denominator:reaction.denominator.toString(),front_numerator:reaction.front.toString(),rear_numerator:reaction.rear.toString()};
    return container
  })
}
/**
 * Opt-in, independently checked payload rebalancing for an existing packing.
 * A complete trial scene is validated before each atomic relocation is committed.
 */
export function rebalanceWeight(req,result,{maxMoves=64}={}){
  if(!Number.isSafeInteger(maxMoves)||maxMoves<0)throw new RangeError('maxMoves must be a non-negative safe integer');
  const objective=req.configuration?.objective??'default',dimDivisor=req.configuration?.dimensional_weight_divisor??null;
  if((objective==='shipping_cost'||objective==='lowest_landed_cost')&&dimDivisor==null)throw new RangeError(`the ${objective} objective requires configuration.dimensional_weight_divisor`);
  if(objective==='lowest_landed_cost'){
    const unrated=(req.containers??[]).find(container=>container.rate_table==null);
    if(unrated!=null)throw new RangeError(`the lowest_landed_cost objective requires a rate_table on every container; ${JSON.stringify(unrated.id)} has none`)
  }
  const context=rebalanceContext(req,result),moves=[];
  if(!rebalanceValid(context,result))throw new TypeError('result is not a valid packing of this request');
  // second review: under `lowest_landed_cost` a move is a re-pricing -- shifting
  // payload can push a destination past its rate table's last bracket, leaving the
  // "balanced" packing with no published price. States are priced with the same helpers
  // the packer bills with: an unpriceable input is refused up front in the standard
  // words, and a trial that turns any state unpriceable fails exactly like an invalid
  // one. Gated on the objective and divisor so every other request is byte-identical.
  let statesPriceable=null;
  if(objective==='lowest_landed_cost'){
    const lengthUnit=req.configuration?.dimensional_weight_length_unit??'in',weightUnit=req.configuration?.dimensional_weight_weight_unit??'lb';
    const dimensionalTicks=d=>Number(volume(d)*BigInt(WT[weightUnit])/(BigInt(LEN[lengthUnit])**3n*BigInt(dimDivisor)));
    // rebalanceContext keeps the raw rate_table; parse it once per container type with
    // the packer's own parser so both entry points refuse the same malformed tariffs.
    const pricing=new Map();
    const priceEntry=tmpl=>{
      let entry=pricing.get(tmpl.id);
      if(entry===undefined){entry={rate:parseRateTable(tmpl.rate_table),dimTicks:dimensionalTicks(tmpl.outerD)};pricing.set(tmpl.id,entry)}
      return entry};
    const unpriceableState=state=>{
      const entry=priceEntry(state.tmpl),payload=state.placements.reduce((total,placement)=>total+placement.item.w,0);
      const grams=billedGrams(Math.max(payload+state.tmpl.tare,entry.dimTicks));
      if(entry.rate!=null&&chargeMinor(entry.rate,grams)!=null)return null;
      return {id:state.tmpl.id,grams,bound:entry.rate==null?0:entry.rate.brackets[entry.rate.brackets.length-1]}};
    statesPriceable=()=>context.states.every(state=>unpriceableState(state)==null);
    for(const state of context.states){const detail=unpriceableState(state);if(detail!=null)throw unpriceableRefusal(detail)}
  }
  for(let moveNumber=0;moveNumber<maxMoves;moveNumber++){
    if(context.states.length<2)break;
    const weights=context.states.map(state=>state.placements.reduce((total,placement)=>total+placement.item.w,0));
    const spread=Math.max(...weights)-Math.min(...weights);if(spread<=0)break;
    const sourceIndex=weights.reduce((best,weight,index)=>weight>weights[best]?index:best,0);
    const placements=context.states[sourceIndex].placements.map((_,index)=>index)
      .sort((a,b)=>context.states[sourceIndex].placements[b].item.w-context.states[sourceIndex].placements[a].item.w);
    const destinations=context.states.map((_,index)=>index).filter(index=>index!==sourceIndex).sort((a,b)=>weights[a]-weights[b]);
    let committed=null;
    search:for(const placementIndex of placements){
      const moving=context.states[sourceIndex].placements[placementIndex],weight=moving.item.w;
      // A fixed item is already loaded where the request put it; nothing may move it.
      if(moving.publicPlacement.fixed===true||weight<=0)continue;
      for(const destinationIndex of destinations){
        const projected=[...weights];projected[sourceIndex]-=weight;projected[destinationIndex]+=weight;
        if(Math.max(...projected)-Math.min(...projected)>=spread)continue;
        for(const [x,y,z] of rebalanceCandidatePoints(context.states[destinationIndex])){
          const trial=cloneValue(context.states);
          const [relocated]=trial[sourceIndex].placements.splice(placementIndex,1);
          relocated.x=x;relocated.y=y;relocated.z=z;trial[destinationIndex].placements.push(relocated);
          const originalStates=context.states;context.states=trial;
          if(rebalanceValid(context,result)&&(statesPriceable==null||statesPriceable())){
            committed={item_id:moving.item.id,from_container_id:originalStates[sourceIndex].publicContainer.id,to_container_id:originalStates[destinationIndex].publicContainer.id};
            break search
          }
          context.states=originalStates
        }
      }
    }
    if(committed==null)break;
    moves.push(committed)
  }
  return {containers:publicRebalancedContainers(req,context),moves,improved:moves.length>0}
}

// Loading and unloading are deliberately separate public graphs:
// loading follows supporters from an empty scene, unloading follows children from the
// complete scene. All coordinates are exact integer ticks within JS's safe range.
export const ALL_DIRECTIONS=Object.freeze(['+x','-x','+y','-y','+z','-z']);
export class InvalidDirectionError extends RangeError{
  constructor(direction){super(`unknown movement direction ${JSON.stringify(direction)}; expected one of ${ALL_DIRECTIONS.join(', ')}`);this.name='InvalidDirectionError';this.code='invalid_direction';this.direction=direction}
}
export class SequenceError extends Error{
  constructor(stuck){super(`no safe order exists: placements ${[...stuck].sort((a,b)=>a-b).join(', ')} are mutually blocking`);this.name='SequenceError';this.code='sequence_stuck';this.stuck=[...stuck].sort((a,b)=>a-b)}
}
export class SequenceReplayError extends Error{
  constructor(index,step,reason){super(`step ${step}: placement ${index} is not safe there (${reason})`);this.name='SequenceReplayError';this.code='sequence_replay';this.index=index;this.step=step;this.reason=reason}
}
export class SequenceWarning{
  constructor(code,index,messageKey,arguments_={}){this.code=code;this.index=index;this.message_key=messageKey;
    this.arguments=Object.fromEntries(Object.entries(arguments_).sort(([a],[b])=>compareCodePoints(a,b)));Object.freeze(this.arguments);Object.freeze(this)}
  toJSON(){return {code:this.code,index:this.index,message_key:this.message_key,arguments:this.arguments}}
}
function sequenceInteger(value,name){if(!Number.isSafeInteger(value))throw new RangeError(`${name} must be a safe integer tick count`);return value}
function sequenceDimensions(raw,name='dimensions'){return {
  length:sequenceInteger(raw.length,`${name}.length`),width:sequenceInteger(raw.width,`${name}.width`),height:sequenceInteger(raw.height,`${name}.height`)}}
function sequenceBox(raw,index){const origin=raw.origin??{x:raw.x,y:raw.y,z:raw.z},dimensions=raw.dimensions??{length:raw.length,width:raw.width,height:raw.height};
  const d=sequenceDimensions(dimensions,`boxes[${index}].dimensions`);
  return {x:sequenceInteger(origin.x,`boxes[${index}].origin.x`),y:sequenceInteger(origin.y,`boxes[${index}].origin.y`),z:sequenceInteger(origin.z,`boxes[${index}].origin.z`),d}}
function sequenceInputs(boxes,container){if(!Array.isArray(boxes))throw new TypeError('boxes must be an array');return [boxes.map(sequenceBox),sequenceDimensions(container,'container')]}
function validateDirections(directions){for(const direction of directions)if(!ALL_DIRECTIONS.includes(direction))throw new InvalidDirectionError(direction)}
function overlapAreaXY(a,b){return Math.max(0,Math.min(a.x+a.d.length,b.x+b.d.length)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.d.width,b.y+b.d.width)-Math.max(a.y,b.y))}
function sequenceIntersects(a,b){return a.x<b.x+b.d.length&&a.x+a.d.length>b.x&&a.y<b.y+b.d.width&&a.y+a.d.width>b.y&&a.z<b.z+b.d.height&&a.z+a.d.height>b.z}
function loadingDependencies(boxes){return boxes.map((upper,upperIndex)=>boxes.flatMap((lower,lowerIndex)=>
  lowerIndex!==upperIndex&&lower.z+lower.d.height===upper.z&&overlapAreaXY(lower,upper)>0?[lowerIndex]:[]))}
function unloadingDependencies(boxes){const loading=loadingDependencies(boxes),result=boxes.map(()=>[]);loading.forEach((supporters,upper)=>supporters.forEach(lower=>result[lower].push(upper)));return result}
function graphAcyclic(dependsOn){const visiting=new Set(),visited=new Set();function visit(node){if(visited.has(node))return true;if(visiting.has(node)||node<0||node>=dependsOn.length)return false;visiting.add(node);for(const dependency of dependsOn[node])if(!visit(dependency))return false;visiting.delete(node);visited.add(node);return true}return dependsOn.every((_,index)=>visit(index))}
export class LoadingDependencyGraph{
  constructor(dependsOn){this.dependsOn=dependsOn.map(dependencies=>Object.freeze([...dependencies].sort((a,b)=>a-b)));Object.freeze(this.dependsOn)}
  static build(boxes){const [normalized]=sequenceInputs(boxes,{length:0,width:0,height:0});return new LoadingDependencyGraph(loadingDependencies(normalized))}
  isAcyclic(){return graphAcyclic(this.dependsOn)}
}
export class UnloadingDependencyGraph{
  constructor(dependsOn){this.dependsOn=dependsOn.map(dependencies=>Object.freeze([...dependencies].sort((a,b)=>a-b)));Object.freeze(this.dependsOn)}
  static build(boxes){const [normalized]=sequenceInputs(boxes,{length:0,width:0,height:0});return new UnloadingDependencyGraph(unloadingDependencies(normalized))}
  isAcyclic(){return graphAcyclic(this.dependsOn)}
}
function sweptVolume(box,container,direction){let x1=box.x,y1=box.y,z1=box.z,x2=box.x+box.d.length,y2=box.y+box.d.width,z2=box.z+box.d.height;
  if(direction==='+x'){x1=x2;x2=container.length}else if(direction==='-x'){x2=x1;x1=0}
  else if(direction==='+y'){y1=y2;y2=container.width}else if(direction==='-y'){y2=y1;y1=0}
  else if(direction==='+z'){z1=z2;z2=container.height}else if(direction==='-z'){z2=z1;z1=0}
  else throw new InvalidDirectionError(direction);return [x1,y1,z1,x2,y2,z2]}
function clearDirection(index,boxes,present,container,directions){directionLoop:for(const direction of directions){const [x1,y1,z1,x2,y2,z2]=sweptVolume(boxes[index],container,direction);
  for(const otherIndex of present){if(otherIndex===index)continue;const other=boxes[otherIndex];if(x1<other.x+other.d.length&&other.x<x2&&y1<other.y+other.d.width&&other.y<y2&&z1<other.z+other.d.height&&other.z<z2)continue directionLoop}
  return direction}return null}
function blockingIndices(index,boxes,present,container,direction){const [x1,y1,z1,x2,y2,z2]=sweptVolume(boxes[index],container,direction),blocked=[];
  for(const otherIndex of present){if(otherIndex===index)continue;const other=boxes[otherIndex];
    if(x1<other.x+other.d.length&&other.x<x2&&y1<other.y+other.d.width&&other.y<y2&&z1<other.z+other.d.height&&other.z<z2)blocked.push(otherIndex)}
  return blocked}
function validatePermutation(boxes,order){const sorted=[...order].sort((a,b)=>a-b);if(sorted.length!==boxes.length||sorted.some((value,index)=>value!==index))throw new SequenceReplayError(-1,-1,'order is not a permutation of every placement index exactly once')}
function validateSequenceBox(index,step,boxes,present,container){const box=boxes[index];if(box.x<0||box.y<0||box.z<0||box.x+box.d.length>container.length||box.y+box.d.width>container.width||box.z+box.d.height>container.height)throw new SequenceReplayError(index,step,'placement is outside the container');
  if([...present].some(other=>other!==index&&sequenceIntersects(box,boxes[other])))throw new SequenceReplayError(index,step,'placement collides with an already present placement')}
function replayRemovalNormalized(boxes,container,order,directions){validatePermutation(boxes,order);const dependencies=unloadingDependencies(boxes),present=new Set(boxes.map((_,index)=>index));
  order.forEach((index,step)=>{validateSequenceBox(index,step,boxes,present,container);if(dependencies[index].some(dependency=>present.has(dependency)))throw new SequenceReplayError(index,step,'something still resting on it has not been removed yet');if(clearDirection(index,boxes,present,container,directions)==null)throw new SequenceReplayError(index,step,'no allowed direction is clear of the remaining placements');present.delete(index)})}
function replayLoadingNormalized(boxes,container,order,directions){validatePermutation(boxes,order);const dependencies=loadingDependencies(boxes),present=new Set();
  order.forEach((index,step)=>{validateSequenceBox(index,step,boxes,present,container);if(dependencies[index].some(dependency=>!present.has(dependency)))throw new SequenceReplayError(index,step,'a supporter has not been loaded yet');if(clearDirection(index,boxes,present,container,directions)==null)throw new SequenceReplayError(index,step,'no allowed direction is clear of what has already been loaded');present.add(index)})}
export function replayRemovalOrder(boxes,container,order,directions=ALL_DIRECTIONS){validateDirections(directions);const [normalized,dimensions]=sequenceInputs(boxes,container);replayRemovalNormalized(normalized,dimensions,order,directions)}
export function replayLoadingOrder(boxes,container,order,directions=ALL_DIRECTIONS){validateDirections(directions);const [normalized,dimensions]=sequenceInputs(boxes,container);replayLoadingNormalized(normalized,dimensions,order,directions)}
export function safeRemovalOrder(boxes,container,directions=ALL_DIRECTIONS){validateDirections(directions);const [normalized,dimensions]=sequenceInputs(boxes,container),dependencies=unloadingDependencies(normalized),present=new Set(normalized.map((_,index)=>index)),order=[];
  while(present.size){let chosen=null;for(let i=0;i<normalized.length;i++){if(present.has(i)&&dependencies[i].every(dependency=>!present.has(dependency))&&clearDirection(i,normalized,present,dimensions,directions)!=null){chosen=i;break}}if(chosen==null)throw new SequenceError(present);order.push(chosen);present.delete(chosen)}
  replayRemovalNormalized(normalized,dimensions,order,directions);return order}
export function safeLoadingOrder(boxes,container,directions=ALL_DIRECTIONS){const order=safeRemovalOrder(boxes,container,directions).reverse();const [normalized,dimensions]=sequenceInputs(boxes,container);replayLoadingNormalized(normalized,dimensions,order,directions);return order}
export function safeLoadingOrderForPlacements(placements,container,directions=ALL_DIRECTIONS){const dimensions=container.dimensions??container;const order=safeLoadingOrder(placements,dimensions,directions);verifyLoadingPrefixBusinessRules(placements,order,container);return order}
export function safeRemovalOrderWithEvidence(boxes,container,directions=ALL_DIRECTIONS){const order=safeRemovalOrder(boxes,container,directions),[normalized,dimensions]=sequenceInputs(boxes,container),dependencies=unloadingDependencies(normalized),present=new Set(normalized.map((_,index)=>index));
  return order.map(index=>{const step={index,direction:clearDirection(index,normalized,present,dimensions,directions),depends_on:[...dependencies[index]]};present.delete(index);return step})}
export function safeLoadingOrderWithEvidence(boxes,container,directions=ALL_DIRECTIONS){const order=safeLoadingOrder(boxes,container,directions),[normalized,dimensions]=sequenceInputs(boxes,container),dependencies=loadingDependencies(normalized),present=new Set();
  return order.map(index=>{const step={index,direction:clearDirection(index,normalized,present,dimensions,directions),depends_on:[...dependencies[index]]};present.add(index);return step})}
export function placementReachability(boxes,container,stops=null,directions=ALL_DIRECTIONS){
  validateDirections(directions);const [normalized,dimensions]=sequenceInputs(boxes,container);
  if(stops!=null&&(!Array.isArray(stops)||stops.length!==normalized.length))throw new RangeError('stops must contain exactly one entry per placement');
  const route=stops??normalized.map(()=>null),present=new Set(normalized.map((_,index)=>index)),dependencies=unloadingDependencies(normalized);
  const due=route.filter(stop=>stop!=null),earliest=due.length?Math.min(...due):null;
  return normalized.map((box,index)=>{
    const blockedBySupport=dependencies[index].filter(dependency=>present.has(dependency));
    const blockedByRoute=route[index]!=null&&earliest!=null&&route[index]!==earliest
      ?[...present].filter(other=>other!==index&&route[other]!=null&&route[other]<route[index]):[];
    const clear=clearDirection(index,normalized,present,dimensions,directions);
    const blockedByNeighbors=clear==null&&directions.length
      ?[...new Set(directions.flatMap(direction=>blockingIndices(index,normalized,present,dimensions,direction)))].sort((a,b)=>a-b):[];
    return {index,reachable:blockedBySupport.length===0&&blockedByRoute.length===0&&clear!=null,
      blocked_by_support:blockedBySupport,blocked_by_neighbors:blockedByNeighbors,blocked_by_route:blockedByRoute}
  })
}

// Independently reuse the exact constraint calculations already proven for a
// finished scene (overloaded/stackLimitsExceeded/stackDensityExceeded/groundContactAllowed,
// the same functions the solve-time `allowed()` candidate check above uses) against every
// loading *prefix*, not only the final state. Additive to replayLoadingOrder above rather
// than a change to it, so every existing caller keeps working unmodified.
//
// `placements[i]` carries both geometry (`origin`/`dimensions`, the same shape
// `safeLoadingOrder` accepts) and business-rule inputs (`weight`, `max_top_load`,
// `max_stacked_items`, `stackable`, `ground_contact_rule`) -- request-schema field names,
// since request-shaped objects are already this module's external contract style.
//
// Throws SequenceReplayError at the first step whose prefix violates a limit, pinned to
// that step even though these rules only ever accumulate as loading proceeds (a violation
// present at step k is also present in the final scene): identifying *which* addition
// first broke a limit is strictly more useful than "the finished scene is invalid" alone.
export function verifyLoadingPrefixBusinessRules(placements,order,container){
  validatePermutation(placements,order);
  const maxDensity=container.max_stack_density??null,present=[];
  // Any scene may arrive here, validated or not, so the stacking-group rule is re-checked:
  // only when some item declares a list, and only on the new step's own edges, since every
  // earlier edge was judged at its own step.
  const grouped=placements.some(raw=>(raw.accepts_stacking_groups??[]).length>0);
  order.forEach((index,step)=>{
    const raw=placements[index],origin=raw.origin??{x:raw.x,y:raw.y,z:raw.z};
    const dims=raw.dimensions??{length:raw.length,width:raw.width,height:raw.height};
    const d=[sequenceInteger(dims.length,`placements[${index}].dimensions.length`),
             sequenceInteger(dims.width,`placements[${index}].dimensions.width`),
             sequenceInteger(dims.height,`placements[${index}].dimensions.height`)];
    const box={x:sequenceInteger(origin.x,`placements[${index}].origin.x`),
               y:sequenceInteger(origin.y,`placements[${index}].origin.y`),
               z:sequenceInteger(origin.z,`placements[${index}].origin.z`),
               d,ed:d,w:raw.weight??0,maxTop:raw.max_top_load??null,maxStacked:raw.max_stacked_items??null,
               itemType:raw.item_type??null,nesting:raw.nesting_height==null?null:sequenceInteger(raw.nesting_height,`placements[${index}].nesting_height`),
               stackable:raw.stackable??true,item:{groundRule:raw.ground_contact_rule??null},
               stackingGroup:raw.stacking_group??null,accepts:acceptedStackingGroups(raw)};
    present.push(box);
    const needsLoads=maxDensity!=null||present.some(candidate=>candidate.maxTop!=null),graph=contactGraph(present),loads=needsLoads?topLoads(present,graph):null;
    if(overloaded(present,loads))throw new SequenceReplayError(index,step,'top_load_exceeded');
    if(stackLimitsExceeded(present,graph))throw new SequenceReplayError(index,step,'stacked_item_limit_exceeded');
    if(maxDensity!=null&&stackDensityExceeded(present,maxDensity,loads))throw new SequenceReplayError(index,step,'stack_density_exceeded');
    const children=supportChildren(present,graph);
    if(present.some((b,i)=>b.stackable===false&&children[i].length>0))throw new SequenceReplayError(index,step,'non_stackable_item_has_load');
    if(grouped){const last=present.length-1;
      if(graph.supporters[last].some(([k])=>stackingRefusal(present[k],box)!==null)
        ||children[last].some(k=>stackingRefusal(box,present[k])!==null))
        throw new SequenceReplayError(index,step,'stacking_group_incompatible')}
    if(!groundContactAllowed(box,present.slice(0,-1)))throw new SequenceReplayError(index,step,'ground_contact_violation')
  })
}
