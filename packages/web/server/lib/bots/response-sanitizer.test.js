import { describe, expect, it } from 'vitest';

import { projectBotAssistantResponse } from './opencode-provider.js';
import { sanitizeBotConversationalText } from './response-sanitizer.js';

describe('Bot conversational response sanitization', () => {
  it('removes leading agent-work labels from the conversational answer', () => {
    expect(sanitizeBotConversationalText(
      '**Crafting warm pricing prompt**Hey! I’m here 💛 Want me to try the pricing page again?',
    )).toBe('Hey! I’m here 💛 Want me to try the pricing page again?');
    expect(sanitizeBotConversationalText(
      'Checking the pricing page\n\nIt is available now.',
    )).toBe('It is available now.');
    expect(sanitizeBotConversationalText(
      '## Preparing a reply\n**Composing the final answer**\nHere you go.',
    )).toBe('Here you go.');
  });

  it('buffers an incomplete status label instead of flashing it during streaming', () => {
    expect(sanitizeBotConversationalText('**Cra')).toBe('');
    expect(sanitizeBotConversationalText('**Crafting warm pricing prompt')).toBe('');
    expect(sanitizeBotConversationalText('**Crafting warm pricing prompt**')).toBe('');
  });

  it('preserves ordinary conversational formatting and prose', () => {
    expect(sanitizeBotConversationalText('**Hello!** Welcome back.')).toBe('**Hello!** Welcome back.');
    expect(sanitizeBotConversationalText(
      'Crafting a strong pricing prompt takes a clear audience and goal.',
    )).toBe('Crafting a strong pricing prompt takes a clear audience and goal.');
  });

  it('removes internal protocol blocks and buffers incomplete ones', () => {
    expect(sanitizeBotConversationalText(
      '<analysis>Need to call the pricing tool.</analysis>Here is the price.',
    )).toBe('Here is the price.');
    expect(sanitizeBotConversationalText('<tool_call>{"name":"pricing"}')).toBe('');
    expect(sanitizeBotConversationalText(
      '```tool_call\n{"name":"pricing"}\n```\nThe page is ready.',
    )).toBe('The page is ready.');
  });

  it('projects only public final text around provider tool parts', () => {
    expect(projectBotAssistantResponse([
      { type: 'reasoning', text: 'Private reasoning.' },
      { type: 'text', text: 'Synthetic context.', synthetic: true },
      { type: 'text', text: 'Ignored provider status.', ignored: true },
      { type: 'text', text: '**Checking the pricing page**' },
      { type: 'tool', tool: 'devryan_bot' },
      { type: 'text', text: 'Inter-tool progress.' },
      { type: 'tool', tool: 'devryan_bot' },
      { type: 'text', text: '**Crafting warm pricing prompt**Hey! The pricing page is ready.' },
    ])).toEqual({
      toolObserved: true,
      acknowledgmentText: '',
      resultText: 'Hey! The pricing page is ready.',
      generatedImages: [],
    });
  });
});
