import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import { getAuthPrincipal, setAuthPrincipal } from '@/lib/authSession';
import { botsApi, BotsApiError, type BotsApi } from '@/lib/botsApi';
import { botsDesktopApi } from '@/lib/botsDesktopApi';
import { I18nProvider } from '@/lib/i18n';
import { useBotsStore } from '@/stores/useBotsStore';
import { BotsPage } from './BotsPage';
import { managementDetail } from './botManagementTestFixtures';

const desktopApi = { ...botsDesktopApi, isAvailable: () => false, runtimeServiceStatus: undefined };
const pause = () => new Promise((resolve) => setTimeout(resolve, 300));
const starting = () => new BotsApiError('Bots are still starting', { code: 'bots_starting', status: 503, retryable: true });
const ready = { available: false, catalogAvailable: true, state: 'healthy', code: null, owner: 'electron', canManageRuntime: true, canCreateBot: true };
const mount = async (container: HostElement, overrides: Partial<BotsApi>) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  useBotsStore.getState().setCapabilities({ ...ready, catalogAvailable: false });
  const api: BotsApi = {
    ...botsApi,
    getCatalogStatus: async () => ({ state: 'ready', code: null, schema: null, maintenance: null, activationHold: null, viewerIsOwner: false }),
    getBot: async () => { throw new BotsApiError('Detail unavailable', { status: 503, code: 'bot_database_unavailable' }); },
    ...overrides,
  };
  await act(async () => { root.render(<I18nProvider><BotsPage api={api} desktopApi={desktopApi} /></I18nProvider>); });
  return async () => { await act(async () => { root.unmount(); }); useBotsStore.getState().resetPrincipal(null); };
};

test('recovers a startup failure automatically and only then displays a successful empty catalog', async () => withDom(async (container) => {
  let calls = 0;
  const unmount = await mount(container, { listBots: async () => { if (++calls === 1) throw starting(); return { bots: [], canCreateBot: true }; } });
  try {
    expect(container.textContent).toContain('Starting Bot storage…');
    expect(container.textContent).not.toContain('No Bots assigned');
    await act(pause);
    expect(calls).toBe(2);
    expect(container.textContent).toContain('No Bots assigned');
    expect(container.textContent).not.toContain('Unable to load Bots');
    await act(pause);
    expect(calls).toBe(2);
  } finally { await unmount(); }
}));

test('catalog readiness retries immediately and refresh failures preserve loaded Bots', async () => withDom(async (container) => {
  let calls = 0;
  let focus: EventListenerOrEventListenerObject | null = null;
  const listener = spyOn(window, 'addEventListener').mockImplementation((name: string, callback: EventListenerOrEventListenerObject) => { if (name === 'focus') focus = callback; });
  const unmount = await mount(container, { listBots: async () => {
    calls += 1;
    if (calls !== 2) throw starting();
    return { bots: [managementDetail().bot], canCreateBot: true };
  } });
  try {
    await act(async () => { useBotsStore.getState().setCapabilities(ready); });
    expect(calls).toBe(2);
    expect(container.textContent).toContain('Research Desk');
    await act(async () => { if (typeof focus === 'function') focus(new Event('focus')); });
    expect(calls).toBe(3);
    expect(container.textContent).toContain('Research Desk');
    expect(container.textContent).toContain('bots_starting');
  } finally { await unmount(); listener.mockRestore(); }
}));

for (const failure of [
  new BotsApiError('Sign in required', { status: 401, code: 'auth_required', retryable: true }),
  new BotsApiError('Restore Bot storage', { status: 503, code: 'bot_database_recovery_required', retryable: false }),
]) test(`does not retry ${failure.code}`, async () => withDom(async (container) => {
  let calls = 0;
  const unmount = await mount(container, { listBots: async () => { calls += 1; throw failure; } });
  try {
    expect(container.textContent).toContain(failure.code);
    expect(container.textContent).not.toContain('No Bots assigned');
    await act(pause);
    expect(calls).toBe(1);
  } finally { await unmount(); }
}));

test('unmount cancels scheduled catalog retries', async () => withDom(async (container) => {
  let calls = 0;
  const unmount = await mount(container, { listBots: async () => { calls += 1; throw starting(); } });
  await unmount();
  await pause();
  expect(calls).toBe(1);
}));

test('identity changes discard pending responses from the previous identity', async () => withDom(async (container) => {
  const original = getAuthPrincipal();
  let resolveOld: (value: Awaited<ReturnType<BotsApi['listBots']>>) => void = () => {};
  let calls = 0;
  const unmount = await mount(container, { listBots: async () => {
    if (++calls === 1) return new Promise((resolve) => { resolveOld = resolve; });
    return { bots: [], canCreateBot: true };
  } });
  try {
    await act(async () => { setAuthPrincipal({ ...original, id: 'next-owner' }); });
    expect(calls).toBe(2);
    await act(async () => { resolveOld({ bots: [managementDetail().bot], canCreateBot: true }); });
    expect(container.textContent).not.toContain('Research Desk');
    expect(container.textContent).toContain('No Bots assigned');
  } finally { await unmount(); setAuthPrincipal(original); }
}));

test('shows the network failure while retrying instead of leaving an indefinite loading screen', async () => withDom(async (container) => {
  let calls = 0;
  const unmount = await mount(container, { listBots: async () => {
    calls += 1;
    throw new BotsApiError('Connection unavailable', { status: 0, code: 'network_error' });
  } });
  try {
    expect(container.textContent).toContain('Unable to load Bots');
    expect(container.textContent).toContain('network_error');
    await act(pause);
    expect(calls).toBe(2);
    expect(container.textContent).toContain('network_error');
  } finally { await unmount(); }
}));
