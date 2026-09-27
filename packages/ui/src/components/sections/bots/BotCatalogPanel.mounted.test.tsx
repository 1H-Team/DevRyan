import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';

import { withDom } from '@/components/bots/chat/botMountedDom';
import { I18nProvider } from '@/lib/i18n';
import { botsApi, type BotCatalogBackup, type BotCatalogStatus, type BotsApi } from '@/lib/botsApi';
import { BotCatalogPanel } from './BotCatalogPanel';

const backup: BotCatalogBackup = {
  id: '20260926T010000Z-0000abcd',
  kind: 'daily',
  createdAt: '2026-09-26T01:00:00.000Z',
  verifiedAt: '2026-09-26T01:00:05.000Z',
  schemaHead: '20260926000000_local_identity.sql',
  objectCount: 3,
  bytes: 4096,
};

const status = (overrides: Partial<BotCatalogStatus> = {}): BotCatalogStatus => ({
  state: 'ready',
  code: null,
  schema: null,
  maintenance: null,
  activationHold: null,
  viewerIsOwner: true,
  import: { cloud: null, import: null, pending: false },
  ...overrides,
});

type Found = { click(): void } | null;
type Searchable = { find: (predicate: (node: { tagName: string; textContent: string | null }) => boolean) => unknown };
const buttons = (container: Searchable, label: string): Found => (
  container.find((node) => node.tagName === 'BUTTON' && node.textContent === label) as Found
);


describe('mounted Bot catalog panel', () => {
  test('renders nothing in compact mode when the catalog needs no action', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const api: BotsApi = { ...botsApi, getCatalogStatus: async () => status() };
    try {
      await act(async () => { root.render(<I18nProvider><BotCatalogPanel api={api} /></I18nProvider>); });
      expect(container.textContent).toBe('');
    } finally { await act(async () => { root.unmount(); }); }
  }));

  test('resumes held Bots with one control and reports the change', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    let held = true;
    let changed = 0;
    const api: BotsApi = {
      ...botsApi,
      getCatalogStatus: async () => status({ activationHold: held ? { reason: 'import', createdAt: '' } : null }),
      resumeBotActivation: async () => { held = false; return { resumed: true }; },
    };
    try {
      await act(async () => { root.render(<I18nProvider><BotCatalogPanel api={api} onCatalogChanged={() => { changed += 1; }} /></I18nProvider>); });
      expect(container.textContent).toContain('Bots Are Paused');
      await act(async () => { buttons(container, 'Resume Bots')?.click(); });
      expect(changed).toBe(1);
      expect(container.textContent).toBe('');
    } finally { await act(async () => { root.unmount(); }); }
  }));

  // The confirmation dialog portals outside this minimal DOM; the server
  // additionally refuses a restore without the exact confirmation string.
  test('offers the latest verified backup and never restores without confirmation', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const restored: Array<[string, string]> = [];
    const api: BotsApi = {
      ...botsApi,
      getCatalogStatus: async () => status({ state: 'recovery_required', code: 'bot_database_identity_changed' }),
      listCatalogBackups: async () => ({ backups: [backup] }),
      restoreCatalog: async (backupId, confirmation) => { restored.push([backupId, confirmation]); return {}; },
    };
    try {
      await act(async () => { root.render(<I18nProvider><BotCatalogPanel api={api} /></I18nProvider>); });
      expect(container.textContent).toContain('Bot Storage Needs Recovery');
      expect(container.textContent).toContain('Restore the latest verified backup');
      expect(buttons(container, 'Start Empty')).toBeNull();
      await act(async () => { buttons(container, 'Restore Backup')?.click(); });
      expect(restored).toEqual([]);
    } finally { await act(async () => { root.unmount(); }); }
  }));

  test('shows recovery status without controls to a user who is not the owner', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    let listed = 0;
    const api: BotsApi = {
      ...botsApi,
      getCatalogStatus: async () => status({ state: 'recovery_required', viewerIsOwner: false }),
      listCatalogBackups: async () => { listed += 1; return { backups: [backup] }; },
    };
    try {
      await act(async () => { root.render(<I18nProvider><BotCatalogPanel api={api} /></I18nProvider>); });
      expect(container.textContent).toContain('Only this computer\'s owner can restore Bot storage.');
      expect(buttons(container, 'Restore Backup')).toBeNull();
      expect(listed).toBe(0);
    } finally { await act(async () => { root.unmount(); }); }
  }));
});

test('polls pending hosted discovery until completion and keeps failures separate from local storage', async () => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  let calls = 0;
  let checking = true;
  let failed = false;
  const api: BotsApi = { ...botsApi, getCatalogStatus: async () => {
    calls += 1;
    return status({ import: { checking, cloud: checking ? null : { hasBots: !failed, checkedAt: '', code: failed ? 'bot_import_source_unavailable' : null }, pending: !checking && !failed, import: null } });
  } };
  try {
    await act(async () => { root.render(<I18nProvider><BotCatalogPanel api={api} /></I18nProvider>); });
    expect(container.textContent).toContain('Checking for Hosted Bots');
    checking = false;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_100)); });
    expect(calls).toBe(2);
    expect(container.textContent).toContain('Hosted Bots Can Be Imported');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_100)); });
    expect(calls).toBe(2);
    failed = true;
    await act(async () => { root.render(<I18nProvider><BotCatalogPanel api={api} capabilityState="ready" /></I18nProvider>); });
    expect(container.textContent).toContain('Could Not Check Hosted Bots');
    expect(container.textContent).toContain('Bots already on this computer remain available');
    expect(container.textContent).toContain('bot_import_source_unavailable');
  } finally { await act(async () => { root.unmount(); });  }
}), 10_000);
