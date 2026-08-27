import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { BotSharedFile } from '@/lib/botsApi';
import { BotSharedFileRow } from './BotArtifactsTab';

const sharedFile = (copyState: BotSharedFile['copyState']): BotSharedFile => ({
  id: 'f0000000-0000-4000-8000-000000000001',
  botId: 'b0000000-0000-4000-8000-000000000001',
  channelId: 'c0000000-0000-4000-8000-000000000001',
  messageId: 'd0000000-0000-4000-8000-000000000001',
  objectId: 'e0000000-0000-4000-8000-000000000001',
  senderUserId: 'a0000000-0000-4000-8000-000000000001',
  direction: 'user',
  filename: 'brief.pdf',
  contentType: 'application/pdf',
  sha256: copyState === 'ready' ? 'a'.repeat(64) : null,
  size: copyState === 'ready' ? 4096 : null,
  computerPath: '/workspace/Shared/c0000000-0000-4000-8000-000000000001/d0000000-0000-4000-8000-000000000001/brief.pdf',
  copyState,
  errorCode: copyState === 'failed' ? 'bot_shared_file_copy_failed' : null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const renderRow = (copyState: BotSharedFile['copyState']) => renderToStaticMarkup(
  <I18nProvider>
    <BotSharedFileRow
      file={sharedFile(copyState)}
      viewerUserId="a0000000-0000-4000-8000-000000000001"
      busy={false}
      onDownload={() => {}}
      onOpenComputer={() => {}}
      onRetry={() => {}}
    />
  </I18nProvider>,
);

describe('Bot Shared file row', () => {
  test('shows the persistent path, sender, status, download, and computer actions', () => {
    const markup = renderRow('ready');
    expect(markup).toContain('brief.pdf');
    expect(markup).toContain('/workspace/Shared/');
    expect(markup).toContain('Sent by you');
    expect(markup).toContain('ready');
    expect(markup).toContain('Download');
    expect(markup).toContain('Open in Computer');
    expect(markup).not.toContain('>Retry<');
  });

  test('keeps failed preparation visible and retryable without enabling download', () => {
    const markup = renderRow('failed');
    expect(markup).toContain('The persistent copy failed.');
    expect(markup).toContain('>Retry<');
    expect(/<button[^>]*disabled=""[^>]*>[\s\S]*Download[\s\S]*<\/button>/.test(markup)).toBe(true);
  });

  test('does not label another authorized member as the current user', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotSharedFileRow
          file={sharedFile('ready')}
          viewerUserId="a0000000-0000-4000-8000-000000000099"
          busy={false}
          onDownload={() => {}}
          onOpenComputer={() => {}}
          onRetry={() => {}}
        />
      </I18nProvider>,
    );
    expect(markup).toContain('Sent by a member');
    expect(markup).not.toContain('Sent by you');
  });
});
