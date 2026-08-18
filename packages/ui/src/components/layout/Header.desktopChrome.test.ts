import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));

describe('Header desktop chrome', () => {
  test('does not portal sidebar actions into the right sidebar', () => {
    const source = readFileSync(resolve(testDir, 'Header.tsx'), 'utf8');

    expect(source).not.toContain('createPortal');
    expect(source).not.toContain('desktopRightSidebarActionsHost');
  });

  test('wraps desktop project actions and open-in-app controls in a no-drag cluster', () => {
    const source = readFileSync(resolve(testDir, 'Header.tsx'), 'utf8');
    const projectActionsIndex = source.indexOf('<ProjectActionsButton');
    const openInAppIndex = source.indexOf('<OpenInAppButton directory={actionDirectory} />');

    expect(source).toContain(
      'className="app-region-no-drag pointer-events-auto relative ml-auto mr-3 flex shrink-0 items-center gap-1.5"',
    );
    expect(projectActionsIndex).toBeGreaterThan(-1);
    expect(openInAppIndex).toBeGreaterThan(projectActionsIndex);
    expect(source).not.toContain('WorkStatusControl');
  });

  test('reserves left chrome width only when the desktop sidebar is closed', () => {
    const source = readFileSync(resolve(testDir, 'Header.tsx'), 'utf8');

    expect(source).toContain('desktopHeaderRowInsetStyle');
    expect(source).toContain('paddingLeft: DESKTOP_LEFT_CHROME_CLUSTER_WIDTH');
    expect(source).toContain('isDesktopApp && isSidebarOpen && \'pl-3\'');
    expect(source).not.toContain('style={{ width: DESKTOP_LEFT_CHROME_CLUSTER_WIDTH }}');
  });

  test('reserves right chrome width only when the right sidebar is closed', () => {
    const source = readFileSync(resolve(testDir, 'Header.tsx'), 'utf8');

    expect(source).toContain('const isRightSidebarOpen = useUIStore((state) => state.isRightSidebarOpen);');
    expect(source).toContain(
      'const reservesDesktopRightChromeSpace = showsDesktopRightChrome && !isRightSidebarOpen;',
    );
    expect(source).toContain(
      "reservesDesktopRightChromeSpace ? 'pr-[calc(11rem+var(--oc-wco-right-inset,0px))]' : 'pr-3'",
    );
    expect(source).toContain('paddingRight: reservesDesktopRightChromeSpace');
    expect(source).toContain(
      'transition-[padding-right] duration-300 ease-in-out motion-reduce:transition-none',
    );
  });

  test('pins desktop title left and project actions to the far right', () => {
    const source = readFileSync(resolve(testDir, 'Header.tsx'), 'utf8');

    expect(source).toContain('justify-start gap-2 overflow-hidden');
    expect(source).toContain('text-left typography-ui-label');
    expect(source).toContain('ml-auto mr-3 flex shrink-0 items-center gap-1.5');
  });

  test('separates compact project actions from the mobile services button', () => {
    const source = readFileSync(resolve(testDir, 'Header.tsx'), 'utf8');

    expect(source).toContain('className="mr-2 h-9"');
  });
});
