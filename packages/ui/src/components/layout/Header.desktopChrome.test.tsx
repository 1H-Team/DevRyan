import React from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { DESKTOP_LEFT_CHROME_CLUSTER_WIDTH } from '@/components/layout/desktopChromeInsets';

// Heavy neighbours are replaced by probes; the Header itself renders for real.
mock.module('@/hooks/useProviderLogo', () => ({ useProviderLogo: () => ({ src: null, onError() {}, hasLogo: false }) }));
const liveSession = { current: undefined as undefined | { id: string; slug: string; title: string; directory: string; time: { created: number; updated: number } } };
const actualSyncContext = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({
  ...actualSyncContext,
  useSession: () => liveSession.current,
  useAllLiveSessions: () => (liveSession.current ? [liveSession.current] : []),
  useSessionFirstUserText: () => '',
}));
mock.module('@/components/layout/ProjectActionsButton', () => ({
  ProjectActionsButton: (props: { className?: string; compact?: boolean }) => (
    <i data-probe="project-actions" data-class={props.className} data-compact={String(props.compact)} />
  ),
}));
mock.module('@/components/desktop/OpenInAppButton', () => ({ OpenInAppButton: () => <i data-probe="open-in-app" /> }));
mock.module('@/components/session/ActiveSessionChangesBadge', () => ({
  ActiveSessionChangesBadge: (props: { sessionId: string; directory?: string }) => (
    <i data-probe="changes-badge" data-session={props.sessionId} data-directory={props.directory} />
  ),
}));
mock.module('@/components/mcp/McpDropdown', () => ({ McpDropdownContent: () => <i data-probe="mcp" /> }));
const { Header } = await import('./Header');

const host = globalThis as unknown as Record<string, unknown>;
const saved = new Map<string, PropertyDescriptor | undefined>();
const element = () => ({
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  dataset: {},
  setAttribute() {},
  removeAttribute() {},
  style: { setProperty() {}, removeProperty() {} },
});

const installBrowser = ({ desktopShell, mobile = false }: { desktopShell: boolean; mobile?: boolean }) => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: { documentElement: element(), body: element(), addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      ...(desktopShell ? { __TAURI__: { core: { invoke: async () => null } } } : {}),
      innerWidth: mobile ? 390 : 1400,
      innerHeight: 800,
      location: { href: 'https://app.example/', origin: 'https://app.example', search: '', pathname: '/' },
      matchMedia: (query: string) => ({
        matches: mobile && /max-width|pointer: coarse|hover: none/.test(query),
        addEventListener() {},
        removeEventListener() {},
      }),
      addEventListener() {},
      removeEventListener() {},
    },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      userAgent: mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' : 'Mozilla/5.0 (X11; Linux x86_64)',
      maxTouchPoints: mobile ? 5 : 0,
    },
  });
};

// Server rendering reads zustand's initial snapshot, so seed it as well as the live state.
const seed = <T extends object>(store: { getInitialState: () => T; setState: (partial: Partial<T>) => void }, partial: Partial<T>) => {
  Object.assign(store.getInitialState(), partial);
  store.setState(partial);
};

const baselineUi = {
  isSidebarOpen: useUIStore.getState().isSidebarOpen,
  isRightSidebarOpen: useUIStore.getState().isRightSidebarOpen,
  activeMainTab: useUIStore.getState().activeMainTab,
};
const baselineSession = { currentSessionId: useSessionUIStore.getState().currentSessionId };

beforeEach(() => {
  for (const key of ['window', 'document', 'navigator']) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  liveSession.current = undefined;
});
afterEach(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(host, key);
  }
  seed(useUIStore, baselineUi);
  seed(useSessionUIStore, baselineSession);
});

const render = (props: Partial<React.ComponentProps<typeof Header>> = {}) => renderToStaticMarkup(
  <I18nProvider><Header {...props} /></I18nProvider>,
);
const desktopRow = (markup: string) => /<div class="(app-region-drag relative flex h-12[^"]*)"/.exec(markup)?.[1].split(/\s+/) ?? [];
const contentRowTag = (markup: string) => /<div class="(flex min-w-0 w-full flex-1 items-center gap-3[^"]*)"( style="([^"]*)")?/.exec(markup);

describe('Header desktop chrome', () => {
  test('does not portal sidebar actions into the right sidebar', () => {
    installBrowser({ desktopShell: true });

    // Portals cannot be server-rendered; the actions render in place, inside the header.
    const markup = render();
    expect(markup.indexOf('data-probe="project-actions"')).toBeGreaterThan(markup.indexOf('<header'));
    expect(markup.indexOf('data-probe="project-actions"')).toBeLessThan(markup.indexOf('</header>'));
  });

  test('wraps desktop project actions and open-in-app controls in a no-drag cluster', () => {
    installBrowser({ desktopShell: true });
    const markup = render();

    const cluster = '<div class="app-region-no-drag pointer-events-auto relative ml-auto mr-3 flex shrink-0 items-center gap-1.5">';
    expect(markup).toContain(cluster);
    const clusterStart = markup.indexOf(cluster);
    const projectActions = markup.indexOf('data-probe="project-actions"', clusterStart);
    const openInApp = markup.indexOf('data-probe="open-in-app"', clusterStart);
    expect(projectActions).toBeGreaterThan(clusterStart);
    expect(openInApp).toBeGreaterThan(projectActions);
  });

  test('reserves left chrome width only when the desktop sidebar is closed', () => {
    installBrowser({ desktopShell: true });

    seed(useUIStore, { isSidebarOpen: false });
    const closed = contentRowTag(render());
    expect(closed?.[3]).toContain(`padding-left:${DESKTOP_LEFT_CHROME_CLUSTER_WIDTH}`);
    expect(closed?.[1].split(/\s+/)).not.toContain('pl-3');

    seed(useUIStore, { isSidebarOpen: true });
    const open = contentRowTag(render());
    expect(open?.[3]).toBeUndefined();
    expect(open?.[1].split(/\s+/)).toContain('pl-3');
  });

  test('reserves right chrome width only when the right sidebar is closed', () => {
    installBrowser({ desktopShell: true });

    seed(useUIStore, { isRightSidebarOpen: false });
    const closed = desktopRow(render());
    expect(closed).toContain('pr-[calc(11rem+var(--oc-wco-right-inset,0px))]');
    expect(closed).not.toContain('pr-3');

    seed(useUIStore, { isRightSidebarOpen: true });
    const open = desktopRow(render());
    expect(open).toContain('pr-3');
    expect(open).not.toContain('pr-[calc(11rem+var(--oc-wco-right-inset,0px))]');

    // The reservation animates and respects reduced motion.
    for (const expected of ['transition-[padding-right]', 'duration-300', 'ease-in-out', 'motion-reduce:transition-none']) {
      expect(open).toContain(expected);
    }
  });

  test('reserves right chrome width through the window-controls overlay padding on the web', () => {
    installBrowser({ desktopShell: false });
    const rowStyle = (markup: string) => /<div class="app-region-drag relative flex h-12[^"]*" style="([^"]*)"/.exec(markup)?.[1] ?? '';

    seed(useUIStore, { isRightSidebarOpen: false });
    expect(rowStyle(render())).toContain('padding-right:calc(11rem + var(--oc-wco-right-inset, 0px))');
    seed(useUIStore, { isRightSidebarOpen: true });
    expect(rowStyle(render())).toContain('padding-right:calc(0.75rem + var(--oc-wco-right-inset, 0px))');
  });

  test('pins desktop title left and project actions to the far right', () => {
    installBrowser({ desktopShell: true });
    const markup = render();

    expect(markup).toContain('flex min-w-0 flex-1 items-center justify-start gap-2 overflow-hidden');
    expect(markup).toContain('min-w-0 truncate text-left typography-ui-label');
    expect(markup).toContain('ml-auto mr-3 flex shrink-0 items-center gap-1.5');
  });
});

describe('Header active-session diff stats', () => {
  test('renders the isolated working-tree badge for the active session in its directory', () => {
    installBrowser({ desktopShell: true });
    liveSession.current = { id: 'ses_active', slug: 'active', title: 'Active', directory: '/work/repo', time: { created: 1, updated: 1 } };
    seed(useSessionUIStore, { currentSessionId: 'ses_active' });

    const markup = render();
    expect(markup).toContain('data-probe="changes-badge"');
    expect(markup).toContain('data-session="ses_active"');
    expect(markup).toContain('data-directory="/work/repo"');
  });

  test('renders no badge when there is no active session', () => {
    installBrowser({ desktopShell: true });
    seed(useSessionUIStore, { currentSessionId: null });

    expect(render()).not.toContain('data-probe="changes-badge"');
  });
});

describe('mobile header tabs', () => {
  test('exclude files and offer chat, diff and terminal', () => {
    installBrowser({ desktopShell: false, mobile: true });
    const markup = render({ onToggleLeftDrawer: () => {}, onToggleRightDrawer: () => {} });
    const tabs = [...markup.matchAll(/<button[^>]*aria-label="([^"]*)"[^>]*role="tab"/g)].map((match) => match[1]);

    expect(tabs).toEqual(['Chat', 'Diff', 'Terminal']);
    expect(/role="tab"[^>]*aria-label="Files"/.test(markup)).toBe(false);
  });
});

// The compact action button needs the active-project store graph, so its className stays a pin.
describe('Header mobile services wiring', () => {
  test('separates compact project actions from the mobile services button', () => {
    const source = readFileSync(new URL('./Header.tsx', import.meta.url), 'utf8');

    expect(source).toContain('className="mr-2 h-9"');
  });
});
