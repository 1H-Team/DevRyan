import React, { act } from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';

import type { ProjectEntry } from '@/lib/api/types';
import type { AuthPrincipal } from '@/lib/authSession';

const reads: boolean[] = [];
mock.module('./worktreeManager', () => ({
  listProjectWorktrees: async (_project: unknown, options: { refresh?: boolean } = {}) => {
    reads.push(options.refresh === true);
    return [];
  },
}));

const { useWorktreeDiscovery } = await import('./useWorktreeDiscovery');
const { invalidateWorktreeDiscovery } = await import('./worktreeDiscovery');

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

type Listener = () => void;
class TestTarget {
  readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }
  removeEventListener(type: string, listener: Listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type: string) { for (const listener of this.listeners.get(type) ?? []) listener(); }
}

class TestDocument extends TestTarget {
  readonly nodeType = 9;
  readonly documentElement = new TestElement(this);
  readonly body = new TestElement(this);
  activeElement: TestElement | null = this.body;
  defaultView: unknown = null;
  visibilityState: 'visible' | 'hidden' = 'visible';
  focused = true;
  hasFocus() { return this.focused; }
  createElement() { return new TestElement(this); }
}

const saved = (['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'setInterval'] as const)
  .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
afterEach(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  reads.length = 0;
});

// Captures the discovery poll instead of waiting 90 seconds for it.
const installDom = () => {
  const document = new TestDocument();
  const window = new TestTarget();
  const polls: Array<{ callback: () => void; delay: number }> = [];
  const realSetInterval = globalThis.setInterval;
  Object.defineProperties(globalThis, {
    window: { configurable: true, writable: true, value: Object.assign(window, { document, Element: TestElement, HTMLElement: TestElement, HTMLIFrameElement: class {} }) },
    document: { configurable: true, writable: true, value: document },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
    setInterval: {
      configurable: true, writable: true,
      value: (callback: () => void, delay?: number) => {
        if (delay && delay >= 60_000) { polls.push({ callback, delay }); return 0 as unknown as ReturnType<typeof setInterval>; }
        return realSetInterval(callback, delay);
      },
    },
  });
  document.defaultView = window;
  return { document, window, polls };
};

const principal = { id: 'user-1', scope: 'local-admin', role: 'admin' } as unknown as AuthPrincipal;
const projects: ProjectEntry[] = [{ id: 'project-1', path: '/repo' }];
const settle = () => new Promise(resolve => setTimeout(resolve, 200));

const mount = async (
  dom: ReturnType<typeof installDom>,
  props: { currentDirectory: string; poll?: boolean },
) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(new TestElement(dom.document) as unknown as Element);
  const Probe = ({ currentDirectory, poll }: { currentDirectory: string; poll?: boolean }) => {
    useWorktreeDiscovery(projects, principal, currentDirectory, undefined, { poll });
    return null;
  };
  await act(async () => { root.render(<Probe {...props} />); await settle(); });
  return {
    rerender: async (next: { currentDirectory: string; poll?: boolean }) => {
      await act(async () => { root.render(<Probe {...next} />); await settle(); });
    },
    unmount: async () => { await act(async () => { root.unmount(); }); },
  };
};

describe('worktree discovery scheduling', () => {
  test('a directory switch reads nothing and the first read uses the cache', async () => {
    const dom = installDom();
    const view = await mount(dom, { currentDirectory: '/repo' });
    try {
      expect(reads).toEqual([false]);
      await view.rerender({ currentDirectory: '/repo/worktree-a' });
      await view.rerender({ currentDirectory: '/repo' });
      expect(reads).toEqual([false]);
    } finally {
      await view.unmount();
    }
  });

  test('polls with a forced listing only while the window is visible', async () => {
    const dom = installDom();
    const view = await mount(dom, { currentDirectory: '/repo' });
    try {
      expect(dom.polls).toHaveLength(1);
      const poll = dom.polls[0]!;
      expect(poll.delay).toBeGreaterThan(59_999);
      expect(poll.delay).toBeLessThan(120_001);

      dom.document.visibilityState = 'hidden';
      await act(async () => { poll.callback(); await settle(); });
      expect(reads).toEqual([false]);

      // A visible window on another screen still follows agent-created worktrees.
      dom.document.visibilityState = 'visible';
      dom.document.focused = false;
      await act(async () => { poll.callback(); await settle(); });
      expect(reads).toEqual([false, true]);
    } finally {
      await view.unmount();
    }
  });

  test('a forced listing is not downgraded by an invalidation, and a hidden miss runs on return', async () => {
    const dom = installDom();
    const view = await mount(dom, { currentDirectory: '/repo' });
    try {
      await act(async () => { dom.polls[0]!.callback(); invalidateWorktreeDiscovery(); await settle(); });
      expect(reads).toEqual([false, true]);

      dom.document.visibilityState = 'hidden';
      await act(async () => { invalidateWorktreeDiscovery(); await settle(); });
      expect(reads).toEqual([false, true]);
      dom.document.visibilityState = 'visible';
      await act(async () => { dom.document.dispatch('visibilitychange'); await settle(); });
      expect(reads).toEqual([false, true, false]);
    } finally {
      await view.unmount();
    }
  });

  test('a fresh focus return does not relist, and invalidation reads through the revision', async () => {
    const dom = installDom();
    const view = await mount(dom, { currentDirectory: '/repo' });
    try {
      await act(async () => { dom.window.dispatch('focus'); dom.document.dispatch('visibilitychange'); await settle(); });
      expect(reads).toEqual([false]);

      await act(async () => { invalidateWorktreeDiscovery(); await settle(); });
      expect(reads).toEqual([false, false]);
    } finally {
      await view.unmount();
    }
  });

  test('returning to a stale window forces one listing', async () => {
    const dom = installDom();
    const view = await mount(dom, { currentDirectory: '/repo', poll: false });
    const realNow = Date.now;
    try {
      const later = realNow() + 61_000;
      Date.now = () => later;
      await act(async () => { dom.window.dispatch('focus'); await settle(); });
      expect(reads).toEqual([false, true]);
      await act(async () => { dom.window.dispatch('focus'); await settle(); });
      expect(reads).toEqual([false, true]);
    } finally {
      Date.now = realNow;
      await view.unmount();
    }
  });

  test('a window without polling never schedules periodic discovery', async () => {
    const dom = installDom();
    const view = await mount(dom, { currentDirectory: '/repo', poll: false });
    try {
      expect(dom.polls).toHaveLength(0);
      expect(reads).toEqual([false]);
    } finally {
      await view.unmount();
    }
  });
});
