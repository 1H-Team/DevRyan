import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./TunnelSettings.tsx', import.meta.url)),
  'utf8',
);

const messages = readFileSync(
  fileURLToPath(new URL('../../../lib/i18n/messages/en.settings.ts', import.meta.url)),
  'utf8',
);

describe('Managed Remote account eligibility UI', () => {
  test('derives eligibility from the authenticated principal and shows the setup callout', () => {
    expect(source).toContain('const principal = useAuthPrincipal();');
    expect(source).toContain('isManagedAccountLoginAvailable(principal.scope)');
    expect(source).toContain('role="alert"');
    expect(source).toContain("settings.openchamber.tunnel.managedAccountRequired.title");
    expect(messages).toContain("'settings.openchamber.tunnel.managedAccountRequired.title': 'Managed accounts required'");
    expect(messages).toContain('A shared UI password cannot identify or isolate remote developers.');
  });

  test('blocks start and retry actions when Managed Remote lacks a managed account', () => {
    const eligibilityGuard = "tunnelMode === 'managed-remote' && !managedAccountLoginAvailable";
    const guardCount = source.match(new RegExp(eligibilityGuard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length ?? 0;
    expect(guardCount > 3).toBe(true);
    expect(source).toContain("if (tunnelMode === 'managed-remote' && !managedAccountLoginAvailable)");
  });
});
