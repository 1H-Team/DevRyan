import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { HostElement, withDom } from '@/test/mountedDom';
import { resolveDocumentAnimationState } from './useDocumentAnimationState';

type AnimationModule = typeof import('./useDocumentAnimationState');

let moduleCounter = 0;

// Each case gets its own copy of the module and its own host window: the
// module registers its window listener at import time and keeps global state.
const withFreshModule = async (run: (ctx: {
  module: AnimationModule;
  container: HostElement;
  dispatchWindowVisibility: (detail: unknown) => void;
  setDocumentVisibility: (state: 'visible' | 'hidden') => void;
  counts: { documentVisibility: number; mediaChange: number };
  root: { render: (node: React.ReactNode) => void; unmount: () => void };
}) => Promise<void>) => withDom(async (container) => {
  const host = globalThis as unknown as {
    window: Record<string, unknown>;
    document: Record<string, unknown> & { documentElement: HostElement };
  };
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  const counts = { documentVisibility: 0, mediaChange: 0 };
  const mediaTarget = new EventTarget();
  host.window.addEventListener = windowTarget.addEventListener.bind(windowTarget);
  host.window.removeEventListener = windowTarget.removeEventListener.bind(windowTarget);
  host.window.matchMedia = () => Object.assign(Object.create(null), {
    matches: false,
    addEventListener: (type: string, listener: EventListener) => {
      if (type === 'change') counts.mediaChange += 1;
      mediaTarget.addEventListener(type, listener);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      if (type === 'change') counts.mediaChange -= 1;
      mediaTarget.removeEventListener(type, listener);
    },
  });
  host.document.visibilityState = 'visible';
  host.document.addEventListener = (type: string, listener: EventListener) => {
    if (type === 'visibilitychange') counts.documentVisibility += 1;
    documentTarget.addEventListener(type, listener);
  };
  host.document.removeEventListener = (type: string, listener: EventListener) => {
    if (type === 'visibilitychange') counts.documentVisibility -= 1;
    documentTarget.removeEventListener(type, listener);
  };
  (host.document.documentElement as HostElement & { toggleAttribute?: (name: string, force: boolean) => void }).toggleAttribute = (name, force) => {
    if (force) host.document.documentElement.setAttribute(name, ''); else host.document.documentElement.removeAttribute(name);
  };
  moduleCounter += 1;
  const module = await import(`./useDocumentAnimationState?fresh=${moduleCounter}`) as AnimationModule;
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  try {
    await run({
      module,
      container,
      counts,
      root: { render: (node) => root.render(node), unmount: () => root.unmount() },
      dispatchWindowVisibility: (detail) => windowTarget.dispatchEvent(new CustomEvent(module.WINDOW_VISIBILITY_EVENT, { detail })),
      setDocumentVisibility: (state) => {
        host.document.visibilityState = state;
        documentTarget.dispatchEvent(new Event('visibilitychange'));
      },
    });
  } finally {
    await act(async () => { root.unmount(); });
  }
});

const Probe: React.FC<{ module: AnimationModule; label: string }> = ({ module, label }) => {
  const state = module.useDocumentAnimationState();
  return <span>{`${label}:${state.shouldAnimate ? 'animate' : 'paused'}`}</span>;
};

describe('document animation state', () => {
  test('the desktop shell reports a hidden window the page cannot see for itself', async () => {
    await withFreshModule(async ({ module, container, dispatchWindowVisibility }) => {
      await act(async () => { dispatchWindowVisibility({ visible: false }); });
      // A report that arrives before anything subscribed is not lost.
      expect(container.ownerDocument.documentElement.hasAttribute(module.WINDOW_HIDDEN_ATTRIBUTE)).toBe(true);
    });
  });

  test('a hidden-window report pauses subscribers and a visible report resumes them', async () => {
    await withFreshModule(async ({ module, container, root, dispatchWindowVisibility }) => {
      await act(async () => { root.render(<Probe module={module} label="p" />); });
      expect(container.textContent).toBe('p:animate');

      await act(async () => { dispatchWindowVisibility({ visible: false }); });
      expect(container.textContent).toBe('p:paused');
      expect(container.ownerDocument.documentElement.hasAttribute(module.WINDOW_HIDDEN_ATTRIBUTE)).toBe(true);

      await act(async () => { dispatchWindowVisibility({ visible: true }); });
      expect(container.textContent).toBe('p:animate');
      expect(container.ownerDocument.documentElement.hasAttribute(module.WINDOW_HIDDEN_ATTRIBUTE)).toBe(false);
    });
  });

  test('a hidden-window report delivered before the first subscriber still applies on mount', async () => {
    await withFreshModule(async ({ module, container, root, dispatchWindowVisibility }) => {
      await act(async () => { dispatchWindowVisibility({ visible: false }); });
      await act(async () => { root.render(<Probe module={module} label="late" />); });
      expect(container.textContent).toBe('late:paused');
    });
  });

  test('ignores malformed window-visibility reports as visible', async () => {
    await withFreshModule(async ({ module, container, root, dispatchWindowVisibility }) => {
      await act(async () => { root.render(<Probe module={module} label="p" />); });
      await act(async () => { dispatchWindowVisibility({ visible: false }); });
      await act(async () => { dispatchWindowVisibility('hidden'); });
      expect(container.textContent).toBe('p:animate');
    });
  });

  test('pauses while the document itself is hidden', async () => {
    await withFreshModule(async ({ module, container, root, setDocumentVisibility }) => {
      await act(async () => { root.render(<Probe module={module} label="p" />); });
      await act(async () => { setDocumentVisibility('hidden'); });
      expect(container.textContent).toBe('p:paused');
      await act(async () => { setDocumentVisibility('visible'); });
      expect(container.textContent).toBe('p:animate');
    });
  });

  test('runs presentation work only while visible and motion is allowed', () => {
    expect(resolveDocumentAnimationState(true, false)).toEqual({
      isVisible: true,
      prefersReducedMotion: false,
      shouldAnimate: true,
    });
    expect(resolveDocumentAnimationState(false, false).shouldAnimate).toBe(false);
    expect(resolveDocumentAnimationState(true, true).shouldAnimate).toBe(false);
    expect(resolveDocumentAnimationState(false, true).shouldAnimate).toBe(false);
  });

  test('shares one visibility and one reduced-motion listener across all subscribers', async () => {
    await withFreshModule(async ({ module, container, root, counts }) => {
      expect(counts).toEqual({ documentVisibility: 0, mediaChange: 0 });
      await act(async () => {
        root.render(<><Probe module={module} label="a" /><Probe module={module} label="b" /><Probe module={module} label="c" /></>);
      });
      expect(container.textContent).toBe('a:animateb:animatec:animate');
      expect(counts).toEqual({ documentVisibility: 1, mediaChange: 1 });

      // Dropping some subscribers keeps the shared listeners for the rest.
      await act(async () => { root.render(<Probe module={module} label="a" />); });
      expect(counts).toEqual({ documentVisibility: 1, mediaChange: 1 });

      await act(async () => { root.render(null); });
      expect(counts).toEqual({ documentVisibility: 0, mediaChange: 0 });
    });
  });

  // Cross-package and generated-asset contracts: the Electron shell is not
  // runnable here, and the stylesheet is the only thing that pauses CSS animations.
  test('the shell emits the window-visibility event and the stylesheet pauses animations on it', () => {
    const shell = readFileSync(new URL('../../../electron/main.mjs', import.meta.url), 'utf8');
    expect(shell).toContain("emitToWindow(browserWindow, 'devryan:window-visibility', {");
    expect(shell).toContain("for (const event of ['show', 'hide', 'minimize', 'restore']) browserWindow.on(event, emitWindowVisibility);");
    const styles = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    expect(styles).toContain('html[data-window-hidden] *::after');
    expect(styles).toContain('animation-play-state: paused !important;');
  });
});
