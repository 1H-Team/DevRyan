import { describe, expect, test } from 'bun:test';

import {
  AGENT_CURSOR_IDLE_HIDE_MS,
  AGENT_CURSOR_MOVE_COALESCE_MS,
  createAgentCursorState,
  isAgentInputEvent,
  isDiscreteAgentInput,
  reduceAgentCursorState,
  shouldHideAgentCursor,
} from './browserAgentCursorState';

describe('agent cursor coalescing', () => {
  test('drops only rapid moves', () => {
    const start = createAgentCursorState();
    const first = reduceAgentCursorState(start, { leaseId: 'lease-a', kind: 'move', x: 10, y: 10 }, 1000);
    expect(first.visible).toBe(true);
    expect(first.x).toBe(10);

    const tooSoon = reduceAgentCursorState(first, { leaseId: 'lease-a', kind: 'move', x: 40, y: 40 }, 1000 + AGENT_CURSOR_MOVE_COALESCE_MS - 1);
    expect(tooSoon.x).toBe(10);

    const later = reduceAgentCursorState(first, { leaseId: 'lease-a', kind: 'move', x: 40, y: 40 }, 1000 + AGENT_CURSOR_MOVE_COALESCE_MS);
    expect(later.x).toBe(40);
  });

  test('never drops presses, releases, keys, text, or touches', () => {
    let state = reduceAgentCursorState(createAgentCursorState(), { leaseId: 'lease-a', kind: 'move', x: 5, y: 5 }, 1000);

    const down = reduceAgentCursorState(state, { leaseId: 'lease-a', kind: 'down', x: 7, y: 8, button: 'left', clickCount: 1 }, 1001);
    expect(down.pressed).toBe(true);
    expect(down.x).toBe(7);
    expect(down.rippleKey).toBe(state.rippleKey + 1);

    const up = reduceAgentCursorState(down, { leaseId: 'lease-a', kind: 'up', x: 7, y: 8 }, 1002);
    expect(up.pressed).toBe(false);

    state = reduceAgentCursorState(up, { leaseId: 'lease-a', kind: 'key', keyType: 'keyDown', key: 'a' }, 1003);
    expect(state.lastActivityAt).toBe(1003);

    state = reduceAgentCursorState(state, { leaseId: 'lease-a', kind: 'text', length: 4 }, 1004);
    expect(state.lastActivityAt).toBe(1004);

    const touch = reduceAgentCursorState(state, { leaseId: 'lease-a', kind: 'touch', x: 30, y: 40, touchType: 'touchStart' }, 1005);
    expect(touch.x).toBe(30);
    expect(touch.y).toBe(40);
    expect(touch.pressed).toBe(true);
    expect(touch.rippleKey).toBe(up.rippleKey + 1);
  });

  test('a move immediately after a discrete event still lands', () => {
    const down = reduceAgentCursorState(createAgentCursorState(), { leaseId: 'lease-a', kind: 'down', x: 1, y: 1 }, 2000);
    const move = reduceAgentCursorState(down, { leaseId: 'lease-a', kind: 'move', x: 90, y: 90 }, 2001);
    expect(move.x).toBe(90);
  });

  test('two clicks at the same point restart the ripple', () => {
    const first = reduceAgentCursorState(createAgentCursorState(), { leaseId: 'lease-a', kind: 'down', x: 4, y: 4 }, 3000);
    const release = reduceAgentCursorState(first, { leaseId: 'lease-a', kind: 'up', x: 4, y: 4 }, 3010);
    const second = reduceAgentCursorState(release, { leaseId: 'lease-a', kind: 'down', x: 4, y: 4 }, 3200);
    expect(second.rippleKey).toBe(first.rippleKey + 1);
  });

  test('classifies discrete input', () => {
    expect(isDiscreteAgentInput({ leaseId: 'lease-a', kind: 'move', x: 0, y: 0 })).toBe(false);
    expect(isDiscreteAgentInput({ leaseId: 'lease-a', kind: 'down', x: 0, y: 0 })).toBe(true);
    expect(isDiscreteAgentInput({ leaseId: 'lease-a', kind: 'key' })).toBe(true);
  });
});

describe('idle hiding', () => {
  test('hides only after the idle window elapses', () => {
    const state = reduceAgentCursorState(createAgentCursorState(), { leaseId: 'lease-a', kind: 'move', x: 1, y: 2 }, 5000);
    expect(shouldHideAgentCursor(state, 5000 + AGENT_CURSOR_IDLE_HIDE_MS - 1)).toBe(false);
    expect(shouldHideAgentCursor(state, 5000 + AGENT_CURSOR_IDLE_HIDE_MS)).toBe(true);
    expect(shouldHideAgentCursor(createAgentCursorState(), 1e9)).toBe(false);
  });
});

describe('isAgentInputEvent', () => {
  test('accepts well-formed payloads', () => {
    expect(isAgentInputEvent({ leaseId: 'lease-a', kind: 'move', x: 1, y: 2 })).toBe(true);
    expect(isAgentInputEvent({ leaseId: 'lease-a', kind: 'down', x: 0, y: 0, button: 'left' })).toBe(true);
    expect(isAgentInputEvent({ leaseId: 'lease-a', kind: 'key', key: 'a' })).toBe(true);
    expect(isAgentInputEvent({ leaseId: 'lease-a', kind: 'text', length: 3 })).toBe(true);
    expect(isAgentInputEvent({ leaseId: 'lease-a', kind: 'touch', x: 5, y: 6 })).toBe(true);
    expect(isAgentInputEvent({ leaseId: 'lease-b', kind: 'key' }, 'lease-a')).toBe(false);
    expect(isAgentInputEvent({ leaseId: 'lease-a', kind: 'key' }, 'lease-a')).toBe(true);
  });

  test('rejects malformed payloads', () => {
    expect(isAgentInputEvent(null)).toBe(false);
    expect(isAgentInputEvent('move')).toBe(false);
    expect(isAgentInputEvent({ kind: 'move', x: 1, y: 2 })).toBe(false);
    expect(isAgentInputEvent({ leaseId: 'lease-a', kind: 'sorcery', x: 1, y: 2 })).toBe(false);
    expect(isAgentInputEvent({ leaseId: 'lease-a', kind: 'move' })).toBe(false);
    expect(isAgentInputEvent({ leaseId: 'lease-a', kind: 'move', x: Number.NaN, y: 2 })).toBe(false);
    expect(isAgentInputEvent({ leaseId: 'lease-a', kind: 'move', x: '1', y: 2 })).toBe(false);
  });
});
