import React from 'react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { BotsPage } from './BotsPage';
import { getPendingBotAction, removeBotFromCatalog } from './botManagementPresentation';
import { managementDetail } from './botManagementTestFixtures';

const testDir = dirname(fileURLToPath(import.meta.url));

describe('BotsPage', () => {
  test('renders the catalog and Manager editor as a single settings surface', () => {
    const detail = managementDetail();
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotsPage initialCatalog={[detail.bot]} initialDetail={detail} initialCanCreateBot vscodeRuntime={false} />
      </I18nProvider>,
    );

    expect(markup).toContain('>Bots</h2>');
    expect(markup).not.toContain('Bot catalog');
    expect(markup).toContain('Research Desk');
    expect(markup).toContain('Profile');
    expect(markup).toContain('Description');
    expect(markup).toContain('Soul');
    expect(markup).toContain('Standing Role');
    expect(markup).toContain('Objectives · One per Line');
    expect(markup).not.toContain('Short Summary');
    expect(markup).not.toContain('Operating Instructions');
    expect(markup).toContain('Apply Changes');
    expect(markup).toContain('Create Bot');
  });

  test('renders a deliberate VS Code boundary without exposing setup controls', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider><BotsPage vscodeRuntime /></I18nProvider>,
    );

    expect(markup).toContain('Bots require the DevRyan macOS app');
    expect(markup).toContain('VS Code never starts or mutates Docker resources');
    expect(markup).not.toContain('Setup Docker');
  });

  test('keeps creation failures visible inside the creation dialog', () => {
    const source = readFileSync(resolve(testDir, 'BotsPage.tsx'), 'utf8');

    expect(source).toContain('setRequestError(null);');
    expect(source).toContain('data-bot-create-error');
    expect(source).toContain('role="alert"');
    expect(source).toContain('{requestError.message}');
    expect(source).toContain('{requestError.code}');
  });

  test('uses a native keyboard-activatable plus button and the shared Dialog primitive', () => {
    const pageSource = readFileSync(resolve(testDir, 'BotsPage.tsx'), 'utf8');
    const gallerySource = readFileSync(resolve(testDir, 'BotGallery.tsx'), 'utf8');

    expect(pageSource).toContain('<Dialog open={createOpen}');
    expect(pageSource).toContain('<DialogContent');
    expect(gallerySource).toContain('type="button"');
    expect(gallerySource).toContain('aria-haspopup="dialog"');
    expect(gallerySource).toContain('onClick={onCreate}');
    expect(gallerySource).toContain('h-9 w-9 shrink-0 cursor-pointer');
    expect(gallerySource).toContain('app-region-no-drag');
    expect(gallerySource).not.toContain('onKeyDown');
    expect(gallerySource).not.toContain('TooltipTrigger');
    expect(gallerySource).toContain('<ul aria-label="Bots"');
    expect(gallerySource).toContain('<li key={bot.id}>');
  });

  test('keeps the newly-created management detail authoritative and separates Catalog authorization from request errors', () => {
    const source = readFileSync(resolve(testDir, 'BotsPage.tsx'), 'utf8');

    expect(source).toContain('detail?.bot.id === selectedBotId');
    expect(source).toContain("requestError || catalogError ? 'Unable to load Bots'");
    expect(source).toContain('error={catalogError}');
    expect(source).toContain('canCreate={canCreate}');
    expect(source).not.toContain('canCreate={canCreate && requestError === null}');
    expect(source).toContain('result.canCreateBot === true');
    const createStart = source.indexOf('runCreateMutation(async');
    const createEnd = source.indexOf('</form>', createStart);
    expect(source.slice(createStart, createEnd)).not.toContain('useBotsStore.getState().upsertBot');
  });

  test('prepares the desktop runtime and retries blocked activation inside one action', () => {
    const source = readFileSync(resolve(testDir, 'BotsPage.tsx'), 'utf8');

    expect(source).toContain('resolveBotRuntimeRecovery(current, desktopApi.isAvailable())');
    expect(source).toContain("if (kind === 'setup') await desktopApi.setup();");
    expect(source).toContain("else if (kind === 'update') await desktopApi.update();");
    expect(source).toContain('else await desktopApi.repair();');
    expect(source).toContain('runtimeRecoveryAttempted');
    expect(source).toContain('applyPublished(await publish(');
    expect(source).toContain('const savedRevision = refreshed.revisions.find');
    expect(source).not.toContain('Choose Save & Publish again.');
    expect(source).toContain('useBotRuntimeOperation(desktopApi)');
    expect(source).toContain('botRuntimeProgressLabel(runtimeOperation.progress, t)');
    expect(source).toContain('runtimeOperation.pending');
    expect(source).toContain("runtimeOperation.progress?.phase === 'failed'");
    expect(source).toContain('runtimeOperation.progress.message || null');
  });

  test('creates a derived revision only when an active Bot identity is applied', () => {
    const source = readFileSync(resolve(testDir, 'BotsPage.tsx'), 'utf8');
    const publishStart = source.indexOf('onPublishRevision=');
    const publishEnd = source.indexOf('runtimeRecoveryKind=', publishStart);
    const handler = source.slice(publishStart, publishEnd);

    expect(handler).toContain('if (revision.activatedAt !== null)');
    expect(handler).toContain('api.createBotRevision(detail.bot.id');
    expect(handler).toContain('basedOnRevisionId: revision.id');
    expect(handler).toContain('revisionToPublish = created.revision');
    expect(handler).toContain('publish(revisionToPublish, detailForPublish, true)');
    expect(handler).not.toContain('if (revision.activatedAt === null)');
  });

  test('submits complete deletion once and removes a deleted Bot from the catalog', () => {
    const source = readFileSync(resolve(testDir, 'BotsPage.tsx'), 'utf8');

    expect(source).toContain("runBotMutation(detail.bot.id, 'purge-complete'");
    expect(source).toContain('api.deleteBotCompletely(detail.bot.id, request)');
    expect(source).toContain('if (result.purge.botDeleted)');
    const deleteStart = source.indexOf("runBotMutation(detail.bot.id, 'purge-complete'");
    const deleteEnd = source.indexOf('onRetryPurge', deleteStart);
    const deleteHandler = source.slice(deleteStart, deleteEnd);
    expect(deleteHandler.indexOf('invalidateBot(detail.bot.id);')).toBeLessThan(deleteHandler.indexOf('await loadCatalog();'));
    expect(source).toContain('await loadCatalog();');
  });

  test('clears the owner chat channel and creates an empty replacement', () => {
    const source = readFileSync(resolve(testDir, 'BotsPage.tsx'), 'utf8');
    const clearStart = source.indexOf("runBotMutation(detail.bot.id, 'clear-chat-history'");
    const clearEnd = source.indexOf('onDeleteCompletely=', clearStart);
    const clearHandler = source.slice(clearStart, clearEnd);

    expect(clearHandler).toContain('api.deleteBotChannel(ownerChannelId)');
    expect(clearHandler).toContain('removeChannel(ownerChannelId)');
    expect(clearHandler).toContain('api.getOrCreateOwnerChannel(detail.bot.id)');
    expect(clearHandler).toContain('upsertChannel(replacement.channel)');
    expect(clearHandler).toContain('setPublicationNotice(result.notice');
  });

  test('scopes pending mutations to the Bot being edited and tracks creation separately', () => {
    const pending = {
      'bot-a': { action: 'purge-complete', token: 1 },
    } as const;

    expect(getPendingBotAction(pending, 'bot-a')).toBe('purge-complete');
    expect(getPendingBotAction(pending, 'bot-b')).toBeNull();

    const source = readFileSync(resolve(testDir, 'BotsPage.tsx'), 'utf8');
    expect(source).toContain('const [pendingBotMutations, setPendingBotMutations]');
    expect(source).toContain('const [creating, setCreating]');
    expect(source).toContain('getPendingBotAction(pendingBotMutations, detail?.bot.id || null)');
  });

  test('invalidates deleted and missing Bots before authoritative catalog reconciliation', () => {
    const first = managementDetail().bot;
    const second = { ...first, id: 'bot-2', name: 'Second Bot' };

    expect(removeBotFromCatalog([first, second], first.id)).toEqual([second]);

    const source = readFileSync(resolve(testDir, 'BotsPage.tsx'), 'utf8');
    expect(source).toContain("error.code === 'bot_not_found'");
    expect(source).toContain('invalidateBot(botId);');
    expect(source).toContain("window.addEventListener('focus', refreshOnFocus)");
    expect(source).toContain("document.addEventListener('visibilitychange', refreshOnVisibility)");
    expect(source).toContain("document.visibilityState === 'visible'");
    expect(source).toContain('if (selectedBotId || catalog.length === 0) return;');
  });
});
