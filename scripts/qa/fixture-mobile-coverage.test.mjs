import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { assertQaFixtureProjectHeaderTargets, assertQaPhoneAttachmentParts, assertQaPhoneTextAttachment, readQaPhoneImagePreview, openQaPhoneAttachmentDraft } from './fixture-mobile-coverage.mjs';

const action = (label, left) => ({ label, left, right: left + 36, top: 186.328125, bottom: 222.328125,
  width: 36, height: 36, hit: true, disabled: false });
const targets = () => ({ coarse: true, title: { left: 29.40625, right: 110.546875 },
  glyphs: [...'QA workspace'].filter(character => character.trim()).map(character => ({ character, hit: true })),
  actions: [action('New Worktree', 223.53125), action('Project Menu', 263.125), action('New Draft Session', 303.125)] });

test('a loaded preview must be actually visible, settled and center-hit-owned before capture', () => {
  const overlay = { parentElement: null, opacity: 1, getAnimations: () => [] };
  const image = { parentElement: overlay, alt: 'priority-reference.png', complete: true, naturalWidth: 320,
    getBoundingClientRect: () => ({ left: 35, right: 355, top: 200, bottom: 380, width: 320, height: 180, x: 35, y: 200 }),
    contains: element => element === image, getAnimations: () => [] };
  let hit = image;
  const context = vm.createContext({ innerWidth: 390, innerHeight: 844,
    document: { querySelector: () => ({}), querySelectorAll: () => [image], elementFromPoint: () => hit },
    getComputedStyle: element => ({ opacity: String(element.opacity ?? 1), display: 'block', visibility: 'visible' }) });
  const read = () => vm.runInContext(`(${readQaPhoneImagePreview.toString()})('priority-reference.png')`, context);
  assert.equal(read().centerHitOwned, true);
  overlay.opacity = 0;assert.equal(read(), null, 'Mounted hidden preview must not witness visible access');
  overlay.opacity = 0.5;assert.equal(read(), null, 'Fade-in must not produce the final screenshot receipt');
  overlay.opacity = 1;overlay.getAnimations = () => [{ playState: 'running' }];assert.equal(read(), null);
  overlay.getAnimations = () => [];hit = {};assert.equal(read(), null, 'An obscured image cannot witness user access');
  hit = image;image.complete = false;assert.equal(read(), null);
});

test('phone canonical image requires the exact owned file identity and bytes once after text conversion', () => {
  const bytes = Buffer.from('owned-image-bytes');
  const expected = { name: 'priority-reference.png', mime: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex') };
  const image = { type: 'file', filename: expected.name, mime: expected.mime, url: 'data:image/png;base64,' + bytes.toString('base64') };
  const text = { type: 'text', synthetic: true, text: 'Attached file: brief.txt\nMIME type: text/plain\n\n<file_content>Owned requirements</file_content>' };
  assert.doesNotThrow(() => assertQaPhoneAttachmentParts([text, image], expected));
  assert.throws(() => assertQaPhoneAttachmentParts([text], expected), /exact owned image/);
  assert.throws(() => assertQaPhoneAttachmentParts([image, image], expected), /duplicated/);
  assert.throws(() => assertQaPhoneAttachmentParts([{ ...image, filename: 'foreign.png' }], expected), /exact owned image/);
  assert.throws(() => assertQaPhoneAttachmentParts([{ ...image, url: 'data:image/png;base64,' + Buffer.from('changed').toString('base64') }], expected), /original owned fixture/);
  assert.throws(() => assertQaPhoneAttachmentParts([{ ...image, url: 'https://foreign.invalid/image.png' }], expected));
});

test('phone text attachment accepts the original synthetic conversion or exact file bytes, never an unrelated text occurrence', () => {
  const text = 'Owned requirements\n';
  const projected = { type: 'text', synthetic: true, text: `Attached file: brief.txt\nMIME type: text/plain\n\n<file_content>\n${text}\n</file_content>` };
  assert.doesNotThrow(() => assertQaPhoneTextAttachment([projected], 'brief.txt', 'text/plain', text));
  const file = { type: 'file', filename: 'brief.txt', mime: 'text/plain', url: 'data:text/plain;base64,' + Buffer.from(text).toString('base64') };
  assert.doesNotThrow(() => assertQaPhoneTextAttachment([file], 'brief.txt', 'text/plain', text));
  assert.throws(() => assertQaPhoneTextAttachment([{ type: 'text', text }], 'brief.txt', 'text/plain', text), /content and identity/);
  assert.throws(() => assertQaPhoneTextAttachment([{ ...projected, text: projected.text.replace('brief.txt', 'foreign.txt') }], 'brief.txt', 'text/plain', text));
  assert.throws(() => assertQaPhoneTextAttachment([{ ...file, url: 'data:text/plain;base64,' + Buffer.from('changed').toString('base64') }], 'brief.txt', 'text/plain', text));
});

test('accepts separate coarse header targets with native title and action ownership', () => {
  assert.doesNotThrow(() => assertQaFixtureProjectHeaderTargets(targets()));
});

for (const [width, worktree, menu, draft] of [
  [390, 223.53125, 263.125, 286.515625],
  [768, 544.828125, 584.421875, 607.8125],
]) {
  test(`rejects the observed ${width}px drawer overlap even when all action centers are owned`, () => {
    const snapshot = targets();
    snapshot.actions = [action('New Worktree', worktree), action('Project Menu', menu), action('New Draft Session', draft)];
    assert.throws(() => assertQaFixtureProjectHeaderTargets(snapshot), /Project Menu and New Draft Session must not overlap/);
  });
}

test('rejects a covered final title glyph even when the first two glyphs and all action centers are owned', () => {
  const snapshot = targets();snapshot.glyphs.at(-1).hit = false;
  assert.throws(() => assertQaFixtureProjectHeaderTargets(snapshot), /Every visible workspace-title glyph/);
});

test('rejects title crowding even when the title glyph centers are still owned', () => {
  const snapshot = targets();snapshot.title.right = snapshot.actions[0].left + 1;
  assert.throws(() => assertQaFixtureProjectHeaderTargets(snapshot), /must not overlap the clipped workspace title/);
});


const phoneDraftFixture = ({ open = false, labels = ['QA workspace'], close = true } = {}) => {
  const calls = [];
  const state = { open };
  const headers = labels.map(label => ({
    querySelector: selector => { assert.equal(selector, 'button[aria-expanded] span.truncate');return { innerText: label }; },
    querySelectorAll: selector => { assert.equal(selector, 'button[aria-label="New Draft Session"]');return [{}]; },
  }));
  const drawer = { getBoundingClientRect: () => ({ left: 0, right: 390, width: 390 }),
    querySelectorAll: selector => { assert.equal(selector, '[data-project-header]');return headers; } };
  const context = vm.createContext({ innerWidth: 390, innerHeight: 844,
    document: {
      querySelector: selector => selector === 'aside[aria-hidden="false"]' ? state.open ? drawer : null
        : selector === 'button[aria-label="Close Sessions"]' ? state.open ? {} : null : null,
      querySelectorAll: selector => { assert.equal(selector, 'aside[aria-hidden="true"]');return state.open ? [] : [{ getBoundingClientRect: () => ({ left: -390, right: 0 }) }]; },
      documentElement: { classList: { contains: () => false } },
    } });
  const cdp = { send: async (method, params) => {
    assert.equal(method, 'Runtime.evaluate');return { result: { value: vm.runInContext(params.expression, context) } };
  } };
  const ui = {
    click: async options => {
      calls.push(options);
      assert.equal(options.touch, true);
      if (options.label === 'Open Sessions') { assert.equal(state.open, false);state.open = true; }
      else {
        assert.equal(options.selector, 'aside[aria-hidden="false"] [data-project-header] button[aria-label="New Draft Session"]');
        assert.equal(state.open, true);assert.deepEqual(labels, ['QA workspace']);
        if (close) state.open = false;
      }
    },
    waitExpression: async (label, expression) => {
      calls.push(label);const value = (await cdp.send('Runtime.evaluate', { expression })).result.value;
      if (!value) throw new Error('Timed out: ' + label);return value;
    },
    inspectControls: async () => [{ label: 'Open Sessions' }],
  };
  return { cdp, ui, state, calls };
};

for (const open of [false, true]) {
  test(`phone draft uses the original exact project action with ${open ? 'already open' : 'collapsed'} Sessions drawer`, async () => {
    const fixture = phoneDraftFixture({ open });
    await openQaPhoneAttachmentDraft(fixture);
    assert.equal(fixture.state.open, false);
    const actions = fixture.calls.filter(value => typeof value === 'object');
    assert.equal(actions.length, open ? 1 : 2);
    assert.equal(fixture.calls.at(-1), 'phone project draft closes Sessions drawer');
    assert.ok(!actions.some(action => action.label === 'New Chat'), 'Global new-chat action cannot substitute for the project directory override');
  });
}

for (const labels of [['Foreign workspace'], ['QA workspace', 'Foreign workspace'], ['QA workspace', 'QA workspace']]) {
  test(`phone draft refuses unmatched or ambiguous project headers: ${labels.join(', ')}`, async () => {
    const fixture = phoneDraftFixture({ open: true, labels });
    await assert.rejects(openQaPhoneAttachmentDraft(fixture), /owned QA workspace phone draft action/);
    assert.equal(fixture.calls.filter(value => typeof value === 'object').length, 0, 'No foreign or ambiguous draft action may be dispatched');
  });
}

test('phone attachment work cannot continue when the original project action leaves the drawer open', async () => {
  const fixture = phoneDraftFixture({ close: false });let attached = false;
  await assert.rejects((async () => { await openQaPhoneAttachmentDraft(fixture);attached = true; })(), /closes Sessions drawer/);
  assert.equal(attached, false);
});
