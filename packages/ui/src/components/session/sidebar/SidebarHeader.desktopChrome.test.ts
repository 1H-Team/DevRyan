import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const sidebarDir = resolve(testDir, '..');

const readSource = (path: string) => readFileSync(resolve(testDir, path), 'utf8');
const readSessionSource = (path: string) => readFileSync(resolve(sidebarDir, path), 'utf8');

describe('SidebarHeader desktop chrome spacing', () => {
  test('reserves the external Electron chrome row before sidebar actions', () => {
    const headerSource = readSource('SidebarHeader.tsx');
    const sessionSidebarSource = readSessionSource('SessionSidebar.tsx');

    expect(headerSource).toContain('reserveExternalDesktopChromeRow?: boolean');
    expect(headerSource).toContain('reserveExternalChromeOnly');
    expect(headerSource).toContain('pt-[var(--oc-header-height,56px)]');
    expect(headerSource).toContain('reserveExternalDesktopChromeRow && !showTopRow');

    expect(sessionSidebarSource).toContain('reserveExternalDesktopChromeRow={isDesktopShellRuntime && !mobileVariant && !isVSCode}');
    expect(sessionSidebarSource).toContain('showSidebarToggle={isWebRuntime}');
    expect(sessionSidebarSource).toContain('hideSearchAction={hideSearchInSidebarHeader}');
  });
});
