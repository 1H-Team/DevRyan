import assert from 'node:assert/strict';
import { evaluate } from './cdp.mjs';
import { createQaUiDriver } from './ui-driver.mjs';

const catalogs = [
  ['fixture-model', 'Fixture model', ['low', 'medium', 'high', 'xhigh']],
  ['thinking-three', 'Thinking three', ['low', 'medium', 'high']],
  ['thinking-two', 'Thinking two', ['low', 'high']],
  ['thinking-one', 'Thinking one', ['high']],
  ['thinking-zero', 'Thinking zero', []],
  ['thinking-five', 'Thinking five', ['minimal', 'low', 'medium', 'high', 'max']],
];
export const thinkingModels = Object.fromEntries(catalogs.map(([id, name, levels]) => [id, {
  id, name, limit: { context: 100_000, output: 10_000 }, reasoning: levels.length > 0,
  variants: Object.fromEntries(levels.map(level => [level, { reasoningEffort: level }])),
}]));
thinkingModels['fixture-model-fast'] = { ...thinkingModels['fixture-model'], id: 'fixture-model-fast', name: 'Fixture model Fast' };

export async function runThinkingSliderQa({ cdp, fixture, runtime, check, screenshot }) {
  const ui = createQaUiDriver(cdp);
  const slider = '.thinking-slider [role="slider"]';
  const trigger = '.model-controls__variant-trigger';
  const result = { catalogs: [], captures: [], interaction: {}, liveProvider: false };
  const dismiss = async () => {
    await ui.key('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 });
    await ui.waitExpression('thinking popup closed', `!document.querySelector('[aria-label="Thinking Options"]')`);
  };
  const read = () => evaluate(cdp, `(() => {
    const e=document.querySelector(${JSON.stringify(slider)}); if(!e)return null;
    const r=e.getBoundingClientRect();const thumb=e.querySelector('[data-thinking-thumb]');
    const box=thumb?.getBoundingClientRect();
    return {level:e.getAttribute('aria-valuetext'),max:Number(e.getAttribute('aria-valuemax')),disabled:e.getAttribute('aria-disabled'),
      x:r.x+10,y:r.y+r.height/2,width:r.width-20,thumb:box?{width:box.width,height:box.height,centerX:box.x+box.width/2,radius:getComputedStyle(thumb).borderRadius}:null,
      overflow:document.documentElement.scrollWidth>innerWidth+1};
  })()`);
  const open = async () => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
    await ui.click({ selector: trigger });
    await ui.waitExpression('thinking slider visible and focused', `document.querySelector(${JSON.stringify(slider)})?.getBoundingClientRect().width>0 && document.activeElement?.matches(${JSON.stringify(slider)})`);
  };
  const setModel = async name => {
    await ui.click({ selector: '.model-controls__model-trigger' });
    await ui.click({ text: name, exact: false, selector: '[role="menu"] [class~="group/model-row"]' });
    await ui.waitExpression(`selected ${name}`, `document.querySelector('.model-controls__model-trigger')?.textContent.includes(${JSON.stringify(name)})`);
  };
  const pointer = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });

  await check('thinking catalogs expose only native stops', async () => {
    for (const [id, name, levels] of catalogs) {
      await setModel(name);
      if (!levels.length) {
        assert.equal(await evaluate(cdp, `Boolean(document.querySelector(${JSON.stringify(trigger)}))`), false);
        result.catalogs.push({ id, stops: 0 });continue;
      }
      await open();
      const state = await read();
      assert.equal(state.max, levels.length - 1);
      assert.equal(state.disabled, levels.length === 1 ? 'true' : 'false');
      assert.equal(state.thumb.width, 20);assert.equal(state.thumb.height, 20);
      assert.equal(state.overflow, false);
      assert.equal(await evaluate(cdp, `document.querySelector('[aria-label="Thinking Options"]').textContent.includes('Default')`), false);
      await screenshot(`thinking-${levels.length}-stops`);
      result.catalogs.push({ id, stops: levels.length, state });
      await dismiss();
    }
  });
  await setModel('Fixture model');
  await open();
  await check('thinking pointer resistance, snap, release, keyboard and focus', async () => {
    await ui.key('Home', { windowsVirtualKeyCode: 36 });
    await ui.key('ArrowRight', { windowsVirtualKeyCode: 39 });
    await ui.waitExpression('Medium selected', `document.querySelector(${JSON.stringify(slider)})?.getAttribute('aria-valuetext')==='Medium'`);
    const state = await read();const step = state.width / state.max;const x = state.x + step;
    await pointer('mousePressed', x, state.y);
    await pointer('mouseMoved', x + step * 0.59, state.y);
    assert.equal((await read()).level, 'Medium');
    await pointer('mouseMoved', x + step * 0.61, state.y);
    assert.equal((await read()).level, 'High');
    const motionSamples = [];
    for (let sample = 0; sample < 5; sample += 1) {
      motionSamples.push((await read()).thumb.centerX);
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    assert.ok(motionSamples.at(-1) > motionSamples[0], 'The thumb must glide toward the next detent');
    assert.ok(motionSamples.every((value, index) => index === 0 || value >= motionSamples[index - 1] - 0.5), 'The spring must settle without jitter');
    result.motionSamples = motionSamples;
    assert.equal(await evaluate(cdp, `document.querySelector(${JSON.stringify(trigger)}).textContent.trim()`), 'Medium');
    await screenshot('thinking-drag-high-before-commit');
    await pointer('mouseReleased', x + step * 0.61, state.y);
    await ui.waitExpression('High committed on release', `document.querySelector(${JSON.stringify(trigger)}).textContent.trim()==='High'`);
    await ui.key('End', { windowsVirtualKeyCode: 35 });
    assert.equal((await read()).level, 'Extra High');
    await ui.key('Home', { windowsVirtualKeyCode: 36 });
    assert.equal((await read()).level, 'Low');
    await ui.key('ArrowRight', { windowsVirtualKeyCode: 39 });
    await dismiss();
    assert.equal(await evaluate(cdp, `document.activeElement?.matches(${JSON.stringify(trigger)})`), true);
    await open();
    await ui.click({ label: 'Fast Mode', selector: '.thinking-slider button' });
    await ui.waitExpression('Fast enabled', `document.querySelector('.thinking-slider button[aria-label="Fast Mode"]')?.getAttribute('aria-pressed')==='true'`);
    await screenshot('thinking-fast-enabled');
    await dismiss();
    const fastBefore = fixture.getState().receivedPrompts.length;
    await ui.send('QA header Fast toggle uses the native Fast Model with Medium thinking.');
    await ui.waitFor('Fast native prompt', () => fixture.getState().receivedPrompts.length > fastBefore);
    const fastSent = fixture.getState().receivedPrompts.at(-1);
    assert.equal(fastSent.model.modelID, 'fixture-model-fast');
    assert.equal(fastSent.variant, 'medium');
    await ui.waitFor('Fast completion', () => fixture.getState().activePrompts === 0);
    result.fastNativeSelection = { modelID: fastSent.model.modelID, variant: fastSent.variant };
    await open();
    await ui.click({ label: 'Fast Mode', selector: '.thinking-slider button' });
    await ui.waitExpression('Fast disabled', `document.querySelector('.thinking-slider button[aria-label="Fast Mode"]')?.getAttribute('aria-pressed')==='false'`);
    await dismiss();
    result.interaction = { fastToggle: true, threshold: 0.6, previewDoesNotCommit: true, releaseCommits: true, keyboard: true, focusRestored: true };
  });
  await check('thinking light/dark desktop and mobile touch', async () => {
    for (const theme of ['light', 'dark']) {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await new Promise(resolve => setTimeout(resolve, 200));
      await open();await screenshot(`thinking-${runtime}-${theme}-desktop`);await dismiss();
      if (runtime === 'web') {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
        await ui.click({ selector: 'button[title="Fixture model · Medium"]', touch: true });
        await ui.click({ label: 'Show Thinking Modes', touch: true });
        await ui.waitExpression('mobile slider visible', `document.querySelector(${JSON.stringify(slider)})?.getBoundingClientRect().width>0`);
        const state = await read();assert.equal(state.overflow, false);
        await screenshot(`thinking-${theme}-mobile`);
        // Cancelled touch must not commit a new level.
        const x = state.x + state.width / state.max;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: state.y }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: state.x + state.width, y: state.y }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        assert.equal((await read()).level, 'Medium');
        await dismiss();
        await cdp.send('Emulation.clearDeviceMetricsOverride');
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      }
      result.captures.push({ theme, desktop: true, mobileTouch: runtime === 'web' });
    }
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    // Motion reads this preference at mount; emulate an app launched with it enabled.
    await ui.reload();
    await ui.waitExpression('transcript restored for reduced motion', `document.body.textContent.includes('QA response chunk 20.')`);
    await open();
    await ui.waitExpression('slider keyboard focus', `document.activeElement?.matches(${JSON.stringify(slider)})`);
    await ui.key('End', { windowsVirtualKeyCode: 35 });
    await evaluate(cdp, `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const end = await read();
    assert.ok(Math.abs(end.thumb.centerX - (end.x + end.width)) < 1, `Reduced motion must reach the selected stop immediately: ${JSON.stringify(end)}`);
    await ui.key('Home', { windowsVirtualKeyCode: 36 });
    await evaluate(cdp, `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const start = await read();
    assert.ok(Math.abs(start.thumb.centerX - start.x) < 1);
    await ui.key('ArrowRight', { windowsVirtualKeyCode: 39 });
    await screenshot('thinking-reduced-motion');await dismiss();
  });
  await check('thinking explicit Medium reaches the native prompt', async () => {
    const before = fixture.getState().receivedPrompts.length;
    await ui.send('QA thinking slider explicit Medium submission.');
    await ui.waitFor('thinking native prompt', () => fixture.getState().receivedPrompts.length > before);
    const sent = fixture.getState().receivedPrompts.at(-1);
    assert.equal(sent.variant, 'medium');
    result.nativeVariant = sent.variant;
    await ui.waitFor('thinking completion', () => fixture.getState().activePrompts === 0);
    await ui.reload();
    await ui.waitExpression('Medium restored', `document.querySelector(${JSON.stringify(trigger)})?.textContent.trim()==='Medium'`);
    result.reload = true;
  });
  return result;
}
