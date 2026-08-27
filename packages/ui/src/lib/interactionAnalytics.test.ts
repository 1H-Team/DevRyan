import { describe, expect, test } from 'bun:test';

import { createInteractionAnalyticsCollector } from './interactionAnalytics';
import type { AuthPrincipal } from './authSession';

const principal: AuthPrincipal = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'developer@example.test',
  displayName: 'Developer',
  role: 'developer',
  scope: 'managed',
  policy: {
    settingsPages: [], bots: true, files: true, terminal: true, browser: true, createWorktrees: false, createBranches: false, manageProjects: false, manageUsers: false,
    manageGlobalSettings: false, manageGit: true, push: false, github: false,
  },
  assignments: [{
    projectId: 'project-1', label: 'Test', branchName: 'main', publicDirectory: '/repo',
    githubAccountId: null, isDefault: true,
  }],
};

const makeStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
};

const makeDocument = () => {
  const listeners = new Map<string, EventListener>();
  return {
    visibilityState: 'visible',
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.set(type, listener as EventListener);
    },
    removeEventListener: (type: string) => listeners.delete(type),
    getSelection: () => ({ toString: () => 'selected text' }),
    dispatch: (type: string, target: EventTarget) => listeners.get(type)?.({ target } as Event),
  };
};

describe('interaction analytics collector', () => {
  test('captures a programmatic execCommand copy exactly once and never persists its text', () => {
    const storage = makeStorage();
    const documentRef = makeDocument();
    const collector = createInteractionAnalyticsCollector({
      document: documentRef as unknown as Document,
      storage,
      getPrincipal: () => principal,
      getDirectory: () => '/repo',
      randomUuid: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      setTimeoutImpl: (() => 1) as unknown as typeof setTimeout,
      clearTimeoutImpl: (() => undefined) as typeof clearTimeout,
    });
    collector.initialize();

    collector.suppressNextNativeCopy();
    documentRef.dispatch('copy', { closest: () => null } as unknown as EventTarget);
    collector.recordProgrammaticCopy('private clipboard contents', {
      sourceSurface: 'files', copyKind: 'path', path: '/repo/package.json',
    });

    const stored = [...storage.values.values()].join('');
    const events = JSON.parse(stored) as unknown[];
    expect(events).toHaveLength(1);
    expect(stored).not.toContain('private clipboard contents');
    const event = events[0] as Record<string, unknown>;
    expect({ ...event, occurredAt: undefined }).toEqual({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      type: 'clipboard.copied', sourceSurface: 'files', copyKind: 'path',
      characterCount: 26, path: 'package.json', directory: '/repo',
      occurredAt: undefined,
    });
    expect(typeof event.occurredAt).toBe('string');
    collector.dispose();
  });

  test('captures native copy selection length and removes acknowledged events', async () => {
    const storage = makeStorage();
    const documentRef = makeDocument();
    let fetchCount = 0;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCount += 1;
      const body = JSON.parse(String(init?.body)) as { events: Array<{ id: string; copiedText?: string }> };
      expect(body.events[0].copiedText).toBe('selected text');
      return new Response(JSON.stringify({ results: body.events.map((event) => ({ id: event.id, accepted: true })) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const collector = createInteractionAnalyticsCollector({
      document: documentRef as unknown as Document,
      storage,
      fetchImpl: fetchImpl as typeof fetch,
      getPrincipal: () => principal,
      getDirectory: () => '/repo',
      randomUuid: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      setTimeoutImpl: (() => 1) as unknown as typeof setTimeout,
      clearTimeoutImpl: (() => undefined) as typeof clearTimeout,
    });
    collector.initialize();
    documentRef.dispatch('copy', {
      closest: () => ({
        dataset: { analyticsSurface: 'editor', analyticsFilePath: '/repo/src/index.ts' },
      }),
    } as unknown as EventTarget);

    await collector.flush();
    expect(fetchCount).toBe(1);
    expect([...storage.values.values()]).toHaveLength(0);
    collector.dispose();
  });

  test('caps copied text at 64 KiB, keeps it out of storage, and disables keepalive for a large batch', async () => {
    const storage = makeStorage();
    const documentRef = makeDocument();
    const source = '🙂'.repeat(20_000);
    let requestInit: RequestInit | undefined;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      const body = JSON.parse(String(init?.body)) as { events: Array<{ id: string; copiedText?: string; characterCount: number }> };
      const copiedText = body.events[0].copiedText || '';
      expect(new TextEncoder().encode(copiedText).byteLength <= 64 * 1024).toBe(true);
      expect(copiedText.endsWith('🙂')).toBe(true);
      expect(body.events[0].characterCount).toBe(source.length);
      return new Response(JSON.stringify({ results: [{ id: body.events[0].id, accepted: true }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const collector = createInteractionAnalyticsCollector({
      document: documentRef as unknown as Document,
      storage,
      fetchImpl: fetchImpl as typeof fetch,
      getPrincipal: () => principal,
      getDirectory: () => '/repo',
      randomUuid: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      setTimeoutImpl: (() => 1) as unknown as typeof setTimeout,
      clearTimeoutImpl: (() => undefined) as typeof clearTimeout,
    });

    collector.recordProgrammaticCopy(source, { sourceSurface: 'settings', copyKind: 'text' });
    expect([...storage.values.values()].join('')).not.toContain('🙂');
    await collector.flush();
    expect(requestInit?.keepalive).toBe(false);
    expect([...storage.values.values()]).toHaveLength(0);
    collector.dispose();
  });

  test('captures the selected input substring once', async () => {
    const storage = makeStorage();
    const documentRef = makeDocument();
    let copiedText = '';
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { events: Array<{ id: string; copiedText?: string }> };
      copiedText = body.events[0].copiedText || '';
      return new Response(JSON.stringify({ results: [{ id: body.events[0].id, accepted: true }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const collector = createInteractionAnalyticsCollector({
      document: documentRef as unknown as Document,
      storage,
      fetchImpl: fetchImpl as typeof fetch,
      getPrincipal: () => principal,
      getDirectory: () => '/repo',
      randomUuid: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      setTimeoutImpl: (() => 1) as unknown as typeof setTimeout,
      clearTimeoutImpl: (() => undefined) as typeof clearTimeout,
    });
    collector.initialize();
    documentRef.dispatch('copy', {
      value: 'before selected after',
      selectionStart: 7,
      selectionEnd: 15,
      closest: () => ({ dataset: { analyticsSurface: 'settings' } }),
    } as unknown as EventTarget);
    await collector.flush();
    expect(copiedText).toBe('selected');
    collector.dispose();
  });
});
