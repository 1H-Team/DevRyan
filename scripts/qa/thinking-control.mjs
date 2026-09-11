import assert from 'node:assert/strict';
import { evaluate } from './cdp.mjs';

const slider = '[role="slider"][aria-label="Thinking Level"]';
const stateExpression = `(() => {const e=[...document.querySelectorAll('${slider}')].find(e=>e.getBoundingClientRect().width>0);
  return e?{level:e.closest('[data-thinking-level]')?.getAttribute('data-thinking-level'),index:Number(e.getAttribute('aria-valuenow')),
    maximum:Number(e.getAttribute('aria-valuemax')),focused:document.activeElement===e}:null;})()`;

// Operate the current accessible widget with real pointer/keyboard events.
// Never turn a missing/default choice into a different model effort.
export async function selectQaThinkingLevel({ cdp, ui, value, open = true, close = true, trigger = 'button.model-controls__variant-trigger' }) {
  assert.ok(typeof value === 'string' && value, 'A current chat thinking choice must be explicit');
  if (open) await ui.click({ selector: trigger });
  const initial = await ui.waitExpression('visible thinking slider', stateExpression);
  assert.ok(Number.isSafeInteger(initial.maximum) && initial.maximum >= 0 && initial.maximum < 20, 'Thinking slider bounds are invalid');
  await ui.click({ selector: slider });
  await ui.waitExpression('thinking slider focused', `(${stateExpression}).focused`);
  await ui.key('Home', { code: 'Home', windowsVirtualKeyCode: 36 });
  await ui.waitExpression('first thinking detent committed', `(${stateExpression}).index===0`);
  let selected;
  for (let index = 0; index <= initial.maximum; index++) {
    selected = await evaluate(cdp, stateExpression);
    if (selected.level === value) break;
    if (index === initial.maximum) throw new Error(`Pinned thinking level is unavailable in the current control: ${value}`);
    await ui.key('ArrowRight', { code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await ui.waitExpression('next thinking detent committed', `(${stateExpression}).index===${index + 1}`);
  }
  assert.equal(selected.level, value);
  if (close) {
    await ui.key('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 });
    await ui.waitExpression('thinking slider closed', `!(${stateExpression})`);
  }
  return selected;
}
