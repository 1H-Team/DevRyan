import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { BotChannel } from '@/lib/botsApi';
import { createBotChannelStore } from '@/stores/useBotChannelStore';
import { resolveBotRuntimeMessageKey, shouldSubmitBotComposerKey } from '../botPresentation';
import { BotComposer } from './BotComposer';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'd0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';

const channel = (accessRole: BotChannel['accessRole'], canSend: boolean): BotChannel => ({
  id: CHANNEL_ID,
  botId: BOT_ID,
  ownerUserId: USER_ID,
  accessRole,
  canSend,
  lifecycle: 'active',
  currentCheckpointNumber: 0,
  lastMessageSequence: 0,
  lastMessageAt: null,
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
  archivedAt: null,
});

const renderComposer = (value: BotChannel, runtimeState = 'healthy', runtimeAvailable = true) => {
  const channelStore = createBotChannelStore({ getPrincipalId: () => USER_ID });
  channelStore.getState().resetPrincipal(USER_ID);
  channelStore.getState().replaceSnapshot({ channels: [value] });
  channelStore.getState().setDraft(CHANNEL_ID, {
    text: 'Keep this exact draft',
    attachmentIds: ['e0000000-0000-4000-8000-000000000001'],
  });
  Object.assign(channelStore.getInitialState(), channelStore.getState());
  return renderToStaticMarkup(
    <I18nProvider>
      <BotComposer
        botId={BOT_ID}
        channel={value}
        runtimeState={runtimeState}
        runtimeAvailable={runtimeAvailable}
        channelStore={channelStore}
      />
    </I18nProvider>,
  );
};

describe('BotComposer', () => {
  test('submits Enter but preserves Shift+Enter and IME composition', () => {
    expect(shouldSubmitBotComposerKey({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true);
    expect(shouldSubmitBotComposerKey({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false);
    expect(shouldSubmitBotComposerKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSubmitBotComposerKey({ key: 'a', shiftKey: false, isComposing: false })).toBe(false);
  });

  test('renders Docker stopped copy exactly and leaves the draft and attachment visible', () => {
    const markup = renderComposer(channel('owner', true), 'docker_stopped', false);

    expect(markup).toContain('Docker Desktop isn’t running');
    expect(markup).toContain('Keep this exact draft');
    expect(markup).toContain('Attachment 1');
    expect(markup).not.toContain('>Setup<');
    expect(resolveBotRuntimeMessageKey('docker_stopped')).toBe('bots.runtime.dockerStopped');
  });

  test('uses repair-specific copy for a degraded runtime', () => {
    expect(resolveBotRuntimeMessageKey('runtime_degraded')).toBe('bots.runtime.needsRepair');
  });

  test('keeps Readers read-only while Collaborators retain composer access', () => {
    const readerMarkup = renderComposer(channel('reader', false));
    const collaboratorMarkup = renderComposer(channel('collaborator', true));

    expect(readerMarkup).toContain('This shared channel is read only');
    expect(readerMarkup).toContain('Reader · read only');
    expect(readerMarkup).toContain('disabled=""');
    expect(collaboratorMarkup).toContain('Continue the conversation…');
    expect(collaboratorMarkup).not.toContain('This shared channel is read only');
  });

  test('exposes accessible form, file, removal, and send controls', () => {
    const markup = renderComposer(channel('owner', true));

    expect(markup).toContain('aria-label="Send a Message to This Bot"');
    expect(markup).toContain('aria-label="Attach Private Files"');
    expect(markup).toContain('multiple=""');
    expect(markup).toContain('.png');
    expect(markup).toContain('image/png');
    expect(markup).toContain('aria-label="Remove Attachment 1"');
    expect(markup).toContain('aria-label="Send Message"');
    expect(markup).not.toContain('Enter to send');
    expect(markup).not.toContain('Shift+Enter');
  });

  test('keeps the private file picker available as the drag-and-drop fallback', () => {
    const markup = renderComposer(channel('owner', true));

    expect(markup).toContain('aria-label="Attach Private Files"');
    expect(markup).toContain('type="file"');
    expect(markup).toContain('multiple=""');
  });
});
