import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import {
  downloadAsMarkdown,
  formatSessionAsMarkdown,
  type ChildSessionExport,
} from './exportSession';

const messageRecord = (id: string, role: 'user' | 'assistant', text: string) => ({
  info: {
    id,
    sessionID: 'session-root',
    role,
    time: { created: 1 },
    ...(role === 'assistant' ? { providerID: 'openai', modelID: 'gpt-5' } : {}),
  } as Message,
  parts: [{
    id: `${id}-part`,
    sessionID: 'session-root',
    messageID: id,
    type: 'text',
    text,
  } as Part],
});

describe('formatSessionAsMarkdown', () => {
  test('keeps parent-only exports free of sub-agent sections', () => {
    const markdown = formatSessionAsMarkdown([
      messageRecord('parent-user', 'user', 'Parent question'),
      messageRecord('parent-assistant', 'assistant', 'Parent answer'),
    ], 'Parent chat');

    expect(markdown).toContain('# Parent chat');
    expect(markdown).toContain('Parent question');
    expect(markdown).toContain('Parent answer');
    expect(markdown).not.toContain('Sub-agent:');
  });

  test('renders child and nested child chats under stable headings', () => {
    const grandchild: ChildSessionExport = {
      title: 'Grandchild task',
      agent: 'worker',
      records: [messageRecord('grandchild', 'assistant', 'Grandchild answer')],
      children: [],
    };
    const child: ChildSessionExport = {
      title: 'Child task',
      agent: 'explorer',
      records: [messageRecord('child', 'assistant', 'Child answer')],
      children: [grandchild],
    };

    const markdown = formatSessionAsMarkdown(
      [messageRecord('parent', 'user', 'Parent question')],
      'Parent chat',
      [child],
    );

    expect(markdown).toContain('## Sub-agent: Child task — explorer');
    expect(markdown).toContain('Child answer');
    expect(markdown).toContain('### Sub-agent: Grandchild task — worker');
    expect(markdown).toContain('Grandchild answer');
  });
});

describe('downloadAsMarkdown', () => {
  const originalDocument = globalThis.document;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  test('revokes the Blob URL after the fallback click has had a turn to start', async () => {
    let clickCount = 0;
    const anchor = { href: '', download: '', click: () => { clickCount += 1; } };
    const revokedUrls: string[] = [];

    try {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        writable: true,
        value: {
          createElement: () => anchor,
          body: { appendChild: () => {}, removeChild: () => {} },
        },
      });
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: () => 'blob:chat-export',
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: (url: string) => { revokedUrls.push(url); },
      });

      downloadAsMarkdown('# Chat', 'chat.md');

      expect(clickCount).toBe(1);
      expect(anchor.download).toBe('chat.md');
      expect(revokedUrls).toEqual([]);

      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(revokedUrls).toEqual(['blob:chat-export']);
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        writable: true,
        value: originalDocument,
      });
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: originalCreateObjectURL,
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: originalRevokeObjectURL,
      });
    }
  });
});
