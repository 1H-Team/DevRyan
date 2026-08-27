import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { setAuthPrincipal } from '@/lib/authSession';
import { useMainSidebarAudienceStore } from '@/stores/useMainSidebarAudienceStore';
import { ProductAudienceTabs } from './ProductAudienceTabs';

describe('ProductAudienceTabs', () => {
  test('renders an accessible, mutually exclusive Coding Agents and Bots settings tablist', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ProductAudienceTabs
          audience="coding-agents"
          onAudienceChange={() => {}}
          idPrefix="test-audience"
          panelId="test-panel"
        />
      </I18nProvider>,
    );

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('id="test-audience-coding-agents-tab"');
    expect(markup).toContain('id="test-audience-bots-tab"');
    expect(markup).toContain('aria-controls="test-panel"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('Coding Agents');
    expect(markup).toContain('Bots');
  });

  test('renders equal-width Agents and Bots tabs in the sidebar', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ProductAudienceTabs
          audience="coding-agents"
          onAudienceChange={() => {}}
          idPrefix="sidebar-audience"
          panelId="sidebar-panel"
          variant="sidebar"
        />
      </I18nProvider>,
    );

    expect(markup).toContain('aria-label="Choose Agents or Bots"');
    expect(markup).toContain('>Agents</span>');
    expect(markup).toContain('>Bots</span>');
    expect(markup).not.toContain('Coding Agents');
    expect(markup).toContain('grid-cols-2');
    expect(markup).toContain('mb-1');
    expect(markup.match(/<svg/g)).toHaveLength(2);
  });

  test('supports standard tablist arrow, Home, and End keyboard navigation', () => {
    const source = readFileSync(new URL('./ProductAudienceTabs.tsx', import.meta.url), 'utf8');
    expect(source).toContain("event.key === 'ArrowRight'");
    expect(source).toContain("event.key === 'ArrowLeft'");
    expect(source).toContain("event.key === 'Home'");
    expect(source).toContain("event.key === 'End'");
    expect(source).toContain('selectAndFocus(nextIndex)');
  });

  test('uses equal-width columns for the sidebar audience tabs', () => {
    const source = readFileSync(new URL('./ProductAudienceTabs.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('grid-cols-[minmax(0,1.35fr)_minmax(0,0.65fr)]');
    expect(source).toContain("sidebar\n          ? 'mb-1 grid-cols-2'");
  });

  test('defaults cold starts to Coding Agents and retains the last in-session audience', () => {
    useMainSidebarAudienceStore.setState({ audience: 'coding-agents' });
    expect(useMainSidebarAudienceStore.getState().audience).toBe('coding-agents');
    useMainSidebarAudienceStore.getState().setAudience('bots');
    expect(useMainSidebarAudienceStore.getState().audience).toBe('bots');
    useMainSidebarAudienceStore.getState().setAudience('coding-agents');
  });

  test('hides the tablist and rejects Bots selection when policy disables Bots', () => {
    setAuthPrincipal({
      id: 'agents-only',
      email: 'agents-only@example.test',
      displayName: 'Agents Only',
      role: 'developer',
      scope: 'managed',
      policy: {
        settingsPages: [], bots: false, files: false, terminal: false, browser: true,
        createWorktrees: false, createBranches: false, manageProjects: false, manageUsers: false,
        manageGlobalSettings: false, manageGit: false, push: false, github: false,
      },
      assignments: [],
    });
    useMainSidebarAudienceStore.setState({ audience: 'coding-agents' });

    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ProductAudienceTabs
          audience="coding-agents"
          onAudienceChange={() => {}}
          idPrefix="agents-only-audience"
          botsAllowed={false}
        />
      </I18nProvider>,
    );
    useMainSidebarAudienceStore.getState().setAudience('bots');

    expect(markup).toBe('');
    expect(useMainSidebarAudienceStore.getState().audience).toBe('coding-agents');
    setAuthPrincipal(null);
  });
});
