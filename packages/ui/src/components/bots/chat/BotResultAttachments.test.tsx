import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { BotSharedFile } from '@/lib/botsApi';
import { createBotSharedFilesStore } from '@/stores/useBotSharedFilesStore';
import { BotResultAttachments } from './BotResultAttachments';
import { resolveBotResultImageSources } from './botResultImageSources';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const MESSAGE_ID = 'd0000000-0000-4000-8000-000000000001';

const file = (overrides: Partial<BotSharedFile> = {}): BotSharedFile => ({
  id: 'e0000000-0000-4000-8000-000000000001',
  botId: BOT_ID,
  channelId: CHANNEL_ID,
  messageId: MESSAGE_ID,
  objectId: 'f0000000-0000-4000-8000-000000000001',
  senderUserId: null,
  direction: 'bot',
  filename: 'chart.png',
  contentType: 'image/png',
  sha256: null,
  size: null,
  computerPath: `/workspace/Shared/${CHANNEL_ID}/${MESSAGE_ID}/chart.png`,
  copyState: 'pending',
  errorCode: null,
  createdAt: '2026-08-26T10:00:00.000Z',
  updatedAt: '2026-08-26T10:00:00.000Z',
  ...overrides,
});

describe('Bot result image attachments', () => {
  test('shows pending Shared images immediately and deduplicates their exact Markdown path', () => {
    const store = createBotSharedFilesStore();
    const shared = file();
    store.getState().upsertFile(shared);
    expect(resolveBotResultImageSources([shared], (
      `![Shared chart](${shared.computerPath}) ![Remote chart](https://example.com/chart.webp)`
    )).map((image) => image.key)).toEqual([
      `object:${shared.objectId}`,
      'source:https://example.com/chart.webp',
    ]);
    const markup = renderToStaticMarkup(
      <BotResultAttachments
        botId={BOT_ID}
        messageId={MESSAGE_ID}
        text="![Remote chart](https://example.com/chart.webp)"
        sharedFilesStore={store}
      />,
    );
    expect(markup.match(/aspect-\[4\/3\]/g)).toHaveLength(1);
    expect(markup).toContain('w-full max-w-2xl');
    expect(markup).toContain('Loading Image');
  });

  test('rejects SVG Shared files from inline preview', () => {
    const store = createBotSharedFilesStore();
    store.getState().upsertFile(file({
      filename: 'unsafe.svg',
      contentType: 'image/svg+xml',
    }));
    expect(renderToStaticMarkup(
      <BotResultAttachments botId={BOT_ID} messageId={MESSAGE_ID} text="" sharedFilesStore={store} />,
    )).toBe('');
  });

  test('keeps encrypted images inline throughout every asynchronous Shared-copy state', () => {
    for (const copyState of ['pending', 'copying', 'ready', 'failed'] as const) {
      const shared = file({ copyState });
      expect(resolveBotResultImageSources([shared], '').map((image) => image.key)).toEqual([
        `object:${shared.objectId}`,
      ]);
    }
  });
});
