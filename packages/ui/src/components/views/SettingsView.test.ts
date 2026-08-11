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
import { getSettingsPageMeta, resolveSettingsSlug } from '@/lib/settings/metadata';
import { SETTINGS_NAV_SECTIONS } from '@/lib/settings/navigation';

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
    const topLevelSlugs = SETTINGS_NAV_SECTIONS.flatMap((section) => section.pages);

    expect(topLevelSlugs).not.toContain('behavior');
    expect(resolveSettingsSlug('behavior')).toBe('agents');
  });

  test('legacy GitHub settings destinations open User Management', () => {
    expect(resolveSettingsSlug('github')).toBe('users');
  });

  test('plugins sits between skills and magic prompts in workflow navigation', () => {
    const workflowPages = SETTINGS_NAV_SECTIONS
      .find((section) => section.labelKey === 'settings.view.nav.group.workflow')
      ?.pages ?? [];

    expect(resolveSettingsSlug('plugins')).toBe('plugins');
    expect(workflowPages).toContain('skills.installed');
    expect(workflowPages).toContain('plugins');
    expect(workflowPages).toContain('magic-prompts');
    expect(workflowPages.indexOf('plugins')).toBe(workflowPages.indexOf('skills.installed') + 1);
    expect(workflowPages.indexOf('magic-prompts')).toBe(workflowPages.indexOf('plugins') + 1);
  });

  test('exposes the About page so diagnostics are reachable in desktop settings', () => {
    const generalPages = SETTINGS_NAV_SECTIONS
      .find((section) => section.labelKey === 'settings.view.nav.group.general')
      ?.pages ?? [];

    expect(resolveSettingsSlug('about')).toBe('about');
    expect(generalPages).toContain('about');
  });

  test('places Bug Reports directly below User Management in development navigation', () => {
    const generalPages = SETTINGS_NAV_SECTIONS
      .find((section) => section.labelKey === 'settings.view.nav.group.general')
      ?.pages ?? [];
    const developmentPages = SETTINGS_NAV_SECTIONS
      .find((section) => section.labelKey === 'settings.view.nav.group.development')
      ?.pages ?? [];

    expect(generalPages).not.toContain('users');
    expect(developmentPages[0]).toBe('users');
    expect(developmentPages[1]).toBe('bug-reports');
    expect(getSettingsPageMeta('users')?.title).toBe('User Management');
    const bugReports = getSettingsPageMeta('bug-reports');
    expect(bugReports?.title).toBe('Bug Reports');
    expect(bugReports?.kind).toBe('single');
    expect(
      bugReports?.isAvailable?.({
        isVSCode: false,
        isWeb: true,
        isDesktop: false,
        isManaged: true,
      }),
    ).toBe(true);
    expect(
      bugReports?.isAvailable?.({
        isVSCode: false,
        isWeb: true,
        isDesktop: false,
        isManaged: false,
      }),
    ).toBe(false);
    expect(
      bugReports?.isAvailable?.({
        isVSCode: true,
        isWeb: false,
        isDesktop: false,
        isManaged: true,
      }),
    ).toBe(false);
  });
});
