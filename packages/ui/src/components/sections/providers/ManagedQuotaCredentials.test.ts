import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readSibling = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
const source = readSibling('./ManagedQuotaCredentials.tsx');
const supportSource = readSibling('./managedQuotaCredentialSupport.ts');

// Credential routing, secret-input isolation and the Zen device flow are behaviour tests:
// ManagedQuotaCredentials.pasted.mounted.test.tsx and ManagedQuotaCredentials.mounted.test.tsx.
describe('ManagedQuotaCredentials', () => {
  test('uses the existing quota refresh coordinator', () => {
    expect(supportSource).toContain('quotaRefreshCoordinator.refreshNow');
    expect(source).toContain('refreshQuotaAfterCredentialChange');
  });
});
