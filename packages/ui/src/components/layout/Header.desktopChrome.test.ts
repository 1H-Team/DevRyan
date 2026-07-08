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

    expect(source).toContain(
      'className="app-region-no-drag pointer-events-auto relative flex shrink-0 items-center gap-1.5"',
    );
    expect(source).toContain('<ProjectActionsButton');
    expect(source).toContain('<OpenInAppButton directory={actionDirectory} />');
  });
});
