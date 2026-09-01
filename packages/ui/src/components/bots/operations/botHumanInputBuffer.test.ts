import { describe, expect, test } from 'bun:test';

import type { BotHumanInputEvent } from '@/lib/botsApi';
import { queueBotHumanInputEvent } from './botHumanInputBuffer';

type PointerInput = Extract<BotHumanInputEvent, { type: 'pointer' }>;

const move = (x: number): PointerInput => ({
  type: 'pointer',
  phase: 'move',
  x,
  y: 20,
  button: 'none',
  buttons: 0,
  clickCount: 0,
});

const heldMove = (x: number): PointerInput => ({ ...move(x), buttons: 1 });

describe('Bot human input backlog', () => {
  test('keeps only the newest hover while a prior request is in flight', () => {
    const pending: BotHumanInputEvent[] = [];
    for (let x = 0; x < 500; x += 1) {
      expect(queueBotHumanInputEvent(pending, move(x), 256)).toBe(true);
    }
    expect(pending).toEqual([move(499)]);
  });

  test('preserves pointer down/up ordering behind the newest hover', () => {
    const pending: BotHumanInputEvent[] = [move(10)];
    const down: BotHumanInputEvent = {
      type: 'pointer', phase: 'down', x: 40, y: 50,
      button: 'left', buttons: 1, clickCount: 1,
    };
    const up: BotHumanInputEvent = {
      type: 'pointer', phase: 'up', x: 40, y: 50,
      button: 'left', buttons: 0, clickCount: 1,
    };
    expect(queueBotHumanInputEvent(pending, down, 256)).toBe(true);
    expect(queueBotHumanInputEvent(pending, up, 256)).toBe(true);
    expect(pending).toEqual([move(10), down, up]);
  });

  test('preserves real movement samples while a pointer button is held', () => {
    const pending: BotHumanInputEvent[] = [];
    expect(queueBotHumanInputEvent(pending, heldMove(10), 256)).toBe(true);
    expect(queueBotHumanInputEvent(pending, heldMove(20), 256)).toBe(true);
    expect(queueBotHumanInputEvent(pending, heldMove(30), 256)).toBe(true);
    expect(pending).toEqual([heldMove(10), heldMove(20), heldMove(30)]);
  });

  test('never drops pointer down or up when the backlog contains only discrete events', () => {
    const key: BotHumanInputEvent = {
      type: 'key', phase: 'down', key: 'Enter', code: 'Enter',
      modifiers: [], location: 0, repeat: false,
    };
    const down: BotHumanInputEvent = {
      type: 'pointer', phase: 'down', x: 40, y: 50,
      button: 'left', buttons: 1, clickCount: 1,
    };
    const up: BotHumanInputEvent = { ...down, phase: 'up', buttons: 0 };
    const pending: BotHumanInputEvent[] = [key];
    expect(queueBotHumanInputEvent(pending, down, 1)).toBe(true);
    expect(queueBotHumanInputEvent(pending, up, 1)).toBe(true);
    expect(pending).toEqual([key, down, up]);
  });

  test('coalesces wheel deltas and drops continuous input before discrete input', () => {
    const wheel: BotHumanInputEvent = {
      type: 'wheel', x: 1, y: 2, deltaX: 3, deltaY: 4,
    };
    const pending: BotHumanInputEvent[] = [wheel];
    expect(queueBotHumanInputEvent(pending, { ...wheel, deltaX: 5, deltaY: 6 }, 2)).toBe(true);
    expect(pending).toEqual([{ ...wheel, deltaX: 8, deltaY: 10 }]);
    const key: BotHumanInputEvent = {
      type: 'key', phase: 'down', key: 'Enter', code: 'Enter',
      modifiers: [], location: 0, repeat: false,
    };
    expect(queueBotHumanInputEvent(pending, key, 1)).toBe(true);
    expect(pending).toEqual([key]);
  });
});
