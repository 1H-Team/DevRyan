import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

describe('ManagedSettingsView capabilities', () => {
  const source = readFileSync(new URL('./ManagedSettingsView.tsx', import.meta.url), 'utf8');

  test('keeps Skills and MCP Servers available only as Coding Agent settings', () => {
    expect(source).toContain("slug: 'skills.installed'");
    expect(source).toContain("slug: 'mcp'");
    expect(source).toContain('<CapabilitySettingsWorkspace');
    expect(source).not.toContain('LazyBotCapabilitySidebar');
    expect(source).not.toContain('LazyBotCapabilityPanel');
    expect(source).toContain('audience="coding-agents"');
    expect(source).not.toContain('settingsPermissionBoundarySlug(slug, audience)');
  });

  test('places MCP Servers immediately below Providers in managed navigation', () => {
    const providersIndex = source.indexOf("{ slug: 'providers'");
    const usageIndex = source.indexOf("{ slug: 'usage'");
    const mcpIndex = source.indexOf("{ slug: 'mcp'");

    expect(providersIndex).toBeGreaterThan(-1);
    expect(usageIndex).toBeGreaterThan(providersIndex);
    expect(mcpIndex).toBeGreaterThan(usageIndex);
  });

  test('contains no Bot capability assignment navigation', () => {
    expect(source).not.toContain('setBotCapabilityStage');
    expect(source).not.toContain('Back to Bots');
    expect(source).not.toContain("selectAudience(slug, 'bots')");
  });

  test('presents Providers and Usage as one permission-filtered tabbed destination', () => {
    expect(source).toContain('const providerPages = React.useMemo');
    expect(source).toContain("id: 'providers'");
    expect(source).toContain('<SettingsSectionTabs');
    expect(source).toContain('tabs={providerPages.map');
    expect(source).toContain("activeSlug === 'providers' || activeSlug === 'usage'");
  });
});
