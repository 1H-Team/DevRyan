import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stageFMatrices } from './stage-f-preparation.mjs';
import { expandQaMatrix } from './matrix-config.mjs';

test('fresh Stage F is seven wire and two actual native cells with exact desktop geometry', () => {
  const {wire, runtime} = stageFMatrices('.cache/qa/stage-f-test');
  assert.equal(expandQaMatrix(wire).length, 7); assert.equal(expandQaMatrix(runtime).length, 2);
  assert.deepEqual(wire.cells.filter(row=>row.runtime==='electron').map(row=>[row.theme,row.windowSize]),
    [['light',{width:1280,height:800}],['light',{width:800,height:800}],['dark',{width:1280,height:800}],['dark',{width:800,height:800}]]);
  assert.equal(wire.cells.filter(row=>row.scenarioIds.includes('mobile')).length,1);
  assert.ok(runtime.cells.every(row=>row.transport==='runtime-fixture' && row.modelId==='smoke-write'));
  assert.deepEqual(runtime.cells.map(row=>row.runtime),['web','electron']);
  assert.ok([...wire.cells,...runtime.cells].every(row=>row.agent==='builder' && row.variant==='high' && !row.planMode));
});
