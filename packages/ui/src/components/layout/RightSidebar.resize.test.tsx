import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { HostElement, withDom } from '@/components/bots/chat/botMountedDom';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { RightSidebar } from './RightSidebar';

const initialWidth = useUIStore.getState().rightSidebarWidth;
const initialManual = useUIStore.getState().hasManuallyResizedRightSidebar;
// Server rendering reads zustand's initial snapshot, so seed that object as well as the live state.
const setWidth = (width: number) => {
  useUIStore.setState({ rightSidebarWidth: width });
  Object.assign(useUIStore.getInitialState(), { rightSidebarWidth: width });
};
beforeEach(() => { setWidth(420); });
afterEach(() => {
  setWidth(initialWidth);
  useUIStore.setState({ hasManuallyResizedRightSidebar: initialManual });
});
const installLocation = () => {
  (globalThis as unknown as { window: Record<string, unknown> }).window.location = { search: '', pathname: '/', hash: '' };
};

const sidebar = (props: { isOpen?: boolean; botMode?: boolean } = {}) => (
  <I18nProvider>
    <RightSidebar isOpen={props.isOpen ?? true} botMode={props.botMode}>
      <span>content</span>
    </RightSidebar>
  </I18nProvider>
);
const render = (props?: Parameters<typeof sidebar>[0]) => renderToStaticMarkup(sidebar(props));

const asideStyle = (markup: string) => /<aside[^>]*style="([^"]*)"/.exec(markup)?.[1] ?? '';
const contentStyle = (markup: string) => /<div class="relative z-10[^"]*" style="([^"]*)"/.exec(markup)?.[1] ?? '';

describe('RightSidebar resize presentation', () => {
  test('updates the outer shell and inner content from the same live width while dragging', async () => {
    await withDom(async (container) => {
      const { createRoot } = await import('react-dom/client');
      const root = createRoot(container as unknown as Element);
      installLocation();
      try {
        await act(async () => { root.render(sidebar()); });
        const aside = container.find((node) => node.tagName === 'ASIDE') as HostElement;
        const handle = container.find((node) => node.getAttribute('data-panel-resize-handle') === 'right-sidebar') as HostElement;
        // Record the custom properties written to the shell while dragging.
        const written = new Map<string, string>();
        (aside as unknown as { style: unknown }).style = {
          setProperty: (name: string, value: string) => { written.set(name, value); },
          removeProperty() {},
        };
        const pointer = async (type: string, clientX: number) => {
          await act(async () => {
            for (const listener of container.listeners.get(type) ?? []) {
              listener({ type, target: handle, currentTarget: handle, bubbles: true, pointerId: 3, clientX, button: 0, preventDefault() {}, stopPropagation() {} });
            }
          });
        };

        await pointer('pointerdown', 800);
        expect(written.get('--oc-right-sidebar-width')).toBe('420px');
        expect(written.get('--oc-right-sidebar-content-width')).toBe('420px');

        // Dragging 100px to the left widens the sidebar by 100px, for shell and content alike.
        await pointer('pointermove', 700);
        expect(written.get('--oc-right-sidebar-width')).toBe('520px');
        expect(written.get('--oc-right-sidebar-content-width')).toBe('520px');

        // The width is clamped to the maximum.
        await pointer('pointermove', -2000);
        expect(written.get('--oc-right-sidebar-width')).toBe('860px');
        expect(written.get('--oc-right-sidebar-content-width')).toBe('860px');

        await pointer('pointerup', -2000);
        expect(useUIStore.getState().rightSidebarWidth).toBe(860);
      } finally {
        await act(async () => { root.unmount(); });
      }
    });
  });

  test('ignores pointer moves from a pointer that did not start the drag', async () => {
    await withDom(async (container) => {
      const { createRoot } = await import('react-dom/client');
      const root = createRoot(container as unknown as Element);
      installLocation();
      try {
        await act(async () => { root.render(sidebar()); });
        const handle = container.find((node) => node.getAttribute('data-panel-resize-handle') === 'right-sidebar') as HostElement;
        const fire = async (type: string, pointerId: number, clientX: number) => act(async () => {
          for (const listener of container.listeners.get(type) ?? []) {
            listener({ type, target: handle, currentTarget: handle, bubbles: true, pointerId, clientX, button: 0, preventDefault() {}, stopPropagation() {} });
          }
        });
        await fire('pointerdown', 1, 800);
        await fire('pointermove', 2, 100);
        await fire('pointerup', 2, 100);
        expect(useUIStore.getState().rightSidebarWidth).toBe(420);
        await fire('pointerup', 1, 800);
        expect(useUIStore.getState().rightSidebarWidth).toBe(420);
      } finally {
        await act(async () => { root.unmount(); });
      }
    });
  });

  test('keeps the stored content width independent while the sidebar collapses', () => {
    setWidth(500);
    const open = render({ isOpen: true });
    const closed = render({ isOpen: false });

    expect(asideStyle(open)).toContain('--oc-right-sidebar-width:500px');
    expect(asideStyle(open)).toContain('--oc-right-sidebar-content-width:500px');
    // Collapsing animates the shell to zero while the inner content keeps its width.
    expect(asideStyle(closed)).toContain('--oc-right-sidebar-width:0px');
    expect(asideStyle(closed)).toContain('--oc-right-sidebar-content-width:500px');
    expect(contentStyle(closed)).toContain('width:var(--oc-right-sidebar-content-width)');
    expect(closed).toContain('aria-hidden="true"');
    expect(closed).not.toContain('data-panel-resize-handle');
    expect(open).toContain('data-panel-resize-handle="right-sidebar"');
  });

  test('clamps stored widths to the supported range', () => {
    setWidth(5000);
    expect(asideStyle(render())).toContain('--oc-right-sidebar-width:860px');
    setWidth(10);
    expect(asideStyle(render())).toContain('--oc-right-sidebar-width:300px');
  });

  test('uses the compact Bot chrome inset for both content and the drag region', () => {
    const bot = render({ botMode: true });
    const standard = render();

    expect(contentStyle(bot)).toContain('padding-top:var(--oc-bot-chrome-height, 48px)');
    expect(contentStyle(standard)).toContain('padding-top:var(--oc-header-height, 56px)');
    const dragRegion = (markup: string) => /class="app-region-drag[^"]*" style="([^"]*)"/.exec(markup)?.[1] ?? '';
    expect(dragRegion(bot)).toContain('height:var(--oc-bot-chrome-height, 48px)');
    expect(dragRegion(standard)).toContain('height:var(--oc-header-height, 56px)');
  });
});
