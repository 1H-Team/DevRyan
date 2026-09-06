import assert from 'node:assert/strict';
import test from 'node:test';
import { assertQaFixtureProjectHeaderTargets } from './fixture-mobile-coverage.mjs';

const action = (label, left) => ({ label, left, right: left + 36, top: 186.328125, bottom: 222.328125,
  width: 36, height: 36, hit: true, disabled: false });
const targets = () => ({ coarse: true, title: { left: 29.40625, right: 110.546875 },
  glyphs: [...'QA workspace'].filter(character => character.trim()).map(character => ({ character, hit: true })),
  actions: [action('New Worktree', 223.53125), action('Project Menu', 263.125), action('New Draft Session', 303.125)] });

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
