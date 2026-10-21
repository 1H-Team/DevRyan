import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import { I18nProvider } from '@/lib/i18n';
import { settingsDict } from '@/lib/i18n/messages/en.settings';
import type { AgentBrowserInstallerStatus } from '@/lib/desktop';
const toasts: string[] = [];
const actualUi = await import('@/components/ui');
mock.module('@/components/ui', () => ({
  ...actualUi,
  toast: { ...actualUi.toast, success: (message: string) => { toasts.push(`success:${message}`); }, error: (message: string) => { toasts.push(`error:${message}`); } },
}));
const { AgentBrowserControlSettings } = await import('./AgentBrowserControlSettings');

const dict: Record<string, string> = settingsDict;
const label = (key: string) => dict[`settings.devryan.agentBrowserControl.${key}`] ?? key;

type Invocation = { command: string; args: Record<string, unknown> };
let invocations: Invocation[] = [];
let statusQueue: AgentBrowserInstallerStatus[] = [];
let repairResult: AgentBrowserInstallerStatus | null = null;
let persistedSetting: boolean | undefined;
let fetchCalls: Array<{ url: string; method: string }> = [];
const originalFetch = globalThis.fetch;

const readyStatus = (overrides: Partial<AgentBrowserInstallerStatus> = {}): AgentBrowserInstallerStatus => ({
  ok: true, state: 'ready', expectedVersion: '1.2.3', installedVersion: '1.2.3', binaryPath: '/bin/agent-browser',
  activeLeaseCount: 0, ...overrides,
});

beforeEach(() => {
  invocations = [];
  pollTimers.clear();
  toasts.length = 0;
  statusQueue = [readyStatus()];
  repairResult = readyStatus({ applied: true, restartSucceeded: true });
  persistedSetting = undefined;
  fetchCalls = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), method: init?.method ?? 'GET' });
    return Response.json(persistedSetting === undefined ? {} : { agentBrowserControlEnabled: persistedSetting });
  }, { preconnect: () => {} });
});
afterEach(() => { globalThis.fetch = originalFetch; });

type Listener = (event: object) => void;
// The installer poll (500 ms window.setTimeout) is captured and fired on demand instead of slept.
const pollTimers = new Map<number, () => void>();
let nextPollTimer = 1;
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
const firePoll = async () => {
  const due = [...pollTimers.values()];
  pollTimers.clear();
  await act(async () => { for (const fire of due) fire(); await new Promise((resolve) => realSetTimeout(resolve, 0)); });
};
const installShell = (electron: boolean): Map<string, Listener[]> => {
  const listeners = new Map<string, Listener[]>();
  const invoke = async (command: string, args: Record<string, unknown> = {}) => {
    invocations.push({ command, args });
    if (command === 'desktop_agent_browser_status') return statusQueue.length > 1 ? statusQueue.shift() : statusQueue[0];
    if (command === 'desktop_agent_browser_repair') return repairResult;
    if (command === 'desktop_set_agent_browser_control') return { enabled: args.enabled };
    return null;
  };
  Object.assign(globalThis.window, {
    location: { origin: 'http://127.0.0.1:3001', search: '' },
    ...(electron ? {
      __DEVRYAN_ELECTRON__: { runtime: 'electron' },
      __DEVRYAN_LOCAL_ORIGIN__: 'http://127.0.0.1:3001',
      __TAURI__: { core: { invoke } },
    } : {}),
    setTimeout: (handler: () => void, delay?: number) => {
      if (delay !== 500) return realSetTimeout(handler, delay);
      const id = nextPollTimer++;
      pollTimers.set(id, handler);
      return id;
    },
    clearTimeout: (id: number) => { if (!pollTimers.delete(id)) realClearTimeout(id); },
    addEventListener: (name: string, listener: Listener) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
    removeEventListener: (name: string, listener: Listener) => { listeners.set(name, (listeners.get(name) ?? []).filter((candidate) => candidate !== listener)); },
  });
  return listeners;
};

const flush = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); }); };
const mount = async (electron: boolean, run: (container: HostElement, listeners: Map<string, Listener[]>) => Promise<void>) => withDom(async (container) => {
  const listeners = installShell(electron);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => { root.render(<I18nProvider><AgentBrowserControlSettings /></I18nProvider>); });
    await flush();
    await run(container, listeners);
  } finally { await act(async () => root.unmount()); }
});
const toggleRow = (container: HostElement) => container.find((node) => node.getAttribute('role') === 'button');
const button = (container: HostElement, text: string) => container.find((node) => node.tagName === 'BUTTON' && node.textContent.includes(text));
const controlCalls = () => invocations.filter((call) => call.command === 'desktop_set_agent_browser_control');
const statusCalls = () => invocations.filter((call) => call.command === 'desktop_agent_browser_status');

describe('AgentBrowserControlSettings', () => {
  test('renders only in the local-origin Electron shell', async () => {
    await mount(false, async (container) => {
      expect(container.textContent).toBe('');
      expect(fetchCalls).toEqual([]);
      expect(invocations).toEqual([]);
    });
    await mount(true, async (container) => {
      expect(container.textContent).toContain(label('title'));
    });
  });

  test('defaults to enabled unless explicitly persisted as false', async () => {
    await mount(true, async (container) => {
      await act(async () => toggleRow(container)?.click());
      await flush();
      expect(controlCalls().map((call) => call.args)).toEqual([{ enabled: false }]);
    });
    invocations = [];
    persistedSetting = false;
    await mount(true, async (container) => {
      await act(async () => toggleRow(container)?.click());
      await flush();
      expect(controlCalls().map((call) => call.args)).toEqual([{ enabled: true }]);
    });
  });

  test('persists and enforces the setting in one authoritative desktop IPC operation', async () => {
    await mount(true, async (container) => {
      fetchCalls = [];
      await act(async () => toggleRow(container)?.click());
      await flush();
      expect(controlCalls()).toHaveLength(1);
      expect(fetchCalls.filter((call) => call.method !== 'GET')).toEqual([]);
    });
  });

  test('repeatedly polls pending installer status until it reaches a terminal state', async () => {
    statusQueue = [readyStatus({ state: 'pending', ok: false }), readyStatus({ state: 'pending', ok: false }), readyStatus()];
    await mount(true, async (container) => {
      expect(container.textContent).toContain(label('installer.preparing'));
      expect(pollTimers.size).toBe(1);
      await firePoll();
      await flush();
      expect(pollTimers.size).toBe(1);
      await firePoll();
      await flush();
      expect(statusCalls()).toHaveLength(3);
      expect(container.textContent).toContain(label('installer.ready'));
      // Terminal state: nothing is scheduled, so no further status request can follow.
      expect(pollTimers.size).toBe(0);
      await firePoll();
      expect(statusCalls()).toHaveLength(3);
    });
  });

  test('stops polling when unmounted while still pending', async () => {
    statusQueue = [readyStatus({ state: 'pending', ok: false })];
    await mount(true, async () => { expect(pollTimers.size).toBe(1); });
    const afterUnmount = statusCalls().length;
    // Unmount cleared the scheduled poll; firing whatever is left must not request status again.
    expect(pollTimers.size).toBe(0);
    await firePoll();
    expect(statusCalls()).toHaveLength(afterUnmount);
  });

  test('shows versions, the global lease total, and skill conflicts', async () => {
    statusQueue = [readyStatus({
      activeLeaseCount: 1,
      skill: { state: 'conflict', conflicts: [{ code: 'x', message: 'Skill conflict at /secret/path', path: '/secret/path' }] },
    })];
    await mount(true, async (container, listeners) => {
      expect(container.textContent).toContain('1.2.3');
      expect(container.textContent).toContain('Skill conflict at /secret/path');
      expect(container.textContent).not.toContain('"path"');
      await act(async () => {
        for (const listener of listeners.get('browser-agent-lease-total') ?? []) listener({ detail: { activeLeaseCount: 4 } });
      });
      expect(container.textContent).toContain(`${label('installer.activeLeases')}4`);
    });
  });

  test('only reports repair success after setup was applied and managed OpenCode restarted', async () => {
    for (const [result, failed] of [
      [readyStatus({ applied: true, restartSucceeded: true }), false],
      [readyStatus({ applied: true, restartSucceeded: false, ok: false, issues: [{ code: 'restart', message: 'OpenCode restart failed' }] }), true],
      [readyStatus({ applied: false, restartSucceeded: true, issues: [{ code: 'apply', message: 'Setup not applied' }] }), true],
    ] as const) {
      repairResult = result;
      toasts.length = 0;
      await mount(true, async (container) => {
        await act(async () => button(container, label('installer.repair'))?.click());
        await flush();
        const issue = result.issues?.[0]?.message;
        if (failed) expect(toasts).toEqual([`error:${issue}`]);
        else expect(toasts).toEqual([`success:${label('installer.toast.repaired')}`]);
      });
    }
  });

  test('describes hidden leases and per-lease local capabilities', () => {
    const description = Object.entries(dict).filter(([key]) => key.includes('agentBrowserControl')).map(([, value]) => value).join('\n');
    expect(description).toContain('Agent browser leases start hidden');
    expect(description).toContain('Each lease uses a separate local-only capability');
    expect(description).not.toContain('while you watch');
    expect(description).not.toContain('per-session token');
  });
});
