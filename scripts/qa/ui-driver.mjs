import { evaluate } from './cdp.mjs';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const visible = `e => { const r=e.getBoundingClientRect(); if(r.width<=0||r.height<=0)return false;for(let p=e;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)<0.95)return false;}return true; }`;

export const isQaReadOnlyRevealHit = (target, hit, allowDisabled, pointerEvents) => Boolean(target && hit
  && (target.contains(hit) || (allowDisabled && target.disabled === true && pointerEvents === 'none' && hit === target.parentElement)));

export const isQaRevealRectVisible = (rect, bounds, fullyVisible) => Boolean(rect
  && rect.top+rect.height/2>bounds.top+8 && rect.top+rect.height/2<bounds.bottom-8
  && rect.left+rect.width/2>=bounds.left && rect.left+rect.width/2<=bounds.right
  && (!fullyVisible || (rect.top>=bounds.top && rect.bottom<=bounds.bottom && rect.left>=bounds.left && rect.right<=bounds.right)));

export function createQaUiDriver(cdp, { timeoutMs = 30000, checkAlive = () => {} } = {}) {
  const waitFor = async (label, predicate, timeout = timeoutMs) => {
    const deadline = performance.now() + timeout;
    while (true) {
      checkAlive();
      const result = await predicate();
      if (result) return result;
      if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
      await delay(100);
    }
  };
  const waitExpression = (label, expression, timeout) => waitFor(label, () => evaluate(cdp, expression), timeout);
  const waitVisibleText = (text, selector = 'body') => waitExpression(`visible text ${text}`, `(() => {
    const root=document.querySelector(${JSON.stringify(selector)}); if(!root) return false;
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    for(let node=walker.nextNode();node;node=walker.nextNode()) {
      if(!node.textContent.includes(${JSON.stringify(text)})) continue;
      let visible=true;
      for(let e=node.parentElement;e;e=e.parentElement) {
        const style=getComputedStyle(e);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)<0.95){visible=false;break;}
      }
      if(!visible)continue; const range=document.createRange();range.selectNodeContents(node);
      for(const r of range.getClientRects()) {
        let left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);
        for(let e=node.parentElement;e;e=e.parentElement) {
          const s=getComputedStyle(e),clip=e.getBoundingClientRect();
          if(/hidden|clip|auto|scroll/.test(s.overflowX)){left=Math.max(left,clip.left);right=Math.min(right,clip.right);}
          if(/hidden|clip|auto|scroll/.test(s.overflowY)){top=Math.max(top,clip.top);bottom=Math.min(bottom,clip.bottom);}
        }
        if(right-left>0&&bottom-top>0)return true;
      }
    }
    return false;
  })()`);
  const pointer = async (point, { touch = false } = {}) => {
    if (touch) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    }
  };
  const click = async ({ label, text, selector = 'button,[role="button"],[role="menuitem"],[role="option"]', exact = true, touch = false }) => {
    const point = await waitExpression(`visible control ${label ?? text ?? selector}`, `(async () => {
      const matches=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(${visible}).filter(e=>!e.disabled);
      const expected=${JSON.stringify(label ?? text ?? '')};
      const target=matches.find(e=>{const value=${label !== undefined ? "e.getAttribute('aria-label')||''" : "e.innerText?.trim()||''"}; return ${label === undefined && text === undefined ? 'true' : exact ? 'value===expected' : 'value.includes(expected)'};});
      if(!target) return null; target.scrollIntoView({block:'nearest'}); const before=target.getBoundingClientRect();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const r=target.getBoundingClientRect();if(Math.abs(r.x-before.x)>0.5||Math.abs(r.y-before.y)>0.5)return null;
      const point={x:r.x+r.width/2,y:r.y+r.height/2};const hit=document.elementFromPoint(point.x,point.y);
      if(!hit||!target.contains(hit))return null;return point;
    })()`);
    await pointer(point, { touch });
  };
  const key = async (key, { code = key, modifiers = 0, windowsVirtualKeyCode } = {}) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, ...(windowsVirtualKeyCode ? { windowsVirtualKeyCode } : {}) });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, ...(windowsVirtualKeyCode ? { windowsVirtualKeyCode } : {}) });
  };
  const type = async (text, selector = 'textarea', { replace = true } = {}) => {
    await waitExpression(`input ${selector}`, `(() => {const e=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(${visible}).find(e=>!e.disabled);if(!e)return false;e.focus();return document.activeElement===e;})()`);
    if (replace) await key('a', { code: 'KeyA', modifiers: process.platform === 'darwin' ? 4 : 2, windowsVirtualKeyCode: 65 });
    await cdp.send('Input.insertText', { text });
    await waitExpression('input content committed', `document.activeElement?.value===${JSON.stringify(text)}`);
  };
  const send = async (text) => { await type(text); await click({ label: 'Send Message' }); };
  const reveal = (selector, text, { scrollContainer, direction = 'up', allowDisabled = false, fullyVisible = false } = {}) => waitFor(`scroll control into viewport ${text ?? selector}`, async () => {
    const geometry = await evaluate(cdp, `(() => {
      const target=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(${visible})
        .find(e=>${text === undefined ? 'true' : `e.innerText?.trim()===${JSON.stringify(text)}`});
      let scroll=target?.parentElement;
      while(scroll&&!(scroll.scrollHeight>scroll.clientHeight+1&&/auto|scroll/.test(getComputedStyle(scroll).overflowY)))scroll=scroll.parentElement;
      if(!target)scroll=${scrollContainer ? `document.querySelector(${JSON.stringify(scrollContainer)})` : 'null'};
      if(!scroll){if(!target)return null;scroll=document.scrollingElement;}
      const s=scroll.getBoundingClientRect();
      const left=Math.max(0,s.left),right=Math.min(innerWidth,s.right),top=Math.max(0,s.top),bottom=Math.min(innerHeight,s.bottom);
      if(right<=left||bottom<=top)return null;
      const centerY=(top+bottom)/2;
      const r=target?.getBoundingClientRect();
      const center=r?{x:r.left+r.width/2,y:r.top+r.height/2}:null;
      const hit=center?document.elementFromPoint(center.x,center.y):null;
      const hitOwned=(${isQaReadOnlyRevealHit.toString()})(target,hit,${allowDisabled},target?getComputedStyle(target).pointerEvents:undefined);
      if((${isQaRevealRectVisible.toString()})(r,{left,right,top,bottom},${fullyVisible})&&hitOwned)return{visible:true};
      let destinationY=centerY;
      if(center&&Math.abs(center.y-centerY)<=2&&hit&&!target.contains(hit)) {
        for(let node=hit;node&&node!==scroll;node=node.parentElement) {
          if(!['sticky','fixed'].includes(getComputedStyle(node).position))continue;
          const belowHeader=Math.min(bottom-28,node.getBoundingClientRect().bottom+24);
          if(belowHeader>center.y+8&&belowHeader<bottom-8)destinationY=belowHeader;
          break;
        }
      }
      let point;
      for(const y of [centerY,top+24,bottom-24]) {
        for(const x of [left+24,right-24,left+2,right-2,(left+right)/2]) {
          if(x<=left||x>=right||y<=top||y>=bottom)continue;
          let node=document.elementFromPoint(x,y),blocked=false;
          while(node&&node!==scroll) {
            const style=getComputedStyle(node);
            if(/auto|scroll/.test(style.overflowY)||/contain|none/.test(style.overscrollBehaviorY)){blocked=true;break;}
            node=node.parentElement;
          }
          if(node===scroll&&!blocked){point={x,y};break;}
        }
        if(point)break;
      }
      if(!point)return null;
      return{visible:false,...point,deltaY:center?Math.max(-500,Math.min(500,center.y-destinationY)):${direction === 'up' ? '-500' : '500'}};
    })()`);
    if (!geometry) return false;
    if (geometry.visible) return true;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: geometry.x, y: geometry.y,
      deltaX: 0, deltaY: geometry.deltaY });
    return false;
  });
  const revealText = async (text, selector, options) => {
    const target = await waitExpression(`text target ${text}`, `(() => {
      const root=document.querySelector(${JSON.stringify(selector)});if(!root)return null;
      const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
      for(let node=walker.nextNode();node;node=walker.nextNode()) {
        const leaf=node.parentElement;
        if(!node.textContent.includes(${JSON.stringify(text)})||!(${visible})(leaf))continue;
        const parts=[];
        for(let e=leaf;e&&e!==root;e=e.parentElement)parts.unshift(e.tagName.toLowerCase()+':nth-child('+([...e.parentElement.children].indexOf(e)+1)+')');
        return ${JSON.stringify(selector)}+(parts.length?' > '+parts.join(' > '):'');
      }
      return null;
    })()`);
    await reveal(target, undefined, options);
    await waitVisibleText(text, selector);
  };
  const reload = async () => {
    const loaded = cdp.waitFor('Page.loadEventFired');
    await cdp.send('Page.reload');
    await loaded;
    await waitExpression('composer after reload', `Boolean(document.querySelector('textarea'))`);
  };
  const attach = async (files) => {
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"]' });
    if (!nodeId) throw new Error('Attachment file input is unavailable');
    await cdp.send('DOM.setFileInputFiles', { nodeId, files });
  };
  const inspectControls = () => evaluate(cdp, `[...document.querySelectorAll('button,[role="button"],[role="menuitem"],input')].filter(${visible}).map(e=>({role:e.getAttribute('role'),label:e.getAttribute('aria-label'),text:e.innerText?.slice(0,120),placeholder:e.getAttribute('placeholder')})).slice(-100)`);
  return { waitFor, waitExpression, waitVisibleText, click, key, type, send, reveal, revealText, reload, attach, inspectControls, pointer };
}
