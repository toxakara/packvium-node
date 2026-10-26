import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Count actual parser executions without adding production instrumentation. Reintroducing
// a raw model parser in a frame makes the work grow with the portfolio again.
const sourceUrl=new URL('../fallback.js',import.meta.url);
const rawSource=fs.readFileSync(sourceUrl,'utf8');
const parserNeedle='function scalar(v,def,table){';
assert.equal(rawSource.split(parserNeedle).length-1,1,'scalar instrumentation must match exactly once');
const source=rawSource.replace(/from '(\.\/[^']+)'/g,
  (_,specifier)=>`from '${new URL(specifier,sourceUrl).href}'`)
  .replace(parserNeedle,parserNeedle+'globalThis.__requestMeasureParses++;');
const {packFallback}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('made-to-measure input parsing does not grow with portfolio starts',()=>{
  // Keep the package test independent of the workspace conformance tree.
  const sides=value=>({length:String(value),width:String(value),height:String(value)});
  const fixture={units:{length:'mm'},configuration:{minimum_support_ratio:1,
    effort_budget:{max_candidates_evaluated:1000000,max_placement_attempts:1000000,max_search_nodes:1000000}},
    items:[{id:'cube',quantity:8,weight:'100',dimensions:sides(100)}],
    containers:[{id:'machine',cost_minor:40,inner_dimensions:sides(1510),made_to_measure:{
      minimum:sides(60),increment:sides(25),cost_per_square_metre_minor:1000,
      outer_allowance:sides(3),tare_per_square_metre:'500'}}]};
  const counts=[];
  for(const starts of [1,4]){
    const request=structuredClone(fixture);
    request.configuration={...request.configuration,solver_profile:'quality',multi_start_orders:starts,time_limit_ms:300000};
    globalThis.__requestMeasureParses=0;
    const result=packFallback(request);
    assert.ok(['feasible','optimal'].includes(result.status));
    assert.ok(globalThis.__requestMeasureParses>0,'instrumentation must observe real parser work');
    counts.push(globalThis.__requestMeasureParses);
  }
  assert.equal(counts[1],counts[0],'machine input measures must come from the request table');
  delete globalThis.__requestMeasureParses;
});
