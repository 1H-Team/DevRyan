import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const providersPageSource = readFileSync(
  fileURLToPath(new URL('./ProvidersPage.tsx', import.meta.url)),
  'utf8',
);

describe('ProvidersPage model list', () => {
  // Candidate lint rule: no-restricted-syntax on Identifier[name=/^(contextTokens|outputTokens)$/] in ProvidersPage.tsx.
  test('does not render context and output token badges in provider model rows', () => {
    expect(providersPageSource).not.toContain('contextTokens');
    expect(providersPageSource).not.toContain('outputTokens');
    expect(providersPageSource).not.toContain('settings.providers.page.models.tokenBadge.context');
    expect(providersPageSource).not.toContain('settings.providers.page.models.tokenBadge.output');
  });
});
