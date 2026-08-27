import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

describe('CapabilitySettingsWorkspace', () => {
  const source = readFileSync(new URL('./CapabilitySettingsWorkspace.tsx', import.meta.url), 'utf8');

  test('keeps global Skills and MCP behind Coding Agent settings permissions only', () => {
    expect(source).not.toContain('ProductAudienceTabs');
    expect(source).not.toContain("audience === 'bots'");
    expect(source).toContain('<CapabilityMutationBoundary slug={slug} audience="coding-agents">');
    expect(source).toContain('<SettingsPagePermissionBoundary slug={slug}>');
  });
});
