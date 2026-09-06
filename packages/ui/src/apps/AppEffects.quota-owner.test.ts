import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const source = (relativePath: string) => readFileSync(resolve(testDirectory, relativePath), 'utf8');

describe('quota refresh runtime ownership', () => {
  test('mounts one lifecycle owner in app effects', () => {
    const appEffects = source('AppEffects.tsx');

    expect(appEffects).toContain('const QuotaRefreshOwner');
    expect(appEffects).toContain('quotaRefreshCoordinator.start()');
    expect(appEffects).toContain('quotaRefreshCoordinator.stop()');
    expect(appEffects).toContain('<QuotaRefreshOwner enabled={embeddedBackgroundWorkEnabled} />');
  });

  test('keeps quota intervals out of rendering surfaces', () => {
    const renderingSurfaces = [
      '../components/layout/Header.tsx',
      '../components/layout/DesktopRightChromeActions.tsx',
      '../components/sections/usage/UsagePage.tsx',
      '../components/sections/usage/UsageSidebar.tsx',
    ].map(source).join('\n');

    expect(renderingSurfaces).not.toContain('useQuotaAutoRefresh');
    expect(renderingSurfaces).not.toContain('setInterval(');
  });
});
