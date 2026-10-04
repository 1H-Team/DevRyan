import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createQaUiDriver, isQaReadOnlyRevealHit, isQaRevealRectVisible } from './ui-driver.mjs';

const driverPage = (options = {}) => {
  const rect = { x: 10, y: 10, left: 10, right: 130, top: 10, bottom: 40, width: 120, height: 30 };
  const parent = { parentElement: null, getBoundingClientRect: () => rect, opacity: options.ancestorOpacity ?? '1' };
  const target = { parentElement: parent, disabled: options.disabled ?? false, innerText: 'Builder',
    opacity: options.opacity ?? '1', display: options.display ?? 'block', visibility: options.visibility ?? 'visible',
    getBoundingClientRect: () => options.zeroGeometry ? { ...rect, width: 0 } : rect,
    getAttribute: () => null, scrollIntoView() {}, contains: hit => hit === target };
  const inputs = [];
  const document = { querySelectorAll: () => [target], querySelector: () => target,
    elementFromPoint: () => options.covered ? parent : target,
    createTreeWalker: () => { let first = true; return { nextNode: () => {
      if (!first) return null;
      first = false; return { textContent: 'Builder', parentElement: target };
    } }; }, createRange: () => ({ selectNodeContents() {}, getClientRects: () => [rect] }) };
  const cdp = { send: async (method, params) => {
    if (method === 'Runtime.evaluate') return { result: { value: await runInNewContext(params.expression, {
      document, innerWidth: 800, innerHeight: 600, NodeFilter: { SHOW_TEXT: 4 },
      requestAnimationFrame: callback => callback(),
      getComputedStyle: node => ({ display: node.display ?? 'block', visibility: node.visibility ?? 'visible',
        opacity: node.opacity, overflowX: 'visible', overflowY: 'visible' }),
    }) } };
    inputs.push({ method, params }); return {};
  } };
  return { ui: createQaUiDriver(cdp, { timeoutMs: options.timeoutMs ?? 30000 }), inputs };
};

test('actual driver click, inspection and visible text accept visible hover opacity on target and ancestors', async () => {
  for (const options of [{ opacity: '0.7' }, { ancestorOpacity: '0.7' }]) {
    const { ui, inputs } = driverPage(options);
    assert.equal((await ui.inspectControls()).some(control => control.text === 'Builder'), true);
    await ui.waitVisibleText('Builder', '#target');
    await ui.click({ selector: '#target' });
    assert.deepEqual(inputs.map(input => input.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  }
});

test('actual visible-text wait rejects transparent target and ancestor', async () => {
  for (const options of [{ opacity: '0' }, { ancestorOpacity: '0' }]) {
    const { ui } = driverPage({ ...options, timeoutMs: 1 });
    await assert.rejects(ui.waitVisibleText('Builder', '#target'), /Timed out: visible text Builder/);
  }
});

test('actual driver keeps transparent, hidden, absent geometry, disabled and covered controls unclickable', async () => {
  for (const options of [{ opacity: '0' }, { ancestorOpacity: '0' }, { visibility: 'hidden' },
    { display: 'none' }, { zeroGeometry: true }, { disabled: true }, { covered: true }]) {
    const { ui, inputs } = driverPage(options);
    await assert.rejects(ui.click({ selector: '#target', timeout: 1 }), /Timed out: visible control #target/);
    assert.deepEqual(inputs, []);
  }
});

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
