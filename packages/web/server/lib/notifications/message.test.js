import { describe, expect, it } from 'vitest';

import { prepareNotificationLastMessage, truncateNotificationText } from './message.js';

const LONG_MESSAGE = 'a'.repeat(300) + ' long completion output that must be summarized';

describe('notification message helpers', () => {
  it('truncates oversized notification text', () => {
    expect(truncateNotificationText('abcdef', 3)).toBe('abc...');
  });

  it('summarizes whenever a summarize function is supplied, regardless of stored settings', async () => {
    let summarizeCalls = 0;
    const result = await prepareNotificationLastMessage({
      message: LONG_MESSAGE,
      summarize: async () => {
        summarizeCalls += 1;
        return 'short summary';
      },
      settings: { summarizeLastMessage: false },
    });

    expect(summarizeCalls).toBe(1);
    expect(result).toBe('short summary');
  });

  it('keeps messages at or below the built-in threshold unsummarized', async () => {
    let summarizeCalls = 0;
    const result = await prepareNotificationLastMessage({
      message: 'a'.repeat(200),
      summarize: async () => {
        summarizeCalls += 1;
        return 'short summary';
      },
    });

    expect(summarizeCalls).toBe(0);
    expect(result).toBe('a'.repeat(200));
  });

  it('falls back to plain truncation when summarization fails', async () => {
    const result = await prepareNotificationLastMessage({
      message: LONG_MESSAGE,
      summarize: async () => {
        throw new Error('summarization failed');
      },
    });

    expect(result).toBe(`${'a'.repeat(250)}...`);
  });

  it('falls back to plain truncation when the summary is empty', async () => {
    const result = await prepareNotificationLastMessage({
      message: LONG_MESSAGE,
      summarize: async () => '   ',
    });

    expect(result).toBe(`${'a'.repeat(250)}...`);
  });

  it('truncates without summarizing when no summarize function is supplied', async () => {
    const result = await prepareNotificationLastMessage({
      message: LONG_MESSAGE,
    });

    expect(result).toBe(`${'a'.repeat(250)}...`);
  });

  it('normalizes markdown summary to plain text', async () => {
    const result = await prepareNotificationLastMessage({
      message: LONG_MESSAGE,
      summarize: async () => "**Committed.**\n\n- Commit: `85924b9d`\n- Message: `fix desktop notifications`",
    });

    expect(result).toBe('Committed. Commit: 85924b9d Message: fix desktop notifications');
  });
});
