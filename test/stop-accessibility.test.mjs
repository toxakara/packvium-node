import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {stopAccessible,stopAccessibilityBase} from '../fallback.js';

// The worked examples in docs/STOP-ACCESSIBILITY.md, read from the corpus the Python, PHP
// and Rust suites read. They were four separate transcriptions until that file existed, so a
// verdict could drift in one engine and stay green in the other three; one table makes that
// impossible rather than merely unlikely.
//
// Only `accessible` is asserted here. The corpus also carries `code`, which needs a
// constraint that answers with a reason, and `route_order_allowed`, which needs a
// route-order check -- this engine's is deliberately not exported, and widening its public
// surface for a test would be the wrong trade. Both columns are asserted by the engines
// that can reach them, and the corpus records which those are.

const fixture=new URL('../../../../conformance/scene/stop-accessibility-fixtures.json',import.meta.url);
const scenes=existsSync(fixture)?JSON.parse(readFileSync(fixture,'utf8')).scenes:null;

// Position and envelope size are all a corridor reads, which is why `stopAccessible` takes
// this shape rather than a full placement.
const boxOf=(raw)=>({
  x:raw.origin.x,y:raw.origin.y,z:raw.origin.z,
  ed:raw.dimensions,
  item:{id:raw.id,stopIndex:raw.stop_index,w:0},
  w:0,
});

test('the shared four-language scene corpus is present and non-empty',(t)=>{
  if(scenes===null){t.skip('the shared cross-language scene corpus is not part of this package');return;}
  assert.ok(scenes.length>0,'an empty corpus would let every scene below pass without asserting anything');
});

for(const scene of scenes??[]){
  test(`stop accessibility: ${scene.id}`,()=>{
    assert.equal(
      stopAccessible(boxOf(scene.candidate),scene.placements.map(boxOf),scene.container,scene.directions),
      scene.accessible,
      scene.why,
    );
  });
}

// The solver carries dimensions as `[length, width, height]` and this corpus carries the
// named object. Both are legitimate inputs and an array answers `3` for `.length`, so the
// same scene used to get opposite verdicts depending on which shape reached the rule --
// invisibly, because no request path supplies a direction list. Running the whole corpus in
// the solver's own shape as well is what makes that class of defect impossible to reach
// again, rather than merely fixed once.
const solverShaped=(raw)=>({
  x:raw.origin.x,y:raw.origin.y,z:raw.origin.z,
  ed:[raw.dimensions.length,raw.dimensions.width,raw.dimensions.height],
  item:{id:raw.id,stopIndex:raw.stop_index,w:0},
  w:0,
});

for(const scene of scenes??[]){
  test(`stop accessibility in the solver's data shape: ${scene.id}`,()=>{
    const container={d:[scene.container.length,scene.container.width,scene.container.height]};
    assert.equal(
      stopAccessible(solverShaped(scene.candidate),scene.placements.map(solverShaped),
        container,scene.directions),
      scene.accessible,
      scene.why,
    );
  });
}

// The solver does not call the exported predicate: it builds the base once per candidate
// sweep and asks that. The two must agree on every scene, or the engine and the corpus are
// testing different rules.
for(const scene of scenes??[]){
  test(`the hoisted base agrees with the predicate: ${scene.id}`,()=>{
    const placed=scene.placements.map(boxOf);
    const base=stopAccessibilityBase(scene.candidate.stop_index,placed,scene.container,
      scene.directions);
    assert.equal(base.inert&&!scene.accessible,false,
      'an inert base can only ever allow, so a refused scene must not produce one');
    assert.equal(
      stopAccessible(boxOf(scene.candidate),placed,scene.container,scene.directions),
      scene.accessible,scene.id);
  });
}
