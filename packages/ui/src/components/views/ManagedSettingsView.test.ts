import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

describe('ManagedSettingsView capabilities', () => {
  const source = readFileSync(new URL('./ManagedSettingsFrame.tsx', import.meta.url), 'utf8');

  test('keeps Skills and MCP Servers available only as Coding Agent settings', () => {
    expect(source).toContain("slug: 'skills.installed'");
    expect(source).toContain("slug: 'mcp'");
    expect(source).toContain('<CapabilitySettingsWorkspace');
    expect(source).not.toContain('LazyBotCapabilitySidebar');
    expect(source).not.toContain('LazyBotCapabilityPanel');
    expect(source).toContain('audience="coding-agents"');
    expect(source).not.toContain('settingsPermissionBoundarySlug(slug, audience)');
  });

  test('orders the Plugins hub pages before Providers in managed navigation', () => {
    const pluginsIndex = source.indexOf("{ slug: 'plugins'");
    const skillsIndex = source.indexOf("{ slug: 'skills.installed'");
    const mcpIndex = source.indexOf("{ slug: 'mcp'");
    const providersIndex = source.indexOf("{ slug: 'providers'");

    expect(pluginsIndex).toBeGreaterThan(-1);
    expect(skillsIndex).toBeGreaterThan(pluginsIndex);
    expect(mcpIndex).toBeGreaterThan(skillsIndex);
    expect(providersIndex).toBeGreaterThan(mcpIndex);
  });

  test('contains no Bot capability assignment navigation', () => {
    expect(source).not.toContain('setBotCapabilityStage');
    expect(source).not.toContain('Back to Bots');
    expect(source).not.toContain("selectAudience(slug, 'bots')");
  });

  test('presents Plugins, Skills and MCP Servers as one permission-filtered tabbed destination', () => {
    expect(source).toContain("const MANAGED_PLUGIN_HUB_SLUGS: readonly ManagedPluginHubPage[] = ['plugins', 'skills.installed', 'mcp']");
    expect(source).toContain("id: 'plugins'");
    expect(source).toContain('<SettingsSectionTabs');
    expect(source).toContain('tabs={pluginHubPages.map');
    expect(source).toContain("ariaLabel={t('settings.plugins.tabs.aria')}");
  });

  test('folds Session Defaults into one Agents destination without tabs', () => {
    expect(source).toContain("id: 'agents',");
    expect(source).toContain('slugs: agentsPages.map((agentsPage) => agentsPage.slug)');
    expect(source).toContain("activeSlug === 'sessions' ? <PreparedSessionDefaultsPage /> : <PreparedAgentsPage />");
    expect(source).toContain('<PreparedAgentsSettingsPicker />');
    expect(source).not.toContain("section={'sessions'}");
    expect(source).not.toContain('tabs={agentsPages.map');
  });

  test('shows Providers without a Usage tab and keeps Usage only as a fallback', () => {
    expect(source).toContain("return providers ? [providers] : usage ? [usage] : [];");
    expect(source).toContain("settingsPage === 'usage' && providerFallback");
    expect(source).not.toContain('tabs={providerPages.map');
  });
});
