import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withDom, type HostNode } from '@/components/bots/chat/botMountedDom';
import {
  SidebarLeftCollapseIcon,
  SidebarLeftExpandIcon,
  SidebarRightCollapseIcon,
  SidebarRightExpandIcon,
} from '@/components/icons/ToolbarIcons';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

// The Vite-only logo glob cannot load under bun; logos are irrelevant to chrome layout.
mock.module('@/hooks/useProviderLogo', () => ({ useProviderLogo: () => ({ src: null, onError() {}, hasLogo: false }) }));

const { DesktopEdgeChrome } = await import('./DesktopEdgeChrome');

const host = globalThis as unknown as Record<string, unknown>;
const saved: Record<'window' | 'navigator', PropertyDescriptor | undefined> = { window: undefined, navigator: undefined };

const installHost = ({ desktopShell = true, userAgent = 'Mozilla/5.0 (X11; Linux x86_64)' }: { desktopShell?: boolean; userAgent?: string } = {}) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      ...(desktopShell ? { __TAURI__: { core: { invoke() {} } } } : {}),
      location: { search: '', pathname: '/', hash: '', hostname: 'localhost', origin: 'http://localhost', href: 'http://localhost/' },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    },
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { userAgent } });
};

beforeEach(() => {
  saved.window = Object.getOwnPropertyDescriptor(globalThis, 'window');
  saved.navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
});
afterEach(() => {
  for (const key of ['window', 'navigator'] as const) {
    const descriptor = saved[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(host, key);
  }
});

// Serialises the host DOM used by mounted tests into comparable markup.
const serialize = (node: HostNode): string => {
  if (node.nodeType === 3) return node.ownText;
  const element = node as HostNode & { attributes?: Record<string, string> };
  const tag = node.nodeName.toLowerCase();
  const attributes = Object.entries(element.attributes ?? {}).map(([key, value]) => ` ${key}="${value}"`).join('');
  return `<${tag}${attributes}>${node.childNodes.map(serialize).join('')}</${tag}>`;
};

const render = (props: { hideActions?: boolean; isMobile?: boolean; botMode?: boolean } = {}) => renderToStaticMarkup(
  <I18nProvider>
    <DesktopEdgeChrome hideActions={false} isMobile={false} {...props} />
  </I18nProvider>,
);

const openingTags = (markup: string): string[] => markup.match(/<[a-z][^>]*>/g) ?? [];
const firstTag = (markup: string): string => openingTags(markup)[0] ?? '';
const tagWith = (markup: string, needle: string) => {
  const tag = openingTags(markup).find((candidate) => candidate.includes(needle));
  expect(tag).toBeDefined();
  return tag as string;
};
const classOf = (tag: string) => / class="([^"]*)"/.exec(tag)?.[1] ?? '';
const indexOfLabel = (markup: string, label: string) => {
  const index = markup.indexOf(`aria-label="${label}"`);
  expect(index).toBeGreaterThan(-1);
  return index;
};

describe('DesktopEdgeChrome desktop drag regions', () => {
  test('does not mark the full-width overlay shell as a drag region', () => {
    installHost();
    const markup = render();
    const shell = firstTag(markup);

    expect(classOf(shell)).toContain('pointer-events-none absolute inset-x-0 top-0 z-30 select-none');
    expect(classOf(shell)).not.toContain('app-region-drag');
  });

  test('keeps Bot controls in the titlebar row instead of centering them in the identity header', () => {
    installHost();
    const bot = firstTag(render({ botMode: true }));
    const standard = firstTag(render());

    expect(classOf(bot)).toContain('h-12');
    expect(classOf(bot)).not.toContain('h-[var(--oc-header-height,56px)]');
    expect(classOf(standard)).toContain('h-[var(--oc-header-height,56px)]');
    expect(bot).toContain('role="toolbar"');
    expect(standard).not.toContain('role="toolbar"');
  });

  test('sizes the Bot titlebar to the window-controls overlay outside the desktop shell', () => {
    installHost({ desktopShell: false });
    expect(firstTag(render({ botMode: true }))).toContain('height:max(3rem, var(--oc-wco-titlebar-height, 0px))');

    installHost({ desktopShell: true });
    expect(firstTag(render({ botMode: true }))).not.toContain('--oc-wco-titlebar-height');
  });

  test('applies the macOS native titlebar height to the chrome, Bot mode included', () => {
    installHost({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' });
    const macBot = classOf(firstTag(render({ botMode: true }))).split(/\s+/);
    // macOS 10.15 resolves to major 15, whose native titlebar is taller (h-14) and wins over the Bot default.
    expect(macBot).toContain('h-14');
    expect(macBot).not.toContain('h-12');

    installHost({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 26_0)' });
    expect(classOf(firstTag(render({ botMode: false }))).split(/\s+/)).toContain('h-12');
  });

  test('uses a dedicated traffic-light drag filler and no-drag interactive clusters', () => {
    installHost();
    const markup = render();

    const filler = tagWith(markup, 'app-region-drag pointer-events-auto absolute top-0 left-0 h-full');
    expect(filler).toContain('width:var(--oc-desktop-chrome-left, 0.75rem)');
    expect(tagWith(markup, 'app-region-no-drag pointer-events-auto absolute top-0 flex h-full items-center gap-1.5')).toBeDefined();
    expect(classOf(tagWith(markup, 'absolute top-0 flex h-full items-center"'))).toContain('app-region-no-drag');
    // Only the filler is a drag region among the pointer-active layers.
    expect(openingTags(markup).filter((tag) => classOf(tag).split(/\s+/).includes('app-region-drag'))).toEqual([filler]);
  });

  test('marks the right chrome action cluster root as no-drag', () => {
    installHost();
    expect(openingTags(render())).toContain('<div class="app-region-no-drag flex items-center gap-1.5">');
  });

  test('orders desktop chrome actions as terminal, browser, then right sidebar', () => {
    installHost();
    const markup = render();
    const terminal = indexOfLabel(markup, 'Toggle Terminal Panel');
    const browser = markup.indexOf('data-desktop-browser-action-slot="true"');
    const rightSidebar = indexOfLabel(markup, 'Toggle Right Sidebar');

    expect(browser).toBeGreaterThan(terminal);
    expect(rightSidebar).toBeGreaterThan(browser);
  });

  test('shows the shared semantic sidebar toggle icons for the open and closed states', async () => {
    installHost();
    const initial = useUIStore.getState();
    // Server rendering only sees zustand's initial snapshot, so this case mounts for real.
    const mountedMarkup = async (state: { isSidebarOpen: boolean; isRightSidebarOpen: boolean }) => {
      let markup = '';
      await withDom(async (container) => {
        const host = globalThis as unknown as { window: Record<string, unknown>; navigator: unknown };
        Object.assign(host.window, { __TAURI__: { core: { invoke() {} } }, location: { search: '', pathname: '/', hash: '' } });
        host.navigator = { userAgent: 'test' };
        useUIStore.setState(state);
        const { createRoot } = await import('react-dom/client');
        const root = createRoot(container as unknown as Element);
        await act(async () => { root.render(<I18nProvider><DesktopEdgeChrome hideActions={false} isMobile={false} /></I18nProvider>); });
        markup = serialize(container);
        await act(async () => { root.unmount(); });
      });
      return markup;
    };
    // The glyph body (divider plus chevron) is what encodes the toggle direction.
    const glyph = (element: React.ReactElement) => {
      const markup = renderToStaticMarkup(element);
      return markup.slice(markup.indexOf('</rect>') + '</rect>'.length, markup.indexOf('</svg>'));
    };
    const leftOpen = glyph(<SidebarLeftCollapseIcon />);
    const leftClosed = glyph(<SidebarLeftExpandIcon />);
    const rightOpen = glyph(<SidebarRightCollapseIcon />);
    const rightClosed = glyph(<SidebarRightExpandIcon />);
    expect(new Set([leftOpen, leftClosed, rightOpen, rightClosed]).size).toBe(4);

    try {
      const bothOpen = await mountedMarkup({ isSidebarOpen: true, isRightSidebarOpen: true });
      expect(bothOpen).toContain(leftOpen);
      expect(bothOpen).toContain(rightOpen);
      expect(bothOpen).not.toContain(leftClosed);
      expect(bothOpen).not.toContain(rightClosed);

      const bothClosed = await mountedMarkup({ isSidebarOpen: false, isRightSidebarOpen: false });
      expect(bothClosed).toContain(leftClosed);
      expect(bothClosed).toContain(rightClosed);
      expect(bothClosed).not.toContain(leftOpen);
      expect(bothClosed).not.toContain(rightOpen);
    } finally {
      useUIStore.setState({ isSidebarOpen: initial.isSidebarOpen, isRightSidebarOpen: initial.isRightSidebarOpen });
    }
  });

  test('renders nothing on mobile', () => {
    installHost();
    expect(render({ isMobile: true })).toBe('');
  });

  test('hosts the left sidebar actions only in the desktop shell, while the right cluster is shared', () => {
    installHost({ desktopShell: false });
    const web = render();
    expect(web).not.toContain('aria-label="Close Sessions"');
    expect(web).not.toContain('aria-label="Search Sessions"');
    expect(web).toContain('data-desktop-browser-action-slot="true"');

    installHost({ desktopShell: true });
    const desktop = render();
    expect(desktop).toContain('aria-label="Close Sessions"');
    expect(desktop).toContain('aria-label="Search Sessions"');
  });

  test('keeps settings hidden and replaces default actions with Bot edge controls', () => {
    installHost();
    const hidden = render({ hideActions: true });
    expect(hidden).not.toContain('<button');
    expect(hidden).toContain('app-region-drag');

    const bot = render({ botMode: true });
    expect(bot).toContain('data-bot-edge-controls="true"');
    expect(bot).toContain('aria-label="Close Sessions"');
    expect(bot).toContain('aria-label="Open Bot Operations"');
    expect(bot).not.toContain('Search Sessions');
    expect(bot).not.toContain('Toggle Terminal Panel');
    expect(render()).not.toContain('data-bot-edge-controls');
  });
});

// Wiring in sibling components that cannot be rendered without their full store graph.
describe('desktop chrome wiring in sibling components', () => {
  const readSource = (filename: string) => readFileSync(new URL(filename, import.meta.url), 'utf8');

  test('hosts the browser action portal in the shared desktop web and Electron layout', () => {
    const headerSource = readSource('Header.tsx');
    const layoutSource = readSource('MainLayout.tsx');

    expect(headerSource).toContain('const showsDesktopRightChrome = !isMobile');
    expect(headerSource).toContain("? 'calc(11rem + var(--oc-wco-right-inset, 0px))'");
    expect(headerSource).toContain('browserActionPortalTarget={browserActionPortalTarget}');
    expect(layoutSource).toContain('isMobile={isMobile}');
    expect(layoutSource).toContain('browserActionPortalRef={setBrowserActionPortalTarget}');
    expect(layoutSource).toContain('hideActions={isSettingsDialogOpen}');
    expect(layoutSource).toContain('botMode={botMode}');
  });

  test('opens only a blank browser tab without starting preview discovery', () => {
    const source = readSource('ProjectActionsButton.tsx');

    expect(source).toContain('toggleBrowserPanel(normalizedDirectory)');
    expect(source).not.toContain('openBrowserPanel(normalizedDirectory)');
    expect(source).toContain("openContextPreview(normalizedDirectory, 'about:blank')");
    expect(source).not.toContain('resolveProjectPreviewBrowserAction');
    expect(source).not.toContain('previewStartInFlightRef.current');
  });

  test('renders about:blank as an iframe instead of an invalid preview URL', () => {
    const source = readSource('ContextPanel.tsx');

    expect(source).toContain("const isBlankPreview = targetUrl === 'about:blank'");
    expect(source).toContain("const directSrc = isBlankPreview ? 'about:blank'");
  });

  test('orders service tabs as Usage, MCP, Instance', () => {
    const source = readSource('DesktopRightChromeActions.tsx');
    const usageIndex = source.indexOf("base.push({ value: 'usage'");
    const mcpIndex = source.indexOf("base.push({ value: 'mcp'");
    const instanceIndex = source.indexOf("base.push({ value: 'instance'");

    expect(usageIndex).toBeGreaterThan(-1);
    expect(mcpIndex).toBeGreaterThan(usageIndex);
    expect(instanceIndex).toBeGreaterThan(mcpIndex);
  });
});
