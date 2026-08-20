import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const readSource = (fileName: string): string => readFileSync(
  fileURLToPath(new URL(fileName, import.meta.url)),
  'utf8',
);

describe('provider disconnect requests', () => {
  for (const fileName of ['./ProvidersPage.tsx', './ProvidersSidebar.tsx']) {
    test(`includes the shared-host CSRF proof in ${fileName}`, () => {
      const source = readSource(fileName);
      expect(source).toContain("'X-DevRyan-CSRF': '1'");
    });
  }
});
