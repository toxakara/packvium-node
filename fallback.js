import { appendContactBox, buildContactGraph } from './contact-graph.js';
import { parsePolicy, policyRejection, provesUnplaceable, tagOccurrences } from './policy.js';

const LEN={mm:16000,cm:160000,m:16000000,in:406400,inch:406400,inches:406400,ft:4876800,tick:1,ticks:1};
const WT={g:8000000,kg:8000000000,mg:8000,lb:3628738960,lbs:3628738960,oz:226796185,tick:1,ticks:1};
const ROT={LWH:[0,1,2],LHW:[0,2,1],WLH:[1,0,2],WHL:[1,2,0],HLW:[2,0,1],HWL:[2,1,0]};
const SUPPORT_SCALE=1000000;
const hasOwn=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
function cloneValue(value){
  if(Array.isArray(value))return value.map(cloneValue);
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
  request:[],
  configuration:[],
  // `hull_vertices`, `compression_ratio` and `max_compression_pressure_kpa` left this list
  // in , the last engine to gain both the solver behaviour and the independent
  // validation the staged rollout requires.
  item:[],
  container:[],
  obstacle:[],
  // `item.shape_type` values this engine does not implement. Presence is the
  // wrong test for this one field: `rigid_cuboid` is the default and is implemented, so a
  // caller that spells the default out must be served, not refused. What is unimplemented
  // is a *value*, and the refusal names it -- packing a `convex_hull` item as its bounding
  // box would return a plan that looks valid and does not physically fit.
  // Empty since : this engine implements every value the schema defines. The guard
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
function rejectUnsupported(req){const fields=[];
  for(const key of UNSUPPORTED.request)if(hasOwn(req,key))fields.push(key);
  for(const key of UNSUPPORTED.configuration)if(hasOwn(req.configuration??{},key))fields.push(`configuration.${key}`);
  for(const raw of req.items??[])for(const key of UNSUPPORTED.item)if(hasOwn(raw,key))fields.push(`item.${key}`);
  for(const raw of req.containers??[]){
    for(const key of UNSUPPORTED.container)if(hasOwn(raw,key))fields.push(`container.${key}`);
    for(const obstacle of raw.obstacles??[])for(const key of UNSUPPORTED.obstacle)if(hasOwn(obstacle,key))fields.push(`obstacle.${key}`);
  }
  for(const raw of req.items??[]){const shape=raw?.shape_type;
    if(typeof shape==='string'&&UNSUPPORTED.shapeType.includes(shape))fields.push(`item.shape_type=${shape}`)}
  if(fields.length)throw new UnsupportedFeatureError([...new Set(fields)].sort());
}
function rat(s){s=String(s).trim();if(s.includes(' ')){const [w,f]=s.split(/\s+/,2),[n,d]=f.split('/').map(BigInt),wb=BigInt(w),sg=s.startsWith('-')?-1n:1n,mag=(wb<0n?-wb:wb)*d+n;return [sg*mag,d]}if(s.includes('/')){const[n,d]=s.split('/').map(BigInt);return[n,d]}if(s.includes('.')){const neg=s.startsWith('-'),[a,b]=s.replace(/^[-+]/,'').split('.');const d=10n**BigInt(b.length),n=BigInt(a)*d+BigInt(b);return[neg?-n:n,d]}return[BigInt(s),1n]}
function round(n,d){const sg=n<0n?-1n:1n,a=n<0n?-n:n,q=a/d,r=a%d;const z=r*2n<d?q:r*2n>d?q+1n:q%2n===0n?q:q+1n;return sg*z}
function scalar(v,def,table){let raw=v,unit=def;if(v&&typeof v==='object'){raw=v.value;unit=v.unit??def}else if(typeof v==='string'){const m=v.trim().match(/^(.+?)\s*(millimeters|millimeter|inches|ticks|inch|lbs|tick|mm|cm|ft|in|mg|kg|oz|lb|g|m)$/i);if(m){raw=m[1];unit=m[2]}}const[n,d]=rat(raw);return Number(round(n*BigInt(table[unit.toLowerCase()]),d))}
function dims(v,u){return [scalar(v.length,u,LEN),scalar(v.width,u,LEN),scalar(v.height,u,LEN)]}
function rotate(d,r){return ROT[r].map(i=>d[i])}
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
 *  edge identity and ordering without widening `@packvium/native`'s public API or handing a
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
 *   asks only for soundness -- the bound must never exceed the achieved objective --
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
  return Math.floor(ratio*1000000+0.5);
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
  for(let i=0;i<placements.length;i++)for(let j=i+1;j<placements.length;j++)if(validNesting(placements[i],placements[j]))
    overlap+=BigInt(placements[i].item.nesting)*BigInt(placements[i].ed[0])*BigInt(placements[i].ed[1]);
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
  cells:new Map(),seen:[],gen:0}}
function cellRange(index,box){return [
  Math.floor(box.x/index.cx),ceilDiv(Math.max(box.x+box.d[0],box.x+1),index.cx),
  Math.floor(box.y/index.cy),ceilDiv(Math.max(box.y+box.d[1],box.y+1),index.cy),
  Math.floor(box.z/index.cz),ceilDiv(Math.max(box.z+box.d[2],box.z+1),index.cz)]}
function indexAdd(index,position,box){const [ix1,ix2,iy1,iy2,iz1,iz2]=cellRange(index,box);
  index.seen[position]=0;
  for(let ix=ix1;ix<ix2;ix++)for(let iy=iy1;iy<iy2;iy++)for(let iz=iz1;iz<iz2;iz++){
    const key=cellKey(ix,iy,iz),bucket=index.cells.get(key);
    if(bucket)bucket.push(position);else index.cells.set(key,[position])}}
function copyIndex(index){return {cx:index.cx,cy:index.cy,cz:index.cz,
  cells:new Map([...index.cells].map(([key,bucket])=>[key,bucket.slice()])),
  seen:index.seen.slice(),gen:index.gen}}
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
  const [front,rear]=container.axleSpec;let total=BigInt(container.tare),weighted=BigInt(container.tare)*BigInt(container.d[0]);
  for(const p of placements){const w=BigInt(p.item.w);total+=w;weighted+=w*BigInt(2*p.x+p.ed[0])}
  if(extra){const w=BigInt(extra.item.w);total+=w;weighted+=w*BigInt(2*extra.x+extra.ed[0])}
  const denominator=2n*BigInt(rear.position-front.position);
  return {denominator,front:2n*total*BigInt(rear.position)-weighted,rear:weighted-2n*total*BigInt(front.position)}}
function axleOverloaded(container,placements,extra=null){const reaction=axleReactions(container,placements,extra);if(reaction==null)return false;
  const [front,rear]=container.axleSpec;
  return (front.max!=null&&reaction.front>BigInt(front.max)*reaction.denominator)
    ||(rear.max!=null&&reaction.rear>BigInt(rear.max)*reaction.denominator)}
function overlapXY(a,b){const dx=Math.max(0,Math.min(a.x+a.d[0],b.x+b.d[0])-Math.max(a.x,b.x));const dy=Math.max(0,Math.min(a.y+a.d[1],b.y+b.d[1])-Math.max(a.y,b.y));return dx*dy}
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
function directSupporters(candidate,placed){const dimensions=placementDimensions(candidate);let predecessor=null;
  for(const other of placed){if(other===candidate||other.z>=candidate.z||!sameNestingColumn(other,candidate))continue;
    if(predecessor==null||other.z>=predecessor.z)predecessor=other}
  if(predecessor!=null&&predecessor.z+placementDimensions(predecessor)[2]-candidate.z!==placementNesting(predecessor))predecessor=null;
  const supporters=[];
  for(const other of placed){if(other===candidate)continue;const otherDimensions=placementDimensions(other);
    if(other.z+otherDimensions[2]!==candidate.z)continue;
    const area=overlapXY({x:other.x,y:other.y,z:other.z,d:otherDimensions},{x:candidate.x,y:candidate.y,z:candidate.z,d:dimensions});
    if(area<=0||(predecessor!=null&&sameNestingColumn(other,candidate)))continue;
    supporters.push({placement:other,area})}
  if(predecessor!=null)supporters.push({placement:predecessor,area:dimensions[0]*dimensions[1]});
  return supporters}
// Exact BigInt long division rounded to 8 places, ties to even, matching
// Python's Decimal.quantize default context -- not a float divide, which is neither
// exact for large tick counts nor consistent with the other three engines' rule.
function decimalString(v,divisor,places=8){
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
function outLength(v,u){return {ticks:v,value:decimalString(v,LEN[u]),unit:u}}
function outDims(d,u){return {length:outLength(d[0],u),width:outLength(d[1],u),height:outLength(d[2],u)}}
function outPoint(p,u){return {x:outLength(p.x,u),y:outLength(p.y,u),z:outLength(p.z,u)}}
// JSON has no BigInt scalar, while the established result schema exposes `ticks` as a
// number. Keep the exact integer through every calculation and comparison, render the
// decimal value from it, and convert only the compatibility `ticks` field here.
function outWeight(v,u){const exact=typeof v==='bigint'?v:BigInt(v);return {ticks:Number(exact),value:decimalString(exact,WT[u]),unit:u}}
function proofForReason(reason,details=[]){const level=['no_compatible_container_dimensions','payload_exceeded','rotation_restricted','policy_rule'].includes(reason)?'proven':['time_limit','effort_limit'].includes(reason)?'unknown_due_to_limit':['no_feasible_placement','search_exhausted','exact_search_incomplete'].includes(reason)?'observed':'inferred';return {level,observations:[{code:reason,count:1,details}]}}
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
export class Deadline{constructor(limitMs,clock=Date.now){this.clock=clock;this.started=clock();this.limitMs=Math.max(1,limitMs)}elapsedMs(){return this.clock()-this.started}remainingMs(){return this.limitMs-this.elapsedMs()}expired(){return this.remainingMs()<=0}}

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

function topLoads(boxes,graph=contactGraph(boxes)){const loads=boxes.map(()=>0n);
  const order=boxes.map((b,i)=>i).sort((a,b)=>(boxes[b].z+boxes[b].d[2])-(boxes[a].z+boxes[a].d[2])||boxes[b].z-boxes[a].z||a-b);
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
function routeContactAllowed(candidate,placed,supports){
  // An item without a declared stop rides the whole route. Infinity is the shared
  // PHP/Python/Rust contract. Check only the new relations, as the existing scene was
  // already valid; the one same-column face above may need an O(n) predecessor lookup
  // to distinguish a real face support from a shadowed non-adjacent nested contact.
  const candidateStop=candidate.item.stopIndex??Infinity;
  if(supports.some(({placement})=>candidateStop>(placement.item.stopIndex??Infinity)))return false;
  const dimensions=placementDimensions(candidate);let scene=null;
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
// Inert unless the caller supplies exit directions. The request schema has no field for
// them, and assuming all six walls open would enforce a rule true of no real vehicle and
// nearly vacuous besides -- a box is almost always free through *some* face. This engine
// has no programmatic config path, so the request path always passes the empty list and an
// embedder reaches the rule by calling this function directly, which is as close as
// JavaScript gets to the config field Python, PHP and Rust carry.
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

function allowed(candidate,placed,container,globalSupportPpm,metrics,loadBase=null,accessBase=null){
  const box={x:candidate.x,y:candidate.y,z:candidate.z,d:candidate.ed};
  if(candidate.item.raw.must_be_on_floor&&box.z!==0)return false;
  const tags=candidate.item.tags,bad=candidate.item.incompatible;
  for(const p of placed){
    if(bad.some(t=>p.item.tags.includes(t))||p.item.incompatible.some(t=>tags.includes(t)))return false;
    const other={x:p.x,y:p.y,z:p.z,d:p.ed};
    if(overlapXY(other,box)<=0)continue;
    if(other.z+other.d[2]===box.z&&!p.item.stackable)return false;
    // Sliding underneath is a stacking decision too: nothing may go below an item so
    // that the item comes to rest on a box that refuses to carry anything.
    if(other.z===box.z+box.d[2]&&!candidate.item.stackable)return false;
    if(validNesting(candidate,p)){
      const [lower]=candidate.z<=p.z?[candidate,p]:[p,candidate];
      if(!lower.item.stackable)return false;
    }
  }
  metrics.support_checks++;
  const ratio=Math.max(globalSupportPpm,candidate.item.supportPpm);
  const supports=box.z===0?[]:directSupporters(candidate,placed);
  if(supports.some(({placement})=>placement.item.stackable===false))return false;
  if(box.z!==0&&ratio>0){
    const area=supports.reduce((total,support)=>total+support.area,0);
    if(area<requiredArea(box.d[0]*box.d[1],ratio))return false;
  }
  // constraintBox mirrors item.maxTop/maxStacked verbatim, so both gates are
  // decidable from the items alone; when neither fires, the three skipped checks
  // return false for every box anyway, and building n+1 boxes per feasible
  // candidate was pure allocation.
  const needsLoads=container.maxStackDensity!=null||candidate.item.maxTop!=null||placed.some(p=>p.item.maxTop!=null)
    ||candidate.item.maxCompressionKpa!=null||placed.some(p=>p.item.maxCompressionKpa!=null);
  const needsGraph=needsLoads||candidate.item.maxStacked!=null||placed.some(p=>p.item.maxStacked!=null);
  if(!needsGraph)return groundContactAllowed(candidate,placed,supports)&&routeContactAllowed(candidate,placed,supports)
    &&(accessBase===null||accessibleAgainst(accessBase,corridorBox(candidate)));
  // With a base for this sweep, both the box list and the graph come from it by
  // appending one box, rather than each candidate rebuilding both from every placement.
  // The two paths are required to agree exactly, which is what `contact-graph`'s append
  // property test holds them to.
  const candidateBox=constraintBox(candidate),base=loadBase===null?null:loadBase();
  const boxes=base===null?[...placed.map(constraintBox),candidateBox]:[...base.boxes,candidateBox];
  const graph=base===null?contactGraph(boxes):appendContactBox(base,candidateBox,overlapXY);
  const loads=needsLoads?topLoads(boxes,graph):null;
  return !overloaded(boxes,loads)&&!crushed(boxes,loads)&&!stackLimitsExceeded(boxes,graph)&&!stackDensityExceeded(boxes,container.maxStackDensity,loads)
    &&groundContactAllowed(candidate,placed,supports)&&routeContactAllowed(candidate,placed,supports)
    &&(accessBase===null||accessibleAgainst(accessBase,corridorBox(candidate)));
}

function supportRatioOf(placement,placed){
  if(placement.z===0)return 1;
  const dimensions=placementDimensions(placement),area=directSupporters(placement,placed).reduce((total,support)=>total+support.area,0);
  return area/(dimensions[0]*dimensions[1]);
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

function compactGridResult(req,{u,ou,ow,clear,objective,dimensionalWeight,solverAlias,metrics,effortExceeded,effortRemaining,deadline}){
  // Keep this path opt-in until its capacity-first container choice is
  // proven objective-equivalent to the general path. Admission, effort accounting,
  // injected deadlines and metrics now have direct parity tests; objective quality is
  // the only reason not to use it for coordinate-bearing requests. Materialising the
  // retained lattice in `latticePlacements` is O(count), while compact output remains
  // O(c*r) and keeps regression-many-container-types below the scaling budget.
  const wantCoordinates=req.configuration?.require_placement_coordinates!==false;
  if((solverAlias!=null&&solverAlias!=='grid')||req.items?.length!==1)return null;
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
      ||Object.keys(container.tag_limits??{}).length||container.max_stack_density!=null)return null;
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
  let remaining=quantity,sequence=0,scoreCost=0,scoreUnused=0,scoreHeight=0,scoreBillable=0,scoreLanded=0,scoreAchievedHeight=0;
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
      if(raw.must_be_on_floor||raw.stackable===false)nz=Math.min(nz,1);
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
      sequence++;remaining-=count;metrics.search_nodes_expanded+=count;
      metrics.candidate_points_considered+=count;metrics.orientations_considered+=count;metrics.feasible_candidates+=count;
      containers.push({
        id:`${template.id}#${sequence}`,container_type:template.id,inner_dimensions:outDims(template.d,ou),
        outer_dimensions:outDims(template.outerD,ou),payload_weight:outWeight(payload,ow),
        gross_weight:outWeight(payload+template.tare,ow),used_volume_ticks3:used.toString(),
        volume_utilization:(Number(used)/Number(volume(template.d))).toFixed(6),
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
        :objective==='maximum_value'?[defaultScore[0],remaining*(raw.value??0),defaultScore[1],defaultScore[2],defaultScore[3]]:defaultScore;
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
function withPortfolioEffort(winner,runs){
  const metrics={};
  for(const key of Object.keys(winner.algorithm.metrics))
    metrics[key]=runs.reduce((total,run)=>total+run.algorithm.metrics[key],0);
  return {...winner.algorithm,metrics,
    candidates_evaluated:runs.reduce((total,run)=>total+run.algorithm.candidates_evaluated,0),
    placements_attempted:runs.reduce((total,run)=>total+run.algorithm.placements_attempted,0)}
}
function startRecordId(solverAlias,index){
  const solver=solverAlias?`${solverAlias}:javascript_fallback`:'javascript_fallback';
  return index===0?solver:`${solver}:seeded_${index}`
}
function unstartedRecord(solverAlias,index,globalDeadlineReached){return {
  id:startRecordId(solverAlias,index),started:false,completed:false,truncated:false,selected:false,
  global_deadline_reached:globalDeadlineReached,
}}
export function packFallback(req,clock=Date.now,solverAlias=null,startIndex=null,sharedDeadline=null){rejectUnsupported(req);
const requestedSolvers=req.configuration?.solvers??[],knownSolvers=['grid','extreme_points','homogeneous_blocks','layer','maximal_spaces','exact_small'];
if(!Array.isArray(requestedSolvers)||requestedSolvers.some(name=>!knownSolvers.includes(name)))throw new RangeError(`unknown solver; expected one of ${knownSolvers.join(', ')}`);
const exactItemLimit=req.configuration?.exact_item_limit??7;
const requestedItemCount=(req.items??[]).reduce((total,item)=>total+(item.quantity??1),0);
if(requestedSolvers.includes('exact_small')&&requestedItemCount>exactItemLimit)throw new RangeError('exact-small item limit exceeded');
const effort=req.configuration?.effort_budget??null;
for(const [name,value] of Object.entries(effort??{}))if(!Number.isSafeInteger(value)||value<=0)throw new RangeError(`effort_budget.${name} must be a positive safe integer`);
const multiStartOrders=req.configuration?.multi_start_orders??1;
if(!Number.isSafeInteger(multiStartOrders)||multiStartOrders<1)throw new RangeError('multi_start_orders must be a positive safe integer');
const restartLimit=effort?.max_restarts??Number.MAX_SAFE_INTEGER;
// Every recursive solver/start shares one absolute deadline. Resetting it per child made
// a k-start request consume up to k*time_limit_ms while still reporting one portfolio
// deadline, which is both a determinism and an observability defect.
const deadline=sharedDeadline??new Deadline(req.configuration?.time_limit_ms??1000,clock);
//  second review: the lowest_landed_cost refusal fires once, at the single
// outermost frame, on the packing actually selected for return -- the same choke point
// Rust, Python and PHP refuse at. A child solver/start run instead hands its result
// back sentinel and all, so a portfolio sibling with a priceable answer is not aborted
// by one run's refusal. Idempotent: the quality re-entry finalizes inside its callee.
const finalizeOutermost=result=>{
  if(solverAlias!==null||startIndex!==null)return result;
  if(result.unpriceableDetail!=null)throw unpriceableRefusal(result.unpriceableDetail);
  // Belt and braces behind the portfolio branch's own filter: a sentinel-scored run
  // must never leave the outermost frame by any route.
  if(result.alternatives?.length)result.alternatives=result.alternatives.filter(a=>!a.unpriceableDetail);
  return result
};
if(solverAlias===null&&requestedSolvers.length===0&&(req.configuration?.solver_profile??'balanced')==='quality'){
  const child={...req,configuration:{...(req.configuration??{}),solvers:['homogeneous_blocks','extreme_points','maximal_spaces','layer']}};
  return packFallback(child,clock,null,null,deadline)
}
if(solverAlias===null&&requestedSolvers.length){
  let remainingStarts=restartLimit;
  const plans=[];
  for(const name of requestedSolvers){
    const count=Math.min(name==='homogeneous_blocks'?1:multiStartOrders,remainingStarts);
    if(count<1)break;
    plans.push({name,count});remainingStarts-=count;
  }
  const runs=[];
  for(const plan of plans){
    if(runs.length&&deadline.expired())break;
    const childRequest={...req,configuration:{...(req.configuration??{}),solvers:[],multi_start_orders:plan.count}};
    runs.push(packFallback(childRequest,clock,plan.name,null,deadline));
  }
  let winnerIndex=0;for(let index=1;index<runs.length;index++)if(compareScore(runs[index].score,runs[winnerIndex].score)<0)winnerIndex=index;
  const winner=runs[winnerIndex],globalDeadlineReached=deadline.expired();
  const starts=runs.flatMap((run,index)=>run.termination.starts.map(start=>({...start,
    selected:index===winnerIndex&&start.selected,
    global_deadline_reached:start.global_deadline_reached||globalDeadlineReached,
  })));
  for(const plan of plans.slice(runs.length))
    for(let index=0;index<plan.count;index++)starts.push(unstartedRecord(plan.name,index,globalDeadlineReached));
  winner.termination=aggregateTermination(starts);
  winner.algorithm=withPortfolioEffort(winner,runs);
  const alternativeLimit=Math.max(0,(req.configuration?.alternatives??3)-1);
  // The sentinel is a search device, never an answer -- alternatives included ( review).
  winner.alternatives=runs.filter((run,index)=>index!==winnerIndex&&!run.unpriceableDetail).sort((a,b)=>compareScore(a.score,b.score)).slice(0,alternativeLimit);
  return finalizeOutermost(winner);
}
// This value used to be accepted and never read: raising it produced no extra
// work and no extra start record, so a caller asking for eight restarts got one. Each
// start now genuinely re-solves against its own deterministic ordering and the best
// score wins, which is what `termination.starts` has always claimed to describe.
if(startIndex===null&&multiStartOrders>1){
  const plannedStarts=Math.min(multiStartOrders,restartLimit),runs=[];
  const stagedPlanSearch=(req.configuration?.solver_profile??'balanced')==='quality'&&(req.configuration?.container_plan_beam_width??16)>1;
  for(let index=0;index<plannedStarts;index++){
    if(runs.length&&deadline.expired())break;
    const child=stagedPlanSearch?{...req,configuration:{...(req.configuration??{}),max_candidates_per_item:1,container_plan_beam_width:1,container_plan_node_limit:1}}:req;
    runs.push(packFallback(child,clock,solverAlias,index,deadline));
  }
  if(stagedPlanSearch)for(let index=0;index<2;index++){if(deadline.expired())break;runs.push(packFallback(req,clock,solverAlias,index,deadline))}
  let winnerIndex=0;for(let index=1;index<runs.length;index++)if(compareScore(runs[index].score,runs[winnerIndex].score)<0)winnerIndex=index;
  const winner=runs[winnerIndex],globalDeadlineReached=deadline.expired();
  const plannedRecords=plannedStarts+(stagedPlanSearch?2:0);
  const starts=Array.from({length:plannedRecords},(_,index)=>index<runs.length?{
    ...runs[index].termination.starts[0],id:startRecordId(solverAlias,index),selected:index===winnerIndex,
    global_deadline_reached:runs[index].termination.starts[0].global_deadline_reached||globalDeadlineReached,
  }:unstartedRecord(solverAlias,index,globalDeadlineReached));
  winner.termination=aggregateTermination(starts);
  winner.algorithm=withPortfolioEffort(winner,runs);
  if(winnerIndex>0)winner.algorithm={...winner.algorithm,solver:`${winner.algorithm.solver}:seeded_${winnerIndex}`};
  return finalizeOutermost(winner);
}
const u=req.units?.length??'mm',ou=req.output?.length_unit??u,ow=req.output?.weight_unit??'g',clear=scalar(req.configuration?.clearance??0,u,LEN);
const objective=req.configuration?.objective??'default';if(!['default','lowest_cost','shipping_cost','lowest_landed_cost','open_dimension_height','maximum_value'].includes(objective))throw new RangeError(`unknown objective ${JSON.stringify(objective)}`);
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
const globalSupportPpm=Math.round((req.configuration?.minimum_support_ratio??0)*SUPPORT_SCALE);
const maxCandidatePoints=Math.max(16,req.configuration?.max_candidate_points??4096);
const qualityProfile=(req.configuration?.solver_profile??'balanced')==='quality';
const maxCandidatesPerItem=req.configuration?.max_candidates_per_item??(qualityProfile?16:1);
const containerPlanBeamWidth=req.configuration?.container_plan_beam_width??(qualityProfile?16:1);
const containerPlanNodeLimit=req.configuration?.container_plan_node_limit??(qualityProfile?100000:1);
for(const [name,value] of Object.entries({max_candidates_per_item:maxCandidatesPerItem,container_plan_beam_width:containerPlanBeamWidth,container_plan_node_limit:containerPlanNodeLimit}))
  if(!Number.isSafeInteger(value)||value<1)throw new RangeError(`${name} must be a positive safe integer`);
let timeLimitReached=false;
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
const items=[];for(const raw of req.items){const d=dims(raw.dimensions,u),w=scalar(raw.weight??0,'g',WT),rots=raw.allowed_rotations??(raw.keep_upright?['LWH','WLH']:Object.keys(ROT)),nesting=raw.nesting_height==null?null:scalar(raw.nesting_height,u,LEN);
  for(let i=1;i<=(raw.quantity??1);i++)items.push({raw,d,w,rots,id:`${raw.id}#${i}`,
    stackable:raw.stackable!==false,maxTop:raw.max_top_load==null?null:scalar(raw.max_top_load,'g',WT),
    supportPpm:Math.round((raw.minimum_support_ratio??0)*SUPPORT_SCALE),priority:raw.priority??0,
    tags:raw.tags??[],incompatible:raw.incompatible_tags??[],group:raw.group??null,
    nesting,maxStacked:raw.max_stacked_items??null,groundRule:raw.ground_contact_rule??null,
    stopIndex:raw.stop_index??null,eligibleTags:raw.eligible_container_tags??[],value:raw.value??0,
    ...parseShape(raw,d,u,nesting)})}
// Priority is a preference, not a guarantee: it leads the ordering so a caller can
// bias the search, but ties (the default, priority 0 for all items) fall through to
// the volume key unchanged.
items.sort((a,b)=>{
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
  {const stop=(b.stopIndex??Infinity)-(a.stopIndex??Infinity);if(stop)return stop}
  if(qualityProfile&&(startIndex===null||startIndex===0))return Math.max(...a.d)-Math.max(...b.d)||Number(volume(a.d)-volume(b.d))||a.id.localeCompare(b.id);
  if(qualityProfile&&startIndex===1)return Number(volume(a.d)-volume(b.d))||Math.max(...a.d)-Math.max(...b.d)||a.id.localeCompare(b.id);
  if(solverAlias==='layer')return (b.d[2]-a.d[2])||(b.d[0]*b.d[1]-a.d[0]*a.d[1])||a.id.localeCompare(b.id);
  if(solverAlias==='maximal_spaces')return (Math.max(...b.d)-Math.max(...a.d))||Number(volume(b.d)-volume(a.d))||a.id.localeCompare(b.id);
  // `exact_small` deliberately has no ordering of its own. It used to sort by id, which
  // was harmless while it was greedy-in-disguise and actively harmful once the search
  // became real: smallest-first is the worst descent order, so the first branch failed to
  // pack everything and the bound never pruned.
  return Number(volume(b.d)-volume(a.d))||a.id.localeCompare(b.id);
});
// Start 0 is the ordering above, so a single-start request is byte-identical to what it
// produced before restarts existed; every later start re-solves a shuffle of it.
if(startIndex!==null&&startIndex>0&&(!qualityProfile||startIndex>2))items.splice(0,items.length,...seededOrder(items,req.configuration?.seed??42,startIndex));
const templates=req.containers.map(c=>{const d=dims(c.inner_dimensions,u),axleSpec=c.axles==null?null:c.axles.map(a=>({position:scalar(a.position,u,LEN),max:a.max_load==null?null:scalar(a.max_load,'g',WT)}));
  if(axleSpec&&(axleSpec.length!==2||axleSpec[0].position>=axleSpec[1].position||axleSpec[0].position<0||axleSpec[1].position>d[0]))throw new RangeError('axles must be [front, rear] inside the container');
  if(c.void_fill_reserve_ratio!=null&&(typeof c.void_fill_reserve_ratio!=='number'||!Number.isFinite(c.void_fill_reserve_ratio)))throw new TypeError('void_fill_reserve_ratio must be a finite number');
  const reservePpm=Math.round((c.void_fill_reserve_ratio??0)*SUPPORT_SCALE);if(reservePpm<0||reservePpm>SUPPORT_SCALE)throw new RangeError('void_fill_reserve_ratio must be between 0 and 1');
  if(c.tag_limits!=null&&(typeof c.tag_limits!=='object'||Array.isArray(c.tag_limits)||Object.values(c.tag_limits).some(limit=>!Number.isSafeInteger(limit)||limit<1)))throw new RangeError('tag_limits must map strings to positive safe integers');
  const maxStackDensity=c.max_stack_density==null?null:scalar(c.max_stack_density,'g',WT);if(maxStackDensity!=null&&maxStackDensity<0)throw new RangeError('max_stack_density must be non-negative');
  const outerD=c.outer_dimensions?dims(c.outer_dimensions,u):d;
  // innerVolume/reserve are pure functions of the immutable template, hoisted out of
  // candidatesFor's innermost (point x rotation) loop where they were recomputed as
  // fresh BigInts per orientation.
  return {...c,d,outerD,max:c.max_payload==null?null:scalar(c.max_payload,'g',WT),tare:scalar(c.tare_weight??0,'g',WT),axleSpec,reservePpm,
    innerVolume:volume(d),reserve:volume(d)*BigInt(reservePpm)/BigInt(SUPPORT_SCALE),
    rate:parseRateTable(c.rate_table),tagLimits:c.tag_limits??{},maxStackDensity,
    obs:(c.obstacles??[]).flatMap(o=>[o,...(o.additional_boxes??[])]).map(o=>({x:scalar(o.origin?.x??0,u,LEN),y:scalar(o.origin?.y??0,u,LEN),z:scalar(o.origin?.z??0,u,LEN),d:dims(o.dimensions,u)}))}}).sort((a,b)=>objective==='shipping_cost'||objective==='lowest_landed_cost'?(dimensionalWeight(a.outerD)-dimensionalWeight(b.outerD)||(a.cost_minor??0)-(b.cost_minor??0)||Number(volume(a.d)-volume(b.d))):((a.cost_minor??0)-(b.cost_minor??0)||Number(volume(a.d)-volume(b.d))));
const inventory=new Map(templates.map(c=>[c.id,c.quantity??Infinity])),remaining=[...items],packed=[];let seq=0;
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
const batchesOf=itemsRemaining=>{const batches=[],taken=new Set();
  for(const item of itemsRemaining){if(taken.has(item))continue;
    if(item.group===null){batches.push([item]);taken.add(item);continue}
    const batch=itemsRemaining.filter(other=>other.group===item.group&&!taken.has(other));
    batch.forEach(o=>taken.add(o));batches.push(batch)}
  return batches};
// Every feasible (point, rotation) for `item`, ordered by the solver's own candidate
// score, best first. The greedy path asks for one and takes it; the exact search asks for
// all of them and branches on each, which is the only difference between the two
//. Ties keep insertion order, which is the sorted point order crossed with the
// item's declared rotations -- deterministic without a tiebreak key.
const candidatesFor=(tmpl,item,state,points,index,used,width)=>{
  if(item.eligibleTags.length&&!item.eligibleTags.some(tag=>(tmpl.tags??[]).includes(tag)))return [];
  if(item.tags.some(tag=>tmpl.tagLimits[tag]!=null&&state.placements.filter(p=>p.item.tags.includes(tag)).length>=tmpl.tagLimits[tag]))return [];
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
  const nestingPresent=item.nesting!=null||state.placements.some(p=>p.item.nesting!=null);
  let loadBaseGraph;
  const loadBase=nestingPresent?null:()=>{
    if(loadBaseGraph===undefined){
      // The cell must cover every box hashed into the broad phase or queried against it,
      // and the candidate is a new item that may be wider than anything placed -- so the
      // hint comes from this item's own rotations, which are known here.
      const widest=Math.max(1,...item.rots.flatMap(r=>{const pd=rotate(item.d,r);
        return [pd[0]+2*clear,pd[1]+2*clear]}));
      loadBaseGraph=buildContactGraph(state.placements.map(constraintBox),overlapXY,widest);
    }
    return loadBaseGraph;
  };
  // The same argument, for the other rule that reads the whole placed scene. The
  // doors are empty on every request path today, so this base is inert and costs one pass
  // over the stops -- it is built here rather than inside `allowed` so that wiring the
  // field through later does not silently turn an O(m*|D|) check into O(m^2*|D|) per
  // candidate.
  const accessBase=stopAccessibilityBase(item.stopIndex,state.placements,tmpl,[]);
  const compressionSensitive=item.shapeType==='compressible'
    ||state.placements.some(placement=>placement.item.shapeType==='compressible');
  const found=[];
  const candidates=points.length>maxCandidatePoints?points.slice(0,maxCandidatePoints):points;
  candidatePoints:for(const pt of candidates){if(candidateEffortExceeded())break;metrics.candidate_points_considered++;for(const r of item.rots){if(candidateEffortExceeded())break candidatePoints;metrics.orientations_considered++;if(deadline.expired()){timeLimitReached=true;break candidatePoints}const pd=rotate(item.d,r),ed=pd.map(x=>x+2*clear),box={x:pt[0],y:pt[1],z:pt[2],d:ed};
    if(ed.some((x,k)=>pt[k]+x>tmpl.d[k]))continue;
    if(tmpl.max!=null&&state.payload+item.w>tmpl.max)continue;
    if(tmpl.max_items!=null&&state.placements.length>=tmpl.max_items)continue;
    const tentative={x:pt[0],y:pt[1],z:pt[2],pd,ed,r,item};
    if(!compressionSensitive&&used+usedVolumeDelta(state.placements,tentative)+tmpl.reserve>tmpl.innerVolume)continue;
    let collision=false;
    const candidateShape=item.shapeType==='convex_hull'&&item.stopIndex==null&&clear===0
      ?shapeFor(item.hullVertices,r):null;
    for(const obstacle of tmpl.obs){metrics.collision_checks++;
      if(intersects(box,obstacle)&&solidsOverlap(candidateShape,box,null,obstacle)){collision=true;break}}
    // Broad phase: visit only the placements sharing a cell with `box`, stamping each
    // so a placement spanning several cells is narrow-phase-checked once. A generation
    // counter does that without allocating a set per candidate orientation.
    if(!collision){const [ix1,ix2,iy1,iy2,iz1,iz2]=cellRange(index,box),stamp=++index.gen,tentativeBox={x:pt[0],y:pt[1],z:pt[2],pd,ed,r,item};
      scan:for(let ix=ix1;ix<ix2;ix++)for(let iy=iy1;iy<iy2;iy++)for(let iz=iz1;iz<iz2;iz++){
        const bucket=index.cells.get(cellKey(ix,iy,iz));if(!bucket)continue;
        for(const position of bucket){if(index.seen[position]===stamp)continue;index.seen[position]=stamp;
          const placed=state.placements[position];metrics.collision_checks++;
          const placedBox={x:placed.x,y:placed.y,z:placed.z,d:placed.ed};
          if(intersects(box,placedBox)&&!validNesting(tentativeBox,placed)
            // The axis-aligned test is the broad phase and stays mandatory. Only when a hull
            // is one of the two solids does the exact test get to overrule it, so a request of
            // ordinary boxes never reaches the hull path at all.
            &&solidsOverlap(candidateShape,box,placedHull(placed),placedBox)){collision=true;break scan}}}}
    if(collision)continue;
    const candidate={x:pt[0],y:pt[1],z:pt[2],pd,ed,r,item};
    if(axleOverloaded(tmpl,state.placements,candidate))continue;
    if(!allowed(candidate,state.placements,tmpl,globalSupportPpm,metrics,loadBase,accessBase))continue;
    // With zero load the candidate is at its largest, and appending it can only shrink
    // existing compressible supports. If that upper bound fits, the exact support-graph
    // refresh cannot reject it; only a candidate near the reserve boundary pays the
    // non-local calculation. Ordinary requests retain the incremental O(1) path above.
    if(compressionSensitive){const upperBound=used+occupiedVolume(tentative);
      if(upperBound+tmpl.reserve>tmpl.innerVolume
        &&usedVolume([...state.placements,tentative])+tmpl.reserve>tmpl.innerVolume)continue}
    metrics.feasible_candidates++;
    const score=solverAlias==='grid'
      ?pt[2]*1e12+pt[1]*1e6+pt[0]
      :solverAlias==='layer'
        ?(pt[2]+ed[2])*1e12+pt[2]*1e8+pt[1]*1e4+pt[0]
        :solverAlias==='maximal_spaces'
          ?(pt[0]+ed[0])+(pt[1]+ed[1])+(pt[2]+ed[2])*1e6
          :(pt[2]+ed[2])*1e9+(pt[1]+ed[1])*1e4+pt[0]+ed[0];
    if(width===1){if(!found.length||score<found[0].score)found[0]={score,...candidate};continue}
    found.push({score,...candidate})}}
  if(width===1)return found;
  found.sort((a,b)=>a.score-b.score);
  return width==null?found:found.slice(0,width)
};
const tryPackIntoTemplate=(tmpl,itemsRemaining)=>{const state={tmpl,placements:[],payload:0};const next=[];
  // Running `usedVolume` of `state.placements`, maintained incrementally rather than
  // recomputed per candidate. Kept local to this call, not on `state`, so it
  // cannot leak into the packed container the caller spreads.
  let used=0n;
  const points=[[0,0,0],...tmpl.obs.flatMap(o=>[[o.x+o.d[0],o.y,o.z],[o.x,o.y+o.d[1],o.z],[o.x,o.y,o.z+o.d[2]]])].sort(comparePoints);
  const index=makeIndex(tmpl.d);
  for(const batch of batchesOf(itemsRemaining)){
    const snapshotPlacements=state.placements.slice(),snapshotPayload=state.payload,snapshotUsed=used;
    const snapshotPoints=batch.length>1?points.slice():null,snapshotIndex=batch.length>1?copyIndex(index):null;let ok=true;
    for(const item of batch){
      if(deadline.expired()){timeLimitReached=true;ok=false;break}
      if(effortExceeded()){ok=false;break}
      metrics.search_nodes_expanded++;
      const best=candidatesFor(tmpl,item,state,points,index,used,1)[0];
      if(!best){ok=false;break}
      state.payload+=item.w;
      const compressionSensitive=item.shapeType==='compressible'
        ||state.placements.some(placement=>placement.item.shapeType==='compressible');
      used=compressionSensitive?usedVolume([...state.placements,best]):used+usedVolumeDelta(state.placements,best);
      state.placements.push(best);
      indexAdd(index,state.placements.length-1,{x:best.x,y:best.y,z:best.z,d:best.ed});
      retirePointsForPlacement(points,best);
      for(const point of pointsFrom(best))insertPoint(points,point)}
    if(!ok){state.placements=snapshotPlacements;state.payload=snapshotPayload;used=snapshotUsed;
      if(snapshotPoints)points.splice(0,points.length,...snapshotPoints);
      if(snapshotIndex){index.cells=snapshotIndex.cells;index.seen=snapshotIndex.seen}next.push(...batch)}}
  return {state,next,used}
};
const packBeamIntoTemplate=(tmpl,itemsRemaining)=>{
  const batches=batchesOf(itemsRemaining);
  const fresh=()=>({state:{tmpl,placements:[],payload:0},used:0n,
    points:[[0,0,0],...tmpl.obs.flatMap(o=>[[o.x+o.d[0],o.y,o.z],[o.x,o.y+o.d[1],o.z],[o.x,o.y,o.z+o.d[2]]])].sort(comparePoints),
    index:makeIndex(tmpl.d),unplaced:[]});
  const clone=node=>({state:{tmpl,placements:node.state.placements.slice(),payload:node.state.payload},used:node.used,
    points:node.points.slice(),index:copyIndex(node.index),unplaced:node.unplaced.slice()});
  const place=(node,candidate)=>{node.state.payload+=candidate.item.w;
    const compressionSensitive=candidate.item.shapeType==='compressible'
      ||node.state.placements.some(placement=>placement.item.shapeType==='compressible');
    node.used=compressionSensitive?usedVolume([...node.state.placements,candidate]):node.used+usedVolumeDelta(node.state.placements,candidate);
    node.state.placements.push(candidate);indexAdd(node.index,node.state.placements.length-1,{x:candidate.x,y:candidate.y,z:candidate.z,d:candidate.ed});
    retirePointsForPlacement(node.points,candidate);for(const point of pointsFrom(candidate))insertPoint(node.points,point)};
  const sortCosts=costs=>costs.sort((a,b)=>a<b?-1:a>b?1:0);
  const maxCount=(sortedCosts,capacity)=>{let used=0n,count=0;for(const cost of sortedCosts){if(used+cost>capacity)break;used+=cost;count++}return count};
  // `future` is the same array for every comparison inside one `expansions.sort(...)`
  // call, so its sorted volume/weight arrays are hoisted by the caller and
  // passed in here -- falls back to sorting on the fly for the trivial future=[] call
  // sites below, which never reach the sort's cost. Reused arrays are read-only:
  // `maxCount` no longer sorts in place.
  const lowerBound=(node,future,sortedVolumes=null,sortedWeights=null)=>{let possible=future.length;
    if(!future.some(item=>item.nesting!=null))possible=Math.min(possible,maxCount(sortedVolumes??sortCosts(future.map(item=>volume(item.d))),volume(tmpl.d)-node.used));
    if(tmpl.max!=null)possible=Math.min(possible,maxCount(sortedWeights??sortCosts(future.map(item=>BigInt(item.w))),BigInt(Math.max(0,tmpl.max-node.state.payload))));
    return node.unplaced.length+future.length-possible};
  const compareNode=(a,b,future=[],sortedVolumes=null,sortedWeights=null)=>{let difference=lowerBound(a,future,sortedVolumes,sortedWeights)-lowerBound(b,future,sortedVolumes,sortedWeights);if(difference)return difference;
    difference=a.unplaced.length-b.unplaced.length;if(difference)return difference;
    difference=b.state.placements.length-a.state.placements.length;if(difference)return difference;
    const az=a.state.placements.reduce((z,p)=>Math.max(z,p.z+p.ed[2]),0),bz=b.state.placements.reduce((z,p)=>Math.max(z,p.z+p.ed[2]),0);
    if(az!==bz)return az-bz;if(a.used!==b.used)return a.used>b.used?-1:1;
    const signature=node=>node.state.placements.map(p=>`${p.item.id}@${p.x},${p.y},${p.z}`).join('|');return signature(a).localeCompare(signature(b))};
  const greedy=tryPackIntoTemplate(tmpl,itemsRemaining);let beam=[fresh()],incumbent=fresh();incumbent.state=greedy.state;incumbent.used=greedy.used;incumbent.unplaced=greedy.next;let nodes=0;
  for(let position=0;position<batches.length;position++){
    const batch=batches[position],future=batches.slice(position+1).flat(),expansions=[];let exhausted=false;
    for(const node of beam){if(nodes>=containerPlanNodeLimit||deadline.expired()||effortExceeded()){exhausted=true;break}nodes++;metrics.search_nodes_expanded++;
      const children=[];
      if(batch.length===1){for(const candidate of candidatesFor(tmpl,batch[0],node.state,node.points,node.index,node.used,maxCandidatesPerItem)){
        const child=clone(node);place(child,candidate);children.push(child)}}else{
        const child=clone(node);let accepted=true;for(const item of batch){const candidate=candidatesFor(tmpl,item,child.state,child.points,child.index,child.used,1)[0];if(!candidate){accepted=false;break}place(child,candidate)}if(accepted)children.push(child)}
      expansions.push(...children);const skipped=clone(node);skipped.unplaced.push(...batch);expansions.push(skipped)}
    // The incumbent is only ever compared and returned (state + unplaced); it never
    // re-enters the beam, so cloning the candidate points and spatial index for it
    // was pure allocation per expansion.
    for(const node of expansions){const complete={state:{tmpl,placements:node.state.placements.slice(),payload:node.state.payload},used:node.used,unplaced:[...node.unplaced,...future]};if(compareNode(complete,incumbent)<0)incumbent=complete}
    if(!expansions.length||exhausted)break;
    const futureVolumes=future.some(item=>item.nesting!=null)?null:sortCosts(future.map(item=>volume(item.d)));
    const futureWeights=tmpl.max!=null?sortCosts(future.map(item=>BigInt(item.w))):null;
    expansions.sort((a,b)=>compareNode(a,b,future,futureVolumes,futureWeights));beam=expansions.slice(0,containerPlanBeamWidth)}
  beam.sort((a,b)=>compareNode(a,b));if(beam.length&&compareNode(beam[0],incumbent)<0)incumbent=beam[0];
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
  const freshWork=()=>({state:{tmpl,placements:[],payload:0},used:0n,
    points:[[0,0,0],...tmpl.obs.flatMap(o=>[[o.x+o.d[0],o.y,o.z],[o.x,o.y+o.d[1],o.z],[o.x,o.y,o.z+o.d[2]]])].sort(comparePoints),
    index:makeIndex(tmpl.d)});
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
    if(batch.length===1)return candidatesFor(tmpl,batch[0],w.state,w.points,w.index,w.used,null)
      .map(candidate=>{const child=cloneWork(w);placeInto(child,candidate);return child});
    const child=cloneWork(w);
    for(const item of batch){
      const best=candidatesFor(tmpl,item,child.state,child.points,child.index,child.used,1)[0];
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
    volume:volume(item.d),weight:item.w,
    minimumHeight:Math.min(...item.rots.map(rotation=>rotate(item.d,rotation)[2]+2*clear)),
  }]));
  const suffixItems=Array.from({length:batches.length+1},()=>[]);
  for(let index=batches.length-1;index>=0;index--)suffixItems[index]=[...batches[index],...suffixItems[index+1]];
  const ascendingBigInts=values=>values.sort((a,b)=>a<b?-1:a>b?1:0);
  // Lexicographic lower bound for every descendant of `work`. Volume and payload cap
  // how many suffix items can still be placed. If that count can tie the incumbent, the
  // largest possible used volume and the smallest possible stack top / billed weight
  // bound the remaining objective terms. Nesting disables the additive-volume terms.
  // Per node this is O(n log n) time and O(n) temporary space, strictly below the
  // existing O(n^2) canonical score computation and inside the exponential search tree.
  const optimisticCompletionScore=(work,future)=>{
    if(work.state.placements.length===0&&future.length===0)return [0,0,0,0,0];
    const containerVolume=volume(tmpl.d),nestingInvolved=work.state.placements.some(p=>p.item.nesting!=null)||future.some(item=>item.nesting!=null);
    const volumes=ascendingBigInts(future.map(item=>profiles.get(item.id).volume));
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
    const permanentlySkipped=itemsRemaining.length-work.state.placements.length-future.length;
    const unpackedFloor=permanentlySkipped+future.length-placeable;
    if(placeable===0&&work.state.placements.length===0)return [unpackedFloor,0,0,0,0];
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
    const billable=objective==='shipping_cost'||objective==='lowest_landed_cost'?Math.max(grossWeight,dimensionalWeight(tmpl.outerD)):0;
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
    return [unpackedFloor,1,cost,unused,height]
  };
  let best=freshWork(),bestRank=rankedWork(best);
  const completeLowerBound=optimisticCompletionScore(freshWork(),suffixItems[0]);
  const dfs=(depth,work,reachable)=>{
    if(deadline.expired()){timeLimitReached=true;return}
    if(effortExceeded())return;
    metrics.search_nodes_expanded++;
    const unpackedHere=itemsRemaining.length-work.state.placements.length;
    if(unpackedHere<=bestRank[0]){const workRank=rankedWork(work);if(compareScore(workRank,bestRank)<0){best=work;bestRank=workRank}}
    if(compareScore(bestRank,completeLowerBound)===0)return;
    if(depth>=batches.length)return;
    if(work.state.placements.length+reachable<best.state.placements.length)return;
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
// containerPlanNodeLimit bound it exactly as in Python, PHP and Rust.
const homogeneousBlocksSupported=()=>policyRules.length===0&&templates.every(t=>!t.obs.length&&t.axleSpec==null
    &&Object.keys(t.tagLimits).length===0&&t.maxStackDensity==null&&t.reservePpm===0)
  &&items.every(i=>i.group==null&&!i.tags.length&&!i.incompatible.length&&!i.eligibleTags.length
    &&i.stackable&&!i.raw.must_be_on_floor&&i.maxTop==null&&i.maxStacked==null
    &&i.supportPpm===0&&(i.groundRule==null||i.groundRule==='free')&&i.nesting==null&&i.stopIndex==null);
const compareBlockValue=(a,b)=>typeof a==='bigint'?(a<b?-1:a>b?1:0):typeof a==='string'?a.localeCompare(b):a-b;
const compareBlockKey=(a,b)=>{for(let i=0;i<a.length;i++){const difference=compareBlockValue(a[i],b[i]);if(difference)return difference}return 0};
const containsSpace=(outer,inner)=>outer.x<=inner.x&&outer.y<=inner.y&&outer.z<=inner.z
  &&outer.x+outer.d[0]>=inner.x+inner.d[0]&&outer.y+outer.d[1]>=inner.y+inner.d[1]&&outer.z+outer.d[2]>=inner.z+inner.d[2];
// `spaces` is containment-free (a single whole space or this function's own output),
// so a survivor untouched by the carve can neither contain nor be contained by
// another survivor, and a new slab cannot contain one either (the slab's own parent
// could not); only new slabs need the dominance scan: O(new*s) instead of O(s^2).
const subtractBlock=(spaces,box)=>{metrics.space_partitions+=spaces.length;const out=[],fresh=new Set();
  const push=(x,y,z,X,Y,Z)=>{if(X>x&&Y>y&&Z>z){const part={x,y,z,d:[X-x,Y-y,Z-z]};out.push(part);fresh.add(part)}};
  for(const space of spaces){const X=space.x+space.d[0],Y=space.y+space.d[1],Z=space.z+space.d[2],bX=box.x+box.d[0],bY=box.y+box.d[1],bZ=box.z+box.d[2];
    if(!intersects(space,box)){out.push(space);continue}
    push(space.x,space.y,space.z,Math.min(X,box.x),Y,Z);push(Math.max(space.x,bX),space.y,space.z,X,Y,Z);
    push(space.x,space.y,space.z,X,Math.min(Y,box.y),Z);push(space.x,Math.max(space.y,bY),space.z,X,Y,Z);
    push(space.x,space.y,space.z,X,Y,Math.min(Z,box.z));push(space.x,space.y,Math.max(space.z,bZ),X,Y,Z)}
  const unique=new Map(out.map(space=>[[space.x,space.y,space.z,...space.d].join(':'),space]));
  const kept=[...unique.values()].sort((a,b)=>a.z-b.z||a.y-b.y||a.x-b.x||(volume(a.d)>volume(b.d)?-1:1));
  let result=kept.filter((space,index)=>!fresh.has(space)||!kept.some((other,otherIndex)=>index!==otherIndex&&containsSpace(other,space)));
  if(result.length>256)result=result.sort((a,b)=>volume(a.d)>volume(b.d)?-1:volume(a.d)<volume(b.d)?1:a.z-b.z||a.y-b.y||a.x-b.x).slice(0,256).sort((a,b)=>a.z-b.z||a.y-b.y||a.x-b.x);
  return result};
const blockMode=(tmpl,itemsRemaining,volumeFirst)=>{let spaces=[{x:0,y:0,z:0,d:tmpl.d.slice()}],nodes=0,reached=false;
  const byType=new Map();for(const item of itemsRemaining){const values=byType.get(item.raw.id)??[];values.push(item);byType.set(item.raw.id,values)}
  const state={tmpl,placements:[],payload:0};
  while(spaces.length&&[...byType.values()].some(values=>values.length)){
    let best=null;
    spacesLoop:for(const space of spaces)for(const itemId of [...byType.keys()].sort()){
      const available=byType.get(itemId);if(!available.length)continue;const prototype=available[0];
      let capacity=available.length;if(tmpl.max_items!=null)capacity=Math.min(capacity,tmpl.max_items-state.placements.length);
      if(tmpl.max!=null&&prototype.w>0)capacity=Math.min(capacity,Math.floor(Math.max(0,tmpl.max-state.payload)/prototype.w));
      if(capacity<=0)continue;
      const seen=new Set();for(const rotation of prototype.rots){const pd=rotate(prototype.d,rotation),physicalKey=pd.join(':');if(seen.has(physicalKey))continue;seen.add(physicalKey);
        const ed=pd.map(edge=>edge+2*clear),maximumX=Math.floor(space.d[0]/ed[0]),maximumY=Math.floor(space.d[1]/ed[1]),maximumZ=Math.floor(space.d[2]/ed[2]);
        for(let nx=1;nx<=Math.min(maximumX,capacity);nx++)for(let ny=1;ny<=Math.min(maximumY,Math.floor(capacity/nx));ny++){
          if(nodes>=containerPlanNodeLimit||deadline.expired()||effortExceeded()){reached=true;break spacesLoop}
          nodes++;metrics.search_nodes_expanded++;const nz=Math.min(maximumZ,Math.floor(capacity/(nx*ny)));if(nz<=0)continue;
          const count=nx*ny*nz,used=BigInt(count)*volume(pd),fill=used*1000000n/volume(space.d);
          const lead=volumeFirst?[-used,-fill,-BigInt(count)]:[-BigInt(count),-fill,-used];
          const key=[...lead,space.z,space.y,space.x,itemId,rotation,nx,ny,nz],candidate={space,itemId,rotation,pd,ed,nx,ny,nz,count,key};
          if(best==null||compareBlockKey(key,best.key)<0)best=candidate}}}
    if(best==null||reached)break;
    const available=byType.get(best.itemId),chosen=available.splice(0,best.count);let index=0;
    for(let z=0;z<best.nz;z++)for(let y=0;y<best.ny;y++)for(let x=0;x<best.nx;x++){
      const placement={x:best.space.x+x*best.ed[0],y:best.space.y+y*best.ed[1],z:best.space.z+z*best.ed[2],pd:best.pd,ed:best.ed,r:best.rotation,item:chosen[index++]};
      state.placements.push(placement);state.payload+=placement.item.w;metrics.feasible_candidates++;metrics.orientations_considered++}
    spaces=subtractBlock(spaces,{x:best.space.x,y:best.space.y,z:best.space.z,d:[best.nx*best.ed[0],best.ny*best.ed[1],best.nz*best.ed[2]]})}
  const next=[...byType.keys()].sort().flatMap(key=>byType.get(key));return {state,next,reached}}
const packBlocksIntoTemplate=(tmpl,itemsRemaining)=>{if(!homogeneousBlocksSupported())return tryPackIntoTemplate(tmpl,itemsRemaining);
  let best=null;for(const volumeFirst of [false,true]){if(deadline.expired()){timeLimitReached=true;break}const candidate=blockMode(tmpl,itemsRemaining,volumeFirst);if(candidate.reached&&deadline.expired())timeLimitReached=true;
    const used=usedVolume(candidate.state.placements),top=candidate.state.placements.reduce((z,p)=>Math.max(z,p.z+p.ed[2]),0),signature=candidate.state.placements.map(p=>`${p.item.id}@${p.x},${p.y},${p.z}`).join('|'),key=[candidate.next.length,-used,top,signature];
    if(best==null||compareBlockKey(key,best.key)<0)best={...candidate,key}}
  return best??{state:{tmpl,placements:[],payload:0},next:itemsRemaining.slice()}}
const packIntoTemplate=solverAlias==='exact_small'?packExactIntoTemplate:solverAlias==='homogeneous_blocks'?packBlocksIntoTemplate:containerPlanBeamWidth>1?packBeamIntoTemplate:tryPackIntoTemplate;
const planScore=(plan,unpacked=plan.remaining)=>{let cost=0,unused=0,height=0,billable=0,landed=0,achieved=0;
  for(const state of plan.packed){cost+=state.tmpl.cost_minor??0;const inner=volume(state.tmpl.d),used=usedVolume(state.placements);unused+=Number((inner-used)*1000000n/inner);
    const top=state.placements.reduce((z,p)=>Math.max(z,p.z+p.ed[2]),0);height+=Number(BigInt(top)*1000000n/BigInt(state.tmpl.d[2]));achieved+=top;
    if(objective==='shipping_cost'||objective==='lowest_landed_cost'){
      const billed=Math.max(state.payload+state.tmpl.tare,dimensionalWeight(state.tmpl.outerD));
      if(objective==='shipping_cost')billable+=billed;else landed=addLanded(landed,state.tmpl,billed)}}
  const base=[unpacked.length,plan.packed.length,cost,unused,height];
  if(objective==='lowest_cost')return [base[0],base[2],base[1],base[3],base[4]];
  if(objective==='shipping_cost')return [base[0],billable,base[1],base[3],base[4]];
  if(objective==='lowest_landed_cost')return [base[0],landed,base[1],base[3],base[4]];
  if(objective==='open_dimension_height')return [base[0],achieved,base[1],base[2],base[3]];
  if(objective==='maximum_value')return [base[0],unpacked.reduce((sum,item)=>sum+(item.value??0),0),base[1],base[2],base[3]];
  return base};
const additionalContainerBound=plan=>{const available=templates.filter(t=>plan.inventory.get(t.id)>0);if(!plan.remaining.length||!available.length)return 0;let lower=0;
  if(!plan.remaining.some(item=>item.nesting!=null)){const capacity=available.reduce((best,t)=>volume(t.d)>best?volume(t.d):best,0n),required=plan.remaining.reduce((sum,item)=>sum+volume(item.d),0n);if(capacity>0n)lower=Math.max(lower,Number((required+capacity-1n)/capacity))}
  if(available.every(t=>t.max!=null)){const capacity=Math.max(...available.map(t=>t.max)),required=plan.remaining.reduce((sum,item)=>sum+item.w,0);if(capacity>0)lower=Math.max(lower,Math.ceil(required/capacity))}return lower};
const planBound=(plan)=>{const key=planScore(plan,[]),index=objective==='default'?1:2;key[index]+=additionalContainerBound(plan);return key};
if(containerPlanBeamWidth>1&&solverAlias!=='exact_small'){
  const initial={packed:[],remaining:remaining.slice(),inventory:new Map(inventory),seq:0};let beam=[initial],incumbent=initial,planNodes=0;
  while(beam.length&&planNodes<containerPlanNodeLimit){const expansions=[];let exhausted=false;
    for(const plan of beam){if(!plan.remaining.length||plan.packed.length>=maxContainers){if(compareScore(planScore(plan),planScore(incumbent))<0)incumbent=plan;continue}
      for(const tmpl of templates){if(planNodes>=containerPlanNodeLimit)break;if(deadline.expired()||effortExceeded()){exhausted=true;break}if(plan.inventory.get(tmpl.id)<=0)continue;planNodes++;
        const trial=packIntoTemplate(tmpl,plan.remaining);if(!trial.state.placements.length)continue;const nextInventory=new Map(plan.inventory);nextInventory.set(tmpl.id,nextInventory.get(tmpl.id)-1);
        const child={packed:[...plan.packed,{...trial.state,seq:plan.seq+1}],remaining:trial.next,inventory:nextInventory,seq:plan.seq+1};expansions.push(child);if(compareScore(planScore(child),planScore(incumbent))<0)incumbent=child}
      if(exhausted)break}
    if(exhausted||!expansions.length)break;
    const dominant=new Map();for(const plan of expansions){const signature=`${plan.remaining.map(i=>i.id).join('|')}::${[...plan.inventory.entries()].sort().map(([k,v])=>`${k}:${v}`).join('|')}`;
      const previous=dominant.get(signature);if(!previous||compareScore(planScore(plan,[]),planScore(previous,[]))<0)dominant.set(signature,plan)}
    beam=[...dominant.values()].sort((a,b)=>compareScore(planBound(a),planBound(b))||a.remaining.map(i=>i.id).join('|').localeCompare(b.remaining.map(i=>i.id).join('|'))).slice(0,containerPlanBeamWidth)}
  packed.push(...incumbent.packed);remaining.splice(0,remaining.length,...incumbent.remaining);seq=incumbent.seq;
}else while(remaining.length&&packed.length<maxContainers){
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
    const trial=packIntoTemplate(tmpl,remaining);
    if(!trial.state.placements.length)continue;
    let score,better;
    // `lowest_landed_cost` ranks the round in money: the trial's charge first, then
    // estimated rounds remaining, then progress -- the key order Rust, Python and PHP
    // use. `planScore`'s finished vector leads with unpacked count, which is
    // right for whole plans but inverted for one round: an unpriceable-but-roomier
    // trial out-ranked a priceable one on progress, refusing or over-paying requests
    // the other three engines ship. The greedy loop commits the trial verbatim, so
    // its billed weight is final here and the tariff can be read now; an unpriceable
    // trial still sorts behind every priceable alternative via `addLanded`'s sentinel.
    if(objective==='lowest_landed_cost'){
      const placed=trial.state.placements.length;
      const billed=Math.max(trial.state.payload+tmpl.tare,dimensionalWeight(tmpl.outerD));
      score=[addLanded(0,tmpl,billed),Math.ceil(remaining.length/Math.max(placed,1)),-placed];
      const comparison=winnerScore==null?-1:compareScore(score,winnerScore);
      better=comparison<0||(comparison===0&&tmpl.id<winner.tmpl.id)
    }else if(solverAlias==='exact_small'){
      score=planScore({packed:[trial.state],remaining:trial.next});
      const comparison=winnerScore==null?-1:compareScore(score,winnerScore);
      better=comparison<0||(comparison===0&&tmpl.id<winner.tmpl.id)
    }else{
      const used=usedVolume(trial.state.placements),innerVol=volume(tmpl.d);
      score=[-trial.state.placements.length,tmpl.cost_minor??0,Number(innerVol-used),tmpl.id];
      better=winnerScore==null||score[0]<winnerScore[0]
        ||(score[0]===winnerScore[0]&&(score[1]<winnerScore[1]
        ||(score[1]===winnerScore[1]&&(score[2]<winnerScore[2]
        ||(score[2]===winnerScore[2]&&score[3]<winnerScore[3])))))
    }
    if(better){winner={tmpl,...trial};winnerScore=score}
  }
  if(!winner)break;
  inventory.set(winner.tmpl.id,inventory.get(winner.tmpl.id)-1);
  seq++;packed.push({...winner.state,seq});
  remaining.splice(0,remaining.length,...winner.next);
}
const containers=packed.map(c=>{const loads=topLoads(c.placements.map(constraintBox)),used=usedVolume(c.placements);
  const reaction=axleReactions(c.tmpl,c.placements);
  return {id:`${c.tmpl.id}#${c.seq}`,container_type:c.tmpl.id,inner_dimensions:outDims(c.tmpl.d,ou),outer_dimensions:outDims(c.tmpl.outer_dimensions?dims(c.tmpl.outer_dimensions,u):c.tmpl.d,ou),payload_weight:outWeight(c.payload,ow),gross_weight:outWeight(c.payload+c.tmpl.tare,ow),used_volume_ticks3:used.toString(),volume_utilization:(Number(used)/Number(volume(c.tmpl.d))).toFixed(6),centre_of_mass_offset_ppm:centreOfMassOffsetPpm(c.tmpl,c.placements,clear),...(reaction==null?{}:{axle_reactions:{basis:'gross',denominator:reaction.denominator.toString(),front_numerator:reaction.front.toString(),rear_numerator:reaction.rear.toString()}}),void_fill_reserve_ticks3:(volume(c.tmpl.d)*BigInt(c.tmpl.reservePpm)/BigInt(SUPPORT_SCALE)).toString(),placements:c.placements.map((p,i)=>({item_id:p.item.id,item_type:p.item.raw.id,position:outPoint({x:p.x+clear,y:p.y+clear,z:p.z+clear},ou),dimensions:outDims(p.pd,ou),orientation:p.r,support_ratio:supportRatioOf(p,c.placements).toFixed(6),top_load:outWeight(loads[i],ow)}))}});
const fitsWithRotations=(i,rots)=>templates.some(c=>rots.some(r=>{const d=rotate(i.d,r).map(x=>x+2*clear);return d.every((edge,k)=>edge<=c.d[k])}));
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
  const reason=!fitsAnyRotation?'no_compatible_container_dimensions':!dimensionFit?'rotation_restricted':!weightFit?'payload_exceeded':!eligibleFit?'no_eligible_container':cited!==null?'policy_rule':timeLimitReached?'time_limit':effortExceeded()?'effort_limit':i.group!==null?'group_cannot_fit_together':'search_exhausted',details=reason==='policy_rule'?[cited]:[];
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
    const billed=Math.max(c.payload+c.tmpl.tare,dimensionalWeight(c.tmpl.outerD));
    if(objective==='shipping_cost')scoreBillable+=billed;else scoreLanded=addLanded(scoreLanded,c.tmpl,billed);}}
// The search ranks an unpriceable packing worst so that any priceable alternative beats
// it; reaching here means none existed in this run. Returning such a packing would
// quote a number the carrier never published -- the one outcome `chargeMinor` refuses
// to invent -- so the refusal fires, but once, at the outermost frame, on the packing
// actually selected for return: a portfolio sibling with a priceable answer must not be
// aborted by this run's refusal. Rust, Python and PHP refuse at the same single choke
// point ( second review). The detail rides the result as a non-enumerable property
// below, a search device that never serializes.
let unpriceableDetail=null;
if(objective==='lowest_landed_cost')for(const c of packed){
  const grams=billedGrams(Math.max(c.payload+c.tmpl.tare,dimensionalWeight(c.tmpl.outerD))),table=c.tmpl.rate;
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
const defaultScore=[unpacked.length,containers.length,scoreCost,scoreUnused,scoreHeight],score=objective==='lowest_cost'?[defaultScore[0],defaultScore[2],defaultScore[1],defaultScore[3],defaultScore[4]]:objective==='shipping_cost'?[defaultScore[0],scoreBillable,defaultScore[1],defaultScore[3],defaultScore[4]]:objective==='lowest_landed_cost'?[defaultScore[0],scoreLanded,defaultScore[1],defaultScore[3],defaultScore[4]]:objective==='open_dimension_height'?[defaultScore[0],scoreAchievedHeight,defaultScore[1],defaultScore[2],defaultScore[3]]:objective==='maximum_value'?[defaultScore[0],scoreValueForgone,defaultScore[1],defaultScore[2],defaultScore[3]]:defaultScore;
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
  const globalSupportPpm=Math.round((req.configuration?.minimum_support_ratio??0)*SUPPORT_SCALE);
  const items=new Map();
  for(const raw of req.items??[]){
    const d=dims(raw.dimensions,unit),w=scalar(raw.weight??0,'g',WT);
    for(let sequence=1;sequence<=(raw.quantity??1);sequence++)items.set(`${raw.id}#${sequence}`,{
      raw,d,w,id:`${raw.id}#${sequence}`,
      rots:raw.allowed_rotations??(raw.keep_upright?['LWH','WLH']:Object.keys(ROT)),
      stackable:raw.stackable!==false,maxTop:raw.max_top_load==null?null:scalar(raw.max_top_load,'g',WT),
      supportPpm:Math.round((raw.minimum_support_ratio??0)*SUPPORT_SCALE),
      tags:raw.tags??[],incompatible:raw.incompatible_tags??[],group:raw.group??null,
      nesting:raw.nesting_height==null?null:scalar(raw.nesting_height,unit,LEN),
      maxStacked:raw.max_stacked_items??null,groundRule:raw.ground_contact_rule??null,
      stopIndex:raw.stop_index??null,eligibleTags:raw.eligible_container_tags??[],
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
    const template={...raw,d,outerD:raw.outer_dimensions?dims(raw.outer_dimensions,unit):d,
      max:raw.max_payload==null?null:scalar(raw.max_payload,'g',WT),
      tare:scalar(raw.tare_weight??0,'g',WT),axleSpec,
      reservePpm:Math.round((raw.void_fill_reserve_ratio??0)*SUPPORT_SCALE),
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
      return {x:position.x-clear,y:position.y-clear,z:position.z-clear,pd,ed:pd.map(edge=>edge+2*clear),
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
    const placed=[];
    for(const candidate of [...state.placements].sort((a,b)=>a.z-b.z||a.y-b.y||a.x-b.x||a.item.id.localeCompare(b.item.id))){
      if(!allowed(candidate,placed,state.tmpl,context.globalSupportPpm,{support_checks:0}))return false;
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
  const outputLength=req.output?.length_unit??req.units?.length??'mm',outputWeight=req.output?.weight_unit??'g';
  return context.states.map(state=>{
    const loads=topLoads(state.placements.map(constraintBox));
    const payload=state.placements.reduce((total,placement)=>total+placement.item.w,0);
    const used=usedVolume(state.placements),reaction=axleReactions(state.tmpl,state.placements);
    const container={...state.publicContainer,payload_weight:outWeight(payload,outputWeight),
      gross_weight:outWeight(payload+state.tmpl.tare,outputWeight),used_volume_ticks3:used.toString(),
      volume_utilization:(Number(used)/Number(volume(state.tmpl.d))).toFixed(6),
      centre_of_mass_offset_ppm:centreOfMassOffsetPpm(state.tmpl,state.placements,context.clear),
      placements:state.placements.map((placement,index)=>({...placement.publicPlacement,
        position:outPoint({x:placement.x+context.clear,y:placement.y+context.clear,z:placement.z+context.clear},outputLength),
        dimensions:outDims(placement.pd,outputLength),orientation:placement.r,
        support_ratio:supportRatioOf(placement,state.placements).toFixed(6),
        top_load:outWeight(loads[index],outputWeight),
      })),
    };
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
  //  second review: under `lowest_landed_cost` a move is a re-pricing -- shifting
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
      const moving=context.states[sourceIndex].placements[placementIndex],weight=moving.item.w;if(weight<=0)continue;
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
    this.arguments=Object.fromEntries(Object.entries(arguments_).sort(([a],[b])=>a.localeCompare(b)));Object.freeze(this.arguments);Object.freeze(this)}
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
  while(present.size){const chosen=[...present].sort((a,b)=>a-b).find(index=>dependencies[index].every(dependency=>!present.has(dependency))&&clearDirection(index,normalized,present,dimensions,directions)!=null);if(chosen==null)throw new SequenceError(present);order.push(chosen);present.delete(chosen)}
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
               stackable:raw.stackable??true,item:{groundRule:raw.ground_contact_rule??null}};
    present.push(box);
    const needsLoads=maxDensity!=null||present.some(candidate=>candidate.maxTop!=null),graph=contactGraph(present),loads=needsLoads?topLoads(present,graph):null;
    if(overloaded(present,loads))throw new SequenceReplayError(index,step,'top_load_exceeded');
    if(stackLimitsExceeded(present,graph))throw new SequenceReplayError(index,step,'stacked_item_limit_exceeded');
    if(maxDensity!=null&&stackDensityExceeded(present,maxDensity,loads))throw new SequenceReplayError(index,step,'stack_density_exceeded');
    const children=supportChildren(present,graph);
    if(present.some((b,i)=>b.stackable===false&&children[i].length>0))throw new SequenceReplayError(index,step,'non_stackable_item_has_load');
    if(!groundContactAllowed(box,present.slice(0,-1)))throw new SequenceReplayError(index,step,'ground_contact_violation')
  })
}
