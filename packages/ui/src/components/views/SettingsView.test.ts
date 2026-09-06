import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
  getSettingsBackButtonClassName,
  getSettingsBackButtonHeaderClassName,
  getSettingsBackButtonHeaderContentClassName,
  getSettingsFullPageOverlayClassName,
  getSettingsNavButtonClassName,
  getSettingsNavScrollClassName,
  getSettingsPageSidebarClassName,
} from './SettingsView.styles';
import { resolveMobileSettingsBackStage } from './SettingsView.mobileNavigation';
import {
  getSettingsPageMeta,
  resolveSettingsSlug,
  type SettingsRuntimeContext,
} from '@/lib/settings/metadata';
import {
  SETTINGS_NAV_SECTIONS,
  getSettingsDestinationFallbackSlug,
} from '@/lib/settings/navigation';

const getNavSlugs = (labelKey: string) => SETTINGS_NAV_SECTIONS
  .find((section) => section.labelKey === labelKey)
  ?.destinations.flatMap((destination) => destination.slugs) ?? [];

describe('SettingsView navigation', () => {
  test('mobile split-page content backs to the split page list', () => {
    expect(resolveMobileSettingsBackStage('page-content', { kind: 'split' })).toBe('page-sidebar');
  });

  test('mobile split-page list backs to the settings nav', () => {
    expect(resolveMobileSettingsBackStage('page-sidebar', { kind: 'split' })).toBe('nav');
  });

  test('mobile single-page content backs to the settings nav', () => {
    expect(resolveMobileSettingsBackStage('page-content', { kind: 'single' })).toBe('nav');
  });

  test('mobile settings nav stays on nav when back is resolved', () => {
    expect(resolveMobileSettingsBackStage('nav', { kind: 'split' })).toBe('nav');
  });

  test('settings sidebar page buttons fill the scrollable row without changing semantics', () => {
    const className = getSettingsNavButtonClassName(false);

    expect(className.split(/\s+/)).toContain('w-full');
    expect(className.split(/\s+/)).toContain('text-left');
  });

  test('settings nav scroll area reserves top chrome space above its scrollable content', () => {
    const className = getSettingsNavScrollClassName({ reserveTopChrome: true });
    const classes = className.split(/\s+/);

    expect(classes).toContain('overflow-y-auto');
    expect(classes).toContain('pt-14');
  });

  test('settings full-page overlay covers the app shell without dialog styling', () => {
    const className = getSettingsFullPageOverlayClassName();
    const classes = className.split(/\s+/);

    expect(classes).toContain('absolute');
    expect(classes).toContain('inset-0');
    expect(classes).toContain('z-20');
    expect(classes).toContain('bg-background');
    expect(classes).toContain('app-region-no-drag');
    expect(classes).not.toContain('rounded-xl');
    expect(classes).not.toContain('shadow-none');
  });

  test('settings back button is positioned as the full-page top-left control', () => {
    const className = getSettingsBackButtonClassName();
    const classes = className.split(/\s+/);

    expect(classes).toContain('absolute');
    expect(classes).toContain('left-3');
    expect(classes).toContain('top-3');
    expect(classes).toContain('z-50');
  });

  test('settings back button avoids macOS desktop traffic lights', () => {
    const className = getSettingsBackButtonClassName({ avoidMacTrafficLights: true });
    const classes = className.split(/\s+/);

    expect(classes).toContain('absolute');
    expect(classes).toContain('left-[5.5rem]');
    expect(classes).not.toContain('left-3');
    expect(classes).toContain('top-3');
    expect(classes).toContain('z-50');
  });

  test('inline settings back button fills the sidebar row', () => {
    const className = getSettingsBackButtonClassName({ placement: 'inline' });
    const classes = className.split(/\s+/);

    expect(classes).toContain('w-full');
    expect(classes).toContain('h-8');
    expect(classes).toContain('gap-2');
    expect(classes).toContain('px-2');
    expect(classes).toContain('rounded-md');
    expect(classes).not.toContain('absolute');
    expect(classes).not.toContain('w-9');
    expect(classes).not.toContain('pl-[5.5rem]');
  });

  test('inline settings back button stays left-aligned on macOS desktop', () => {
    const className = getSettingsBackButtonClassName({
      placement: 'inline',
      avoidMacTrafficLights: true,
    });
    const classes = className.split(/\s+/);

    expect(classes).toContain('px-2');
    expect(classes).not.toContain('pl-[5.5rem]');
    expect(classes).not.toContain('absolute');
  });

  test('settings back button header stays fixed above the scrollable nav', () => {
    const className = getSettingsBackButtonHeaderClassName();
    const classes = className.split(/\s+/);

    expect(classes).toContain('shrink-0');
    expect(classes).toContain('pt-2');
    expect(classes).not.toContain('px-2');
    expect(classes).not.toContain('sticky');
    expect(classes).not.toContain('absolute');
  });

  test('settings back button header clears macOS desktop titlebar without sticky positioning', () => {
    const className = getSettingsBackButtonHeaderClassName({ avoidMacTrafficLights: true });
    const classes = className.split(/\s+/);

    expect(classes).toContain('shrink-0');
    expect(classes).toContain('pt-14');
    expect(classes).not.toContain('sticky');
    expect(classes).not.toContain('pl-[5.5rem]');
    expect(classes).not.toContain('px-2');
  });

  test('settings back button header content keeps sidebar padding on macOS desktop', () => {
    const className = getSettingsBackButtonHeaderContentClassName();
    const classes = className.split(/\s+/);

    expect(classes).toContain('px-2');
    expect(classes).toContain('pb-2');
    expect(classes).not.toContain('pl-[5.5rem]');
  });

  test('skills settings list is wider than other split lists', () => {
    const defaultClassName = getSettingsPageSidebarClassName('agents');
    const skillsClassName = getSettingsPageSidebarClassName('skills.installed');

    expect(defaultClassName).toContain('w-[264px]');
    expect(defaultClassName).toContain('min-w-[264px]');
    expect(defaultClassName).toContain('max-w-[264px]');
    expect(skillsClassName).toContain('w-[334px]');
    expect(skillsClassName).toContain('min-w-[334px]');
    expect(skillsClassName).toContain('max-w-[334px]');
  });

  test('behavior is routed through agents instead of top-level navigation', () => {
    const topLevelSlugs = SETTINGS_NAV_SECTIONS.flatMap((section) => (
      section.destinations.flatMap((destination) => destination.slugs)
    ));

    expect(topLevelSlugs).not.toContain('behavior');
    expect(resolveSettingsSlug('behavior')).toBe('agents');
  });

  test('legacy GitHub settings destinations open User Management', () => {
    expect(resolveSettingsSlug('github')).toBe('users');
  });

  test('MCP Servers sits immediately below Providers in connections navigation', () => {
    const connectionsPages = getNavSlugs('settings.view.nav.group.connections');

    expect(resolveSettingsSlug('plugins')).toBe('plugins');
    expect(connectionsPages).toContain('providers');
    expect(connectionsPages).toContain('mcp');
    expect(connectionsPages.indexOf('mcp')).toBe(connectionsPages.indexOf('usage') + 1);
    expect(getNavSlugs('settings.view.nav.group.workflow')).not.toContain('mcp');
    expect(getSettingsPageMeta('mcp')?.title).toBe('MCP Servers');
  });

  test('places Bots immediately below Agents in workflow navigation', () => {
    const workflowPages = getNavSlugs('settings.view.nav.group.workflow');

    expect(workflowPages.indexOf('bots')).toBe(workflowPages.indexOf('agents') + 1);
  });

  test('keeps global Skills and MCP as Coding Agent settings without Bot assignment tabs', () => {
    const source = readFileSync(new URL('./SettingsView.tsx', import.meta.url), 'utf8');
    expect(source).toContain("settingsSlug === 'skills.installed' || settingsSlug === 'mcp'");
    expect(source).not.toContain('ProductAudienceTabs');
    expect(source).not.toContain('skillsAudience');
    expect(source).not.toContain('mcpAudience');
    expect(source).not.toContain('LazyBotCapabilitySidebar');
    expect(source).not.toContain('LazyBotCapabilityPanel');
    expect(source).toContain("const settingsAudience = 'coding-agents' as const");
  });

  test('places commands after shortcuts in General and folds Chat into Appearance', () => {
    const generalPages = getNavSlugs('settings.view.nav.group.general');
    const workflowPages = getNavSlugs('settings.view.nav.group.workflow');
    const developmentPages = getNavSlugs('settings.view.nav.group.development');

    expect(generalPages.indexOf('commands')).toBe(generalPages.indexOf('shortcuts') + 1);
    expect(workflowPages).not.toContain('chat');
    expect(developmentPages).not.toContain('commands');
  });

  test('exposes the About page so diagnostics are reachable in desktop settings', () => {
    const generalPages = getNavSlugs('settings.view.nav.group.general');
    const developmentPages = getNavSlugs('settings.view.nav.group.development');

    expect(resolveSettingsSlug('about')).toBe('about');
    expect(generalPages).not.toContain('about');
    expect(developmentPages.at(-2)).toBe('projects');
    expect(developmentPages.at(-1)).toBe('about');
  });

  test('places Bug Reports directly below User Management in development navigation', () => {
    const generalPages = getNavSlugs('settings.view.nav.group.general');
    const developmentPages = getNavSlugs('settings.view.nav.group.development');

    expect(generalPages).not.toContain('users');
    expect(developmentPages[0]).toBe('users');
    expect(developmentPages[1]).toBe('bug-reports');
    expect(getSettingsPageMeta('users')?.title).toBe('User Management');
    const bugReports = getSettingsPageMeta('bug-reports');
    expect(bugReports?.title).toBe('Bug Reports');
    expect(bugReports?.kind).toBe('single');
    expect(
      bugReports?.isAvailable?.({

        isWeb: true,
        isDesktop: false,
        isManaged: true,
      }),
    ).toBe(true);
    expect(
      bugReports?.isAvailable?.({

        isWeb: true,
        isDesktop: false,
        isManaged: false,
      }),
    ).toBe(false);
  });

  test('places MCP Servers after the Providers destination in Connections', () => {
    const connections = SETTINGS_NAV_SECTIONS
      .find((section) => section.labelKey === 'settings.view.nav.group.connections')
      ?.destinations ?? [];

    expect(connections.map((destination) => destination.id)).toEqual([
      'providers',
      'mcp',
      'remote-connections',
    ]);
    expect(connections[0]?.slugs).toEqual(['providers', 'usage']);
    expect(connections[1]?.slugs).toEqual(['mcp']);
    expect(connections[2]?.slugs).toEqual(['tunnel', 'remote-instances']);
    expect(connections[2]?.labelKey).toBe('settings.page.remoteConnections.title');
  });

  test('keeps grouped destinations on the first accessible child tab', () => {
    expect(getSettingsDestinationFallbackSlug('providers', new Set(['usage']))).toBe('usage');
    expect(getSettingsDestinationFallbackSlug('usage', new Set(['providers']))).toBe('providers');
    expect(getSettingsDestinationFallbackSlug('remote-instances', new Set(['tunnel', 'remote-instances']))).toBe('tunnel');
    expect(getSettingsDestinationFallbackSlug('remote-instances', new Set(['tunnel']))).toBe('tunnel');
    expect(getSettingsDestinationFallbackSlug('tunnel', new Set())).toBeNull();
  });

  test('exposes both remote tabs on desktop, only Tunnel on web', () => {
    const remoteSlugs = ['remote-instances', 'tunnel'] as const;
    const visibleIn = (ctx: SettingsRuntimeContext) => (
      remoteSlugs.filter((slug) => getSettingsPageMeta(slug)?.isAvailable?.(ctx) ?? true)
    );

    expect(visibleIn({ isDesktop: true, isWeb: false, isManaged: false }))
      .toEqual(['remote-instances', 'tunnel']);
    expect(visibleIn({ isDesktop: false, isWeb: true, isManaged: false }))
      .toEqual(['tunnel']);
  });
});
