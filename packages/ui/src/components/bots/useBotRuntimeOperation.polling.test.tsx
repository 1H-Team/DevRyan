import React, { act } from 'react';
import { afterEach, describe, expect, test } from 'bun:test';

import type {
  BotRuntimeOperationProgress,
  BotsDesktopApi,
  BotsDesktopRuntimeStatus,
} from '@/lib/botsDesktopApi';
import { useBotRuntimeOperation } from './useBotRuntimeOperation';

class TestElement {
  readonly nodeType = 1;
  readonly nodeName = 'DIV';
  readonly tagName = 'DIV';
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml';
  readonly style: Record<string, string> = {};

  constructor(readonly ownerDocument: TestDocument) {}

  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  removeAttribute() {}
}

class TestDocument {
  readonly nodeType = 9;
  readonly documentElement = new TestElement(this);
  readonly body = new TestElement(this);
  activeElement: TestElement | null = this.body;
  defaultView: Record<string, unknown> | null = null;

  addEventListener() {}
  removeEventListener() {}
  createElement() { return new TestElement(this); }
}

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const previousActEnvironment = Object.getOwnPropertyDescriptor(
  globalThis,
  'IS_REACT_ACT_ENVIRONMENT',
);

const restore = (key: 'window' | 'document' | 'IS_REACT_ACT_ENVIRONMENT', descriptor?: PropertyDescriptor) => {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
};

afterEach(() => {
  restore('window', previousWindow);
  restore('document', previousDocument);
  restore('IS_REACT_ACT_ENVIRONMENT', previousActEnvironment);
});

const progress = (phase: BotRuntimeOperationProgress['phase']): BotRuntimeOperationProgress => ({
  id: 'operation-1',
  action: 'ensure_ready',
  phase,
  completed: null,
  total: null,
  code: phase === 'failed' ? 'bot_runtime_update_failed' : null,
  startedAt: '2026-08-28T00:00:00.000Z',
});

const healthyStatus: BotsDesktopRuntimeStatus = {
  ok: true,
  state: 'healthy',
  code: null,
  issues: [],
  manifest: null,
  desiredManifest: null,
  updateStaged: false,
  canSetup: false,
  canRepair: false,
  canUpdate: false,
  canRollback: false,
};

const createDesktopApi = (phases: readonly BotRuntimeOperationProgress['phase'][]) => {
  let readCount = 0;
  let listener: ((next: BotRuntimeOperationProgress) => void) | null = null;
  let unlistenCount = 0;
  const api: BotsDesktopApi = {
    isAvailable: () => true,
    status: async () => healthyStatus,
    setup: async () => healthyStatus,
    repair: async () => healthyStatus,
    update: async () => healthyStatus,
    rollback: async () => healthyStatus,
    operationStatus: async () => {
      const phase = phases[Math.min(readCount, phases.length - 1)] ?? 'ready';
      readCount += 1;
      return progress(phase);
    },
    listenProgress: async (nextListener) => {
      listener = nextListener;
      return () => {
        listener = null;
        unlistenCount += 1;
      };
    },
    exportRecovery: async () => ({ cancelled: true }),
    restoreRecovery: async () => ({ cancelled: true }),
  };
  return {
    api,
    emit: (phase: BotRuntimeOperationProgress['phase']) => listener?.(progress(phase)),
    readCount: () => readCount,
    unlistenCount: () => unlistenCount,
  };
};

const installDom = () => {
  const document = new TestDocument();
  const window = {
    document,
    Element: TestElement,
    HTMLElement: TestElement,
    HTMLIFrameElement: class {},
  };
  document.defaultView = window;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window, writable: true },
    document: { configurable: true, value: document, writable: true },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true },
  });
  return document;
};

const waitForPoll = () => new Promise((resolve) => setTimeout(resolve, 70));

describe('Bot runtime operation polling', () => {
  test('polls remote progress through ready and stops at the terminal phase', async () => {
    const document = installDom();
    const desktop = createDesktopApi(['checking', 'starting_services', 'ready']);
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(new TestElement(document) as unknown as Element);
    let latestPhase: BotRuntimeOperationProgress['phase'] | null = null;
    let latestPending = false;
    const Probe = () => {
      const operation = useBotRuntimeOperation(desktop.api, 50);
      latestPhase = operation.progress?.phase ?? null;
      latestPending = operation.pending;
      return null;
    };

    try {
      await act(async () => { root.render(<Probe />); });
      expect(latestPhase).toBe('checking');
      expect(latestPending).toBe(true);

      await act(async () => { await waitForPoll(); });
      expect(latestPhase).toBe('starting_services');

      await act(async () => { await waitForPoll(); });
      expect(latestPhase).toBe('ready');
      expect(latestPending).toBe(false);
      const terminalReadCount = desktop.readCount();

      await act(async () => { await waitForPoll(); });
      expect(desktop.readCount()).toBe(terminalReadCount);
    } finally {
      await act(async () => { root.unmount(); });
    }
  });

  test('stops polling and removes the IPC listener when unmounted', async () => {
    const document = installDom();
    const desktop = createDesktopApi(['checking']);
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(new TestElement(document) as unknown as Element);
    const Probe = () => {
      useBotRuntimeOperation(desktop.api, 20);
      return null;
    };

    await act(async () => { root.render(<Probe />); });
    const readsBeforeUnmount = desktop.readCount();
    await act(async () => { root.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(desktop.readCount()).toBe(readsBeforeUnmount);
    expect(desktop.unlistenCount()).toBe(1);
  });

  test('accepts an IPC terminal failure and does not let an older poll overwrite it', async () => {
    const document = installDom();
    const desktop = createDesktopApi(['checking']);
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(new TestElement(document) as unknown as Element);
    let latestPhase: BotRuntimeOperationProgress['phase'] | null = null;
    const Probe = () => {
      latestPhase = useBotRuntimeOperation(desktop.api, 20).progress?.phase ?? null;
      return null;
    };

    try {
      await act(async () => { root.render(<Probe />); });
      await act(async () => { desktop.emit('failed'); });
      expect(latestPhase).toBe('failed');
      const terminalReadCount = desktop.readCount();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(desktop.readCount()).toBe(terminalReadCount);
      expect(latestPhase).toBe('failed');
    } finally {
      await act(async () => { root.unmount(); });
    }
  });
});
