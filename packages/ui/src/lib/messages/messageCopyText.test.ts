import { describe, expect, test } from 'bun:test';
import type { TextPart } from '@opencode-ai/sdk/v2';
import { getMessageCopyText } from './messageCopyText';
import { flattenAssistantTextParts } from './messageText';

const text = (value: string): TextPart => ({ id: 'p', messageID: 'm', sessionID: 's', type: 'text', text: value });

describe('clipboard message text', () => {
  for (const source of [
    'First paragraph\n\nSecond paragraph\n',
    '```ts\nconst x = 1;\n\nconsole.log(x);\n```',
    '    indented code\n    next line  \n',
    '- first\n\n  continuation\n- second',
    '| A | B |\r\n| --- | --- |\r\n| 1 | 2 |\r\n',
  ]) test(`preserves exact source whitespace: ${JSON.stringify(source)}`, () => {
    for (const role of ['assistant', 'user'] as const) expect(getMessageCopyText([text(source)], role)).toBe(source);
  });

  test('separates nonblank parts and supports legacy content', () => {
    const legacy = { ...text(''), content: 'legacy\n\ntext' };
    expect(getMessageCopyText([text('first'), text(' \n'), legacy], 'assistant')).toBe('first\n\nlegacy\n\ntext');
  });

  test('user shell output takes precedence, then command, without stripping indentation', () => {
    const shell = { ...text('prompt'), shellAction: { output: '  output\n\n', command: 'echo x' } };
    expect(getMessageCopyText([shell], 'user')).toBe('  output\n\n');
    const commandOnly = { ...shell, shellAction: { command: '  echo x\n' } };
    expect(getMessageCopyText([commandOnly], 'user')).toBe('  echo x\n');
    expect(getMessageCopyText([shell], 'assistant')).toBe('prompt');
  });

  test('does not change plan-extraction text normalization', () => {
    const parts = [text('first\n\nsecond'), text('third')];
    expect(flattenAssistantTextParts(parts)).toBe('first\nsecond\nthird');
    expect(getMessageCopyText(parts, 'assistant')).toBe('first\n\nsecond\n\nthird');
  });
});
