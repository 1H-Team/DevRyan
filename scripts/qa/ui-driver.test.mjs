import assert from 'node:assert/strict';
import test from 'node:test';
import { isQaReadOnlyRevealHit, isQaRevealRectVisible } from './ui-driver.mjs';

test('read-only reveal accepts a disabled pointer-transparent button only through its own immediate parent', () => {
  const parent = {}, child = {}, overlay = {};
  const target = { disabled:true,parentElement:parent,contains:hit=>hit===child };
  assert.equal(isQaReadOnlyRevealHit(target,parent,true,'none'),true);
  assert.equal(isQaReadOnlyRevealHit(target,parent,false,'none'),false);
  assert.equal(isQaReadOnlyRevealHit(target,overlay,true,'none'),false);
  assert.equal(isQaReadOnlyRevealHit(target,parent,true,'auto'),false);
  assert.equal(isQaReadOnlyRevealHit({...target,disabled:false},parent,true,'none'),false);
  assert.equal(isQaReadOnlyRevealHit(target,null,true,'none'),false);
  assert.equal(isQaReadOnlyRevealHit(null,parent,true,'none'),false);
});

test('normal read-only reveal retains direct target ownership without a disabled exception', () => {
  const child = {}, parent = {};
  const target = { disabled:false,parentElement:parent,contains:hit=>hit===child };
  assert.equal(isQaReadOnlyRevealHit(target,child,false,'auto'),true);
  assert.equal(isQaReadOnlyRevealHit(target,parent,false,'auto'),false);
});

test('full control reveal rejects a clipped button even when its center is visibly inside the chat viewport', () => {
  const bounds={left:0,right:200,top:100,bottom:200};
  const visible={left:10,right:110,top:120,bottom:152,width:100,height:32};
  assert.equal(isQaRevealRectVisible(visible,bounds,true),true);
  for(const clipped of [{...visible,top:94,bottom:126},{...visible,top:174,bottom:206},{...visible,left:-2,right:98}]) {
    assert.equal(isQaRevealRectVisible(clipped,bounds,false),true);
    assert.equal(isQaRevealRectVisible(clipped,bounds,true),false);
  }
});
