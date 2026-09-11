import assert from 'node:assert/strict';
import { evaluate } from './cdp.mjs';

export async function scrollQaHistoryTop(cdp, ui) {
  // Prepending turns preserves the visible anchor and may adjust scroll height
  // after layout. Keep using trusted wheel input until the measured edge, and
  // avoid nested message scrollers that can consume a wheel at the center.
  let lastGeometry;
  await ui.waitFor('history scroll reaches top', async () => {
    lastGeometry = await evaluate(cdp, `(() => {const e=document.querySelector('[data-scrollbar="chat"]');
      if(!e)return null;const r=e.getBoundingClientRect();
      if(e.scrollTop<=1)return{atTop:true};
      for(const x of [r.left+24,r.right-24,r.left+2,r.right-2,r.left+r.width/2]) {
        const y=r.top+r.height/2;let node=document.elementFromPoint(x,y),blocked=false;
        while(node&&node!==e){const s=getComputedStyle(node);
          if(/auto|scroll/.test(s.overflowY)||/contain|none/.test(s.overscrollBehaviorY)){blocked=true;break;}
          node=node.parentElement;}
        if(node===e&&!blocked)return{atTop:false,scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,
          event:{x,y,deltaY:-e.scrollHeight,deltaX:0}};
      }
      return{atTop:false,scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,event:null};})()`);
    assert.ok(lastGeometry, 'Fixture transcript scroll surface is unavailable');
    if (lastGeometry.atTop) return true;
    if (lastGeometry.event) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...lastGeometry.event });
    return false;
  }).catch(error => { throw new Error(`${error.message}; geometry ${JSON.stringify(lastGeometry)}`, { cause: error }); });
}
