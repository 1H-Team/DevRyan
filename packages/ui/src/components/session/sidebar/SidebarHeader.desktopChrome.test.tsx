import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarLeftCollapseIcon } from '@/components/icons/ToolbarIcons';
import { I18nProvider } from '@/lib/i18n';
import { SidebarHeader } from './SidebarHeader';

type HeaderProps = Partial<React.ComponentProps<typeof SidebarHeader>>;

const render = (props: HeaderProps = {}) => renderToStaticMarkup(
  <I18nProvider>
    <SidebarHeader
      hideDirectoryControls={false}
      handleNewSession={() => {}}
      onOpenMultiRun={() => {}}
      onOpenScheduledTasks={() => {}}
      headerActionIconClass="icon"
      reserveHeaderActionsSpace
      headerActionButtonClass="action"
      isSessionSearchOpen={false}
      setIsSessionSearchOpen={() => {}}
      {...props}
    />
  </I18nProvider>,
);

const rootClasses = (markup: string) => (/^<div class="([^"]*)"/.exec(markup)?.[1] ?? '').split(/\s+/);

describe('SidebarHeader desktop chrome spacing', () => {
  test('reserves the Electron chrome row when no top row renders', () => {
    const classes = rootClasses(render({ reserveExternalDesktopChromeRow: true, hideDirectoryControls: true }));

    expect(classes).toContain('pt-[var(--oc-header-height,56px)]');
    expect(classes).toContain('pb-[7px]');
  });

  test('does not reserve the external row when the header renders its own top row', () => {
    const withSearch = rootClasses(render({ reserveExternalDesktopChromeRow: true }));
    expect(withSearch).not.toContain('pt-[var(--oc-header-height,56px)]');
    expect(withSearch).not.toContain('pb-[7px]');
    expect(withSearch).toContain('px-2.5');

    const withToggle = rootClasses(render({ reserveExternalDesktopChromeRow: true, showSidebarToggle: true, onToggleSidebar: () => {} }));
    expect(withToggle).not.toContain('pt-[var(--oc-header-height,56px)]');
    expect(withToggle).toContain('pb-[11px]');
  });

  test('does not reserve anything unless asked to', () => {
    const classes = rootClasses(render({ hideDirectoryControls: true }));

    expect(classes).not.toContain('pt-[var(--oc-header-height,56px)]');
    expect(classes).toContain('py-1');
  });

  test('shows the sidebar toggle with the shared collapse icon and honours hideSearchAction', () => {
    const toggle = render({ showSidebarToggle: true, onToggleSidebar: () => {} });
    const collapseGlyph = renderToStaticMarkup(<SidebarLeftCollapseIcon className="h-[18px] w-[18px]" />);

    expect(toggle).toContain('aria-label="Close Sessions"');
    expect(toggle).toContain(collapseGlyph);
    expect(toggle).toContain('aria-label="Search Sessions"');
    expect(render({ showSidebarToggle: true, onToggleSidebar: () => {}, hideSearchAction: true })).not.toContain('Search Sessions');
    expect(render()).not.toContain('Close Sessions');
  });
});

// SessionSidebar owns the store graph that feeds these props, so the wiring stays a source pin.
describe('SessionSidebar header wiring', () => {
  test('passes the Electron chrome reservation, toggle and search visibility to the header', () => {
    const sessionSidebarSource = readFileSync(new URL('../SessionSidebar.tsx', import.meta.url), 'utf8');

    expect(sessionSidebarSource).toContain(
      'reserveExternalDesktopChromeRow={!mobileVariant && isDesktopShellRuntime}',
    );
    expect(sessionSidebarSource).toContain('showSidebarToggle={isWebRuntime}');
    expect(sessionSidebarSource).toContain('hideSearchAction={hideSearchInSidebarHeader}');
  });
});
