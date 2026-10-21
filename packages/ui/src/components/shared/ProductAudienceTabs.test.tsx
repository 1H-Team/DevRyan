import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as runtimeCapabilities from '@/lib/opencode/runtime-capabilities';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import { I18nProvider } from '@/lib/i18n';
import { setAuthPrincipal } from '@/lib/authSession';
import { useMainSidebarAudienceStore } from '@/stores/useMainSidebarAudienceStore';
import { ProductAudienceTabs } from './ProductAudienceTabs';

describe('ProductAudienceTabs', () => {
  // Preserve coverage of the retained component under its historical capability.
  const originalFeatureAvailable = runtimeCapabilities.isRuntimeFeatureAvailable;
  let featureSpy: ReturnType<typeof spyOn<typeof runtimeCapabilities, 'isRuntimeFeatureAvailable'>>;
  beforeEach(() => { featureSpy = spyOn(runtimeCapabilities, 'isRuntimeFeatureAvailable').mockImplementation((key, snapshot) => key === 'bots' || originalFeatureAvailable(key, snapshot)); });
  afterEach(() => featureSpy.mockRestore());
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

  test('supports standard tablist arrow, Home, and End keyboard navigation', async () => {
    await withDom(async (container) => {
      const { createRoot } = await import('react-dom/client');
      const root = createRoot(container as unknown as Element);
      const selections: string[] = [];
      const tab = (id: string) => container.find((node) => node.getAttribute('id') === id) as HostElement;
      const press = async (from: string, key: string) => {
        let prevented = false;
        await act(async () => {
          for (const listener of container.listeners.get('keydown') ?? []) {
            listener({ type: 'keydown', key, target: tab(from), bubbles: true, preventDefault() { prevented = true; }, stopPropagation() {} });
          }
        });
        return prevented;
      };
      try {
        await act(async () => {
          root.render(
            <I18nProvider>
              <ProductAudienceTabs audience="coding-agents" onAudienceChange={(audience) => selections.push(audience)} idPrefix="kb" panelId="panel" />
            </I18nProvider>,
          );
        });
        const agents = 'kb-coding-agents-tab';
        const bots = 'kb-bots-tab';

        expect(await press(agents, 'ArrowRight')).toBe(true);
        expect(selections.splice(0)).toEqual(['bots']);
        expect(container.ownerDocument.activeElement).toBe(tab(bots));

        // Navigation wraps in both directions.
        expect(await press(bots, 'ArrowRight')).toBe(true);
        expect(selections.splice(0)).toEqual(['coding-agents']);
        expect(await press(agents, 'ArrowLeft')).toBe(true);
        expect(selections.splice(0)).toEqual(['bots']);

        expect(await press(bots, 'Home')).toBe(true);
        expect(selections.splice(0)).toEqual(['coding-agents']);
        expect(await press(agents, 'End')).toBe(true);
        expect(selections.splice(0)).toEqual(['bots']);
        expect(container.ownerDocument.activeElement).toBe(tab(bots));

        // Other keys are left alone.
        expect(await press(agents, 'a')).toBe(false);
        expect(selections).toEqual([]);
      } finally {
        await act(async () => { root.unmount(); });
      }
    });
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
