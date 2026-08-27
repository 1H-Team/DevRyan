import React from 'react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { BotComputerFiles as BotComputerFilesResult, BotsApi } from '@/lib/botsApi';
import { BotComputerFiles } from './BotComputerFiles';
import { botComputerFilesUnavailableCopy } from './BotComputerFiles.copy';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';

const apiReturning = (result: BotComputerFilesResult) => ({
  listBotComputerFiles: async () => result,
} as unknown as Pick<BotsApi, 'listBotComputerFiles'>);

const render = (api: Pick<BotsApi, 'listBotComputerFiles'>) => renderToStaticMarkup(
  <I18nProvider>
    <BotComputerFiles botId={BOT_ID} api={api} />
  </I18nProvider>,
);

describe('BotComputerFiles', () => {
  test('describes one shared computer per Bot and never reads files during SSR', () => {
    const markup = render(apiReturning({
      available: true,
      state: 'ready',
      scope: 'workspace',
      rootLabel: 'Workspace',
      path: '',
      entries: [{
        path: 'secret.txt', name: 'secret.txt', kind: 'file', restricted: false,
        size: 4, modifiedAt: null,
      }],
      truncated: false,
    }));

    expect(markup).toContain('Computer files');
    expect(markup).toContain('One computer per Bot, shared by everyone on it.');
    expect(markup).toContain('automatically available as references');
    expect(markup).toContain('Add Files');
    expect(markup).toContain('Add Folder');
    // The listing is fetched in an effect, so no file name is in the SSR pass.
    expect(markup).not.toContain('secret.txt');
  });

  test('offers folder navigation anchored at the workspace root', () => {
    const markup = render(apiReturning({
      available: true,
      state: 'ready',
      scope: 'workspace',
      rootLabel: 'Workspace',
      path: '',
      entries: [],
      truncated: false,
    }));

    expect(markup).toContain('Folder Path');
    expect(markup).toContain('Workspace');
    expect(markup).toContain('Refresh');
  });

  test('explains runtime setup states instead of showing a generic availability error', () => {
    const source = readFileSync(new URL('./BotComputerFiles.copy.ts', import.meta.url), 'utf8');

    expect(source).toContain("state === 'docker_stopped'");
    expect(source).toContain('Start Docker, then activate the Bot');
    expect(source).toContain("state === 'setup_required'");
    expect(source).toContain('Activating the Bot prepares it automatically');
    expect(source).toContain("state === 'runtime_degraded' || state === 'runtime_unavailable'");
  });

  test('uses local runtime copy without the desktop-only warning', () => {
    const cases: ReadonlyArray<readonly [BotComputerFilesResult['state'], string]> = [
      ['setup_required', 'This Bot’s computer has not been set up yet.'],
      ['offline', 'This Bot’s computer is not running.'],
      ['runtime_unavailable', 'This Bot’s computer needs runtime recovery.'],
    ];

    for (const [state, title] of cases) {
      const copy = botComputerFilesUnavailableCopy(state);
      expect(copy.title).toBe(title);
      expect(`${copy.title} ${copy.detail}`).not.toContain('Open this Bot in the desktop app');
    }
  });

  test('keeps the saved-file listing visible when the computer is stopped', () => {
    const source = readFileSync(new URL('./BotComputerFiles.tsx', import.meta.url), 'utf8');
    expect(source).toContain('Computer stopped — showing saved files.');
    expect(source).toContain("listing?.available === true && listing.state === 'offline'");
  });

  test('connects imported computer files to Finder without restoring reference management', () => {
    const source = readFileSync(new URL('./BotComputerFiles.tsx', import.meta.url), 'utf8');
    expect(source).toContain('listBotComputerResources');
    expect(source).toContain('importBotComputerResource');
    expect(source).toContain('revealDesktopPath(localResource.sourcePath)');
    expect(source).toContain('Open in Finder');
    expect(source).not.toContain('Reference Library');
    expect(source).not.toContain('Manage Sources');
  });
});
