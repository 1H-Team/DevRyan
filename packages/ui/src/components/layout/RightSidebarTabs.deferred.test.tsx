import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { withDom } from '@/components/bots/chat/botMountedDom';

let requested = 0;
let mounted = 0;
let released = 0;
let releaseImport: () => void = () => {};
const pendingImport = new Promise<void>((resolve) => { releaseImport = resolve; });
const deferred = <Props extends object>(loader: () => Promise<{ default: React.ComponentType<Props> }>) => React.lazy(async () => {
  requested += 1;
  await pendingImport;
  return loader();
});
mock.module('@/lib/chunkLoadRecovery', () => ({
  lazyWithChunkRecovery: deferred,
  retryableLazyWithChunkRecovery: deferred,
  importWithChunkRecovery: <Result,>(loader: () => Promise<Result>) => loader(),
}));
mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => undefined }));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({}) }));
mock.module('@/components/ui/sortable-tabs-strip', () => ({ SortableTabsStrip: () => null }));
mock.module('./SidebarFilesTree', () => ({ SidebarFilesTree: () => <div>Files panel</div> }));
mock.module('@/components/bots/operations/BotOperationsRail', () => ({
  BotOperationsRail: ({ botId, channelId }: { botId: string; channelId: string | null }) => {
    React.useEffect(() => { mounted += 1; return () => { released += 1; }; }, []);
    return <div data-loaded-operations>{botId}:{channelId}</div>;
  },
}));

const { getAuthPrincipal, setAuthPrincipal } = await import('@/lib/authSession');
const { I18nProvider } = await import('@/lib/i18n');
const { useBotChannelStore } = await import('@/stores/useBotChannelStore');
const { useBotsStore } = await import('@/stores/useBotsStore');
const { useMainSidebarAudienceStore } = await import('@/stores/useMainSidebarAudienceStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { RightSidebarTabs } = await import('./RightSidebarTabs');

test('operations code loads only for an open authorized Bots rail and never mounts after a hidden pending import', async () => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  const originalPrincipal = getAuthPrincipal();
  const principal = { ...originalPrincipal, id: 'rail-member', scope: 'managed' as const, policy: { ...originalPrincipal.policy, bots: true } };
  setAuthPrincipal(principal);
  useBotsStore.getState().resetPrincipal(principal.id);
  useBotChannelStore.getState().resetPrincipal(principal.id);
  useBotsStore.getState().upsertBot({ id: 'rail-bot', name: 'Rail Bot', title: '', summary: '', avatarUrl: null, avatarFallback: null, lifecycle: 'active', tenancy: 'team', activeRevisionId: 'rail-revision', createdAt: '', updatedAt: '', retiredAt: null });
  useBotsStore.getState().selectBot('rail-bot');
  useBotChannelStore.getState().upsertChannel({ id: 'rail-channel', botId: 'rail-bot', ownerUserId: principal.id, accessRole: 'owner', canSend: true, lifecycle: 'active', currentCheckpointNumber: 0, lastMessageSequence: 0, lastMessageAt: null, createdAt: '', updatedAt: '', archivedAt: null });
  useMainSidebarAudienceStore.getState().setAudience('bots');
  useUIStore.setState({ isRightSidebarOpen: false, rightSidebarTab: 'files' });
  try {
    await act(async () => { root.render(<I18nProvider><RightSidebarTabs /></I18nProvider>); });
    expect(requested).toBe(0);
    await act(async () => { useMainSidebarAudienceStore.getState().setAudience('coding-agents'); useUIStore.getState().setRightSidebarOpen(true); });
    expect(container.textContent).toContain('Files panel');
    expect(requested).toBe(0);
    await act(async () => { useMainSidebarAudienceStore.getState().setAudience('bots'); });
    expect(requested).toBe(1);
    expect(mounted).toBe(0);
    await act(async () => { useUIStore.getState().setRightSidebarOpen(false); releaseImport(); });
    expect(mounted).toBe(0);
    expect(container.find((node) => node.hasAttribute('data-loaded-operations'))).toBeNull();
    await act(async () => { useUIStore.getState().setRightSidebarOpen(true); });
    expect(container.textContent).toContain('rail-bot:rail-channel');
    expect(requested).toBe(1);
    expect(mounted).toBe(1);
    await act(async () => { useMainSidebarAudienceStore.getState().setAudience('coding-agents'); });
    expect(released).toBe(1);
    await act(async () => { useMainSidebarAudienceStore.getState().setAudience('bots'); });
    expect(mounted).toBe(2);
    await act(async () => { setAuthPrincipal({ ...principal, policy: { ...principal.policy, bots: false } }); });
    expect(released).toBe(2);
    expect(container.find((node) => node.hasAttribute('data-loaded-operations'))).toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
    setAuthPrincipal(originalPrincipal);
    useBotsStore.getState().resetPrincipal(null);
    useBotChannelStore.getState().resetPrincipal(null);
    useMainSidebarAudienceStore.getState().setAudience('coding-agents');
    useUIStore.getState().setRightSidebarOpen(false);
  }
}), 30_000);
