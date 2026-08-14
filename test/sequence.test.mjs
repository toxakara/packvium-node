import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {
  InvalidDirectionError, LoadingDependencyGraph, SequenceError, SequenceReplayError, SequenceWarning,
  UnloadingDependencyGraph, replayLoadingOrder, safeLoadingOrder, safeLoadingOrderForPlacements,
  safeLoadingOrderWithEvidence, safeRemovalOrder, safeRemovalOrderWithEvidence,
  verifyLoadingPrefixBusinessRules, placementReachability,
} from '../index.js';

const box=(x,y,z,length,width,height)=>({
  origin:{x,y,z},dimensions:{length,width,height},
});

test('loading and unloading use distinct support directions',()=>{
  const boxes=[box(0,0,0,10,10,10),box(0,0,10,10,10,10)];
  const container={length:20,width:20,height:20};
  assert.deepEqual(LoadingDependencyGraph.build(boxes).dependsOn,[[],[0]]);
  assert.deepEqual(safeLoadingOrder(boxes,container),[0,1]);
  assert.deepEqual(safeRemovalOrder(boxes,container),[1,0]);
  assert.deepEqual(safeLoadingOrderWithEvidence(boxes,container),[
    {index:0,direction:'+x',depends_on:[]},
    {index:1,direction:'+x',depends_on:[0]},
  ]);
});

test('the composed loading API never returns an order that breaks a business rule',()=>{
  const placements=[
    {...box(0,0,0,10,10,5),weight:8000000000,max_top_load:4000000000},
    {...box(0,0,5,10,10,5),weight:40000000000},
  ];
  assert.throws(
    ()=>safeLoadingOrderForPlacements(placements,{length:10,width:10,height:20}),
    error=>error instanceof SequenceReplayError&&error.reason==='top_load_exceeded',
  );
});

test('a restricted door produces the deterministic far-first loading order',()=>{
  const boxes=[box(0,0,0,10,10,10),box(10,0,0,10,10,10)];
  assert.deepEqual(safeLoadingOrder(boxes,{length:20,width:10,height:10},['-x']),[1,0]);
});

test('invalid directions and invalid replays are structured',()=>{
  const boxes=[box(0,0,0,10,10,10),box(0,0,10,10,10,10)];
  const container={length:20,width:20,height:20};
  assert.throws(()=>safeLoadingOrder(boxes,container,['sideways']),InvalidDirectionError);
  assert.throws(()=>replayLoadingOrder(boxes,container,[1,0]),error=>
    error instanceof SequenceReplayError&&error.index===1&&error.step===0);
});

test('replay independently rejects outside and colliding geometry',()=>{
  const container={length:20,width:20,height:20};
  assert.throws(()=>replayLoadingOrder([box(15,0,0,10,10,10)],container,[0]),SequenceReplayError);
  assert.throws(()=>replayLoadingOrder([
    box(0,0,0,10,10,10),box(5,0,0,10,10,10),
  ],container,[0,1]),SequenceReplayError);
});

test('shared fixtures pin the canonical graph and evidence across four languages',(t)=>{
  const fixture=new URL('../../../../conformance/scene/sequence-fixtures.json',import.meta.url);
  if(!existsSync(fixture)){t.skip('the shared cross-language scene fixture is not part of this package');return;}
  const payload=JSON.parse(readFileSync(fixture,'utf8'));
  for(const scene of payload.scenes){
    assert.deepEqual(LoadingDependencyGraph.build(scene.boxes).dependsOn,scene.loading_graph,scene.id);
    assert.deepEqual(UnloadingDependencyGraph.build(scene.boxes).dependsOn,scene.unloading_graph,scene.id);
    if(scene.reachability!==undefined){
      assert.deepEqual(placementReachability(scene.boxes,scene.container,scene.stops??null,scene.directions),scene.reachability,scene.id);
    }
    if(scene.expected_error){
      assert.throws(
        ()=>safeLoadingOrder(scene.boxes,scene.container,scene.directions),
        error=>error instanceof SequenceError
          &&assert.deepEqual({code:error.code,stuck:error.stuck},scene.expected_error)===undefined,
      );
      continue;
    }
    if(scene.loading_steps===undefined){
      continue;
    }
    assert.deepEqual(safeLoadingOrderWithEvidence(scene.boxes,scene.container,scene.directions),scene.loading_steps,scene.id);
    assert.deepEqual(safeRemovalOrderWithEvidence(scene.boxes,scene.container,scene.directions),scene.unloading_steps,scene.id);
  }
});

test('sequence step and error shapes match the cross-language canonical JSON',()=>{
  const boxes=[box(0,0,0,10,10,10),box(0,0,10,10,10,10)];
  const container={length:20,width:20,height:20};
  assert.deepEqual(safeLoadingOrderWithEvidence(boxes,container)[1],{index:1,direction:'+x',depends_on:[0]});
  try{
    safeLoadingOrder(boxes,container,['sideways']);
    assert.fail('expected InvalidDirectionError');
  }catch(error){
    assert.equal(error.code,'invalid_direction');
    assert.equal(error.direction,'sideways');
  }
  try{
    replayLoadingOrder(boxes,container,[1,0]);
    assert.fail('expected SequenceReplayError');
  }catch(error){
    assert.equal(error.code,'sequence_replay');
    assert.equal(error.index,1);
    assert.equal(error.step,0);
  }
});

test('sequence warning matches the shared cross-language canonical JSON',(t)=>{
  const fixture=new URL('../../../../conformance/scene/sequence-fixtures.json',import.meta.url);
  if(!existsSync(fixture)){t.skip('the shared cross-language scene fixture is not part of this package');return;}
  const expected=JSON.parse(readFileSync(fixture,'utf8')).dto_contract.sequence_warning;
  assert.deepEqual(new SequenceWarning('sequence_advisory',1,'sequence.advisory',{unit:'mm',clearance:'2'}).toJSON(),expected);
});

// ------------------------------- business-rule prefix replay

const stacked=(x,y,z,side,extra={})=>({origin:{x,y,z},dimensions:{length:side,width:side,height:side},...extra});

test('a loading prefix that overloads a fragile supporter is caught at its step',()=>{
  const placements=[
    stacked(0,0,0,5,{weight:1000,max_top_load:500}),
    stacked(0,0,5,5,{weight:5000}),
  ];
  assert.throws(
    ()=>verifyLoadingPrefixBusinessRules(placements,[0,1],{}),
    error=>error instanceof SequenceReplayError&&error.index===1&&error.step===1&&error.reason==='top_load_exceeded',
  );
});

test('a loading prefix compares cumulative top load beyond 2^53 exactly',()=>{
  const boundary=Number.MAX_SAFE_INTEGER+1;
  const placements=[
    stacked(0,0,0,5,{max_top_load:boundary}),
    stacked(0,0,5,5,{weight:boundary}),
    stacked(0,0,10,5,{weight:1}),
  ];
  assert.doesNotThrow(()=>verifyLoadingPrefixBusinessRules(placements.slice(0,2),[0,1],{}));
  assert.throws(
    ()=>verifyLoadingPrefixBusinessRules(placements,[0,1,2],{}),
    error=>error instanceof SequenceReplayError
      &&error.index===2&&error.step===2&&error.reason==='top_load_exceeded',
  );
});

test('different nesting depths never create a same-type prefix support edge',()=>{
  const lower=stacked(0,0,0,10,{
    item_type:'crate',nesting_height:5,max_top_load:0,
  });
  const upper=stacked(0,0,5,10,{
    item_type:'crate',nesting_height:4,weight:1,
  });

  assert.doesNotThrow(()=>verifyLoadingPrefixBusinessRules([lower,upper],[0,1],{}));
  assert.throws(
    ()=>verifyLoadingPrefixBusinessRules([lower,{...upper,nesting_height:5}],[0,1],{}),
    error=>error instanceof SequenceReplayError&&error.reason==='top_load_exceeded',
  );
});

test('a loading prefix that exceeds a stacked item limit is caught at its step',()=>{
  const placements=[
    stacked(0,0,0,5,{max_stacked_items:1}),
    stacked(0,0,5,5),
    stacked(0,0,10,5),
  ];
  assert.throws(
    ()=>verifyLoadingPrefixBusinessRules(placements,[0,1,2],{}),
    error=>error instanceof SequenceReplayError&&error.index===2&&error.step===2&&error.reason==='stacked_item_limit_exceeded',
  );
});

test('a loading prefix that crushes a containers floor density limit is caught',()=>{
  const placements=[stacked(0,0,0,10,{weight:10000})];
  assert.throws(
    ()=>verifyLoadingPrefixBusinessRules(placements,[0],{max_stack_density:1000}),
    error=>error instanceof SequenceReplayError&&error.index===0&&error.step===0&&error.reason==='stack_density_exceeded',
  );
});

test('a loading prefix that stacks onto a non-stackable item is caught',()=>{
  const placements=[
    stacked(0,0,0,5,{stackable:false}),
    stacked(0,0,5,5),
  ];
  assert.throws(
    ()=>verifyLoadingPrefixBusinessRules(placements,[0,1],{}),
    error=>error instanceof SequenceReplayError&&error.index===1&&error.step===1&&error.reason==='non_stackable_item_has_load',
  );
});

test('a loading prefix that violates a ground contact rule is caught',()=>{
  // "single" requires resting on exactly one supporter; two half-width bases side by
  // side under one full-width rider violate it.
  const placements=[
    stacked(0,0,0,5),
    stacked(5,0,0,5),
    {origin:{x:0,y:0,z:5},dimensions:{length:10,width:5,height:5},ground_contact_rule:'single'},
  ];
  assert.throws(
    ()=>verifyLoadingPrefixBusinessRules(placements,[0,1,2],{}),
    error=>error instanceof SequenceReplayError&&error.index===2&&error.step===2&&error.reason==='ground_contact_violation',
  );
});

test('a loading prefix that respects every business rule raises nothing',()=>{
  const placements=[
    stacked(0,0,0,5,{weight:1000,max_top_load:5000,max_stacked_items:2}),
    stacked(0,0,5,5,{weight:1000}),
  ];
  verifyLoadingPrefixBusinessRules(placements,[0,1],{}); // must not throw
});

test('a malformed business rule order is rejected before any rule check',()=>{
  const placements=[stacked(0,0,0,5)];
  assert.throws(
    ()=>verifyLoadingPrefixBusinessRules(placements,[0,0],{}),
    SequenceReplayError,
  );
});
