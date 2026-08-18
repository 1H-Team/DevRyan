import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_CHAT_WIDTH,
  MAX_CHAT_WIDTH,
  MIN_CHAT_WIDTH,
  applyChatWidth,
  clampChatWidth,
} from './chatLayout';

const createRoot = () => {
  const properties = new Map<string, string>();
  const root = {
    style: {
      setProperty: (name: string, value: string) => {
        properties.set(name, value);
      },
      removeProperty: (name: string) => {
        const previous = properties.get(name) ?? '';
        properties.delete(name);
        return previous;
      },
    },
  } as unknown as HTMLElement;

  return { properties, root };
};

describe('applyChatWidth', () => {
  test('sets the chat column width custom property', () => {
    const { properties, root } = createRoot();

    applyChatWidth(root, 1024);

    expect(properties.get('--chat-column-width')).toBe('1024px');
  });

  test('removes the custom property at the default width', () => {
    const { properties, root } = createRoot();
    properties.set('--chat-column-width', '1024px');

    applyChatWidth(root, DEFAULT_CHAT_WIDTH);

    expect(properties.has('--chat-column-width')).toBe(false);
  });
});

describe('clampChatWidth', () => {
  test('clamps values to the supported range', () => {
    expect(clampChatWidth(MIN_CHAT_WIDTH - 100)).toBe(MIN_CHAT_WIDTH);
    expect(clampChatWidth(MAX_CHAT_WIDTH + 100)).toBe(MAX_CHAT_WIDTH);
  });

  test('rounds off-grid values to the nearest step', () => {
    expect(clampChatWidth(1030)).toBe(1024);
    expect(clampChatWidth(1033)).toBe(1040);
  });
});
