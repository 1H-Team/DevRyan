import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { BotMemoryDetail, BotsApi } from '@/lib/botsApi';
import { BotMemoryConsole } from './BotMemoryConsole';
import { BotMemoryEditor } from './BotMemoryEditor';
import { BotEditor } from './BotEditor';
import { managementDetail } from './botManagementTestFixtures';

const BOT_ID = '11111111-1111-4111-8111-111111111111';
const MEMORY_ID = '22222222-2222-4222-8222-222222222222';
const VERSION_ID = '33333333-3333-4333-8333-333333333333';
const SOURCE_ID = '44444444-4444-4444-8444-444444444444';
const TIMESTAMP = '2026-08-23T12:00:00.000Z';

const detail: BotMemoryDetail = {
  memory: {
    id: MEMORY_ID,
    botId: BOT_ID,
    scope: 'shared',
    subjectUserId: null,
    logicalKey: 'deployment.region',
    content: { text: 'The production region is eu-west-1.' },
    sensitivity: 'normal',
    confidence: 0.94,
    activeVersionId: VERSION_ID,
    activeCreatorKind: 'manager',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    tombstonedAt: null,
  },
  versions: [{
    id: VERSION_ID,
    memoryId: MEMORY_ID,
    versionNumber: 2,
    content: { text: 'The production region is eu-west-1.' },
    classifierMetadata: { managerEdit: true },
    creatorKind: 'manager',
    createdBy: '55555555-5555-4555-8555-555555555555',
    createdAt: TIMESTAMP,
  }],
  sources: [{
    id: SOURCE_ID,
    memoryVersionId: VERSION_ID,
    channelId: '66666666-6666-4666-8666-666666666666',
    runId: '77777777-7777-4777-8777-777777777777',
    messageId: '88888888-8888-4888-8888-888888888888',
    sourceKind: 'run',
    sourceMetadata: {},
    sourceTombstonedAt: TIMESTAMP,
    createdAt: TIMESTAMP,
  }],
};

describe('BotMemoryConsole', () => {
  test('renders a concise remembered/forgotten view without preloading content during SSR', () => {
    const api = {} as BotsApi;
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotMemoryConsole botId={BOT_ID} api={api} />
      </I18nProvider>,
    );
    expect(markup).toContain('Useful facts this Bot keeps between conversations.');
    expect(markup).toContain('Remembered');
    expect(markup).toContain('Forgotten');
    expect(markup).not.toContain('Rebuild Local Index');
    expect(markup).not.toContain('The production region is eu-west-1.');
  });

  test('shows the useful memory content without technical provenance controls', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotMemoryEditor
          detail={detail}
          onSave={() => {}}
          onTombstone={() => {}}
          onRestore={() => {}}
        />
      </I18nProvider>,
    );
    expect(markup).toContain('deployment.region');
    expect(markup).toContain('The production region is eu-west-1.');
    expect(markup).toContain('What the Bot Remembers');
    expect(markup).toContain('Forget</button>');
    expect(markup).not.toContain('Immutable Versions');
    expect(markup).not.toContain('Provenance');
  });

  test('does not expose the memory console navigation to ordinary members', () => {
    const callbacks = {
      onAssignMembership: () => {},
      onRevokeMembership: () => {},
      onSaveCredential: () => {},
      onTransition: () => {},
    };
    const managerMarkup = renderToStaticMarkup(
      <I18nProvider>
        <BotEditor
          detail={managementDetail()}
          activationHealth={null}
          {...callbacks}
        />
      </I18nProvider>,
    );
    const memberMarkup = renderToStaticMarkup(
      <I18nProvider>
        <BotEditor
          detail={{ ...managementDetail(), canManage: false }}
          activationHealth={null}
          {...callbacks}
        />
      </I18nProvider>,
    );
    expect(managerMarkup).toContain('Memory</button>');
    expect(memberMarkup).not.toContain('Memory</button>');
  });
});
