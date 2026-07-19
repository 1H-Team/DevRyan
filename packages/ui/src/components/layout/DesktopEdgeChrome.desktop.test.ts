import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));

const readSource = (filename: string) => readFileSync(resolve(testDir, filename), 'utf8');

describe('DesktopEdgeChrome desktop drag regions', () => {
  test('does not mark the full-width overlay shell as a drag region', () => {
    const source = readSource('DesktopEdgeChrome.tsx');

    expect(source).toContain(
      "'pointer-events-none absolute inset-x-0 top-0 z-30 h-[var(--oc-header-height,56px)] select-none'",
    );
    expect(source).not.toContain(
      "'app-region-drag pointer-events-none absolute inset-x-0 top-0 z-30 h-[var(--oc-header-height,56px)] select-none'",
    );
  });

  test('uses a dedicated traffic-light drag filler and no-drag interactive clusters', () => {
    const source = readSource('DesktopEdgeChrome.tsx');

    expect(source).toContain('app-region-drag pointer-events-auto absolute top-0 left-0 h-full');
    expect(source).toContain("width: 'var(--oc-desktop-chrome-left, 0.75rem)'");
    expect(source).toContain(
      'app-region-no-drag pointer-events-auto absolute top-0 flex h-full items-center gap-1.5',
    );
    expect(source).toContain(
      'app-region-no-drag pointer-events-auto absolute top-0 flex h-full items-center',
    );
  });

  test('marks the right chrome action cluster root as no-drag', () => {
    const source = readSource('DesktopRightChromeActions.tsx');

    expect(source).toContain('<div className="app-region-no-drag flex items-center gap-1.5">');
  });

  test('orders service tabs as Usage, MCP, Instance', () => {
    const source = readSource('DesktopRightChromeActions.tsx');
    const usageIndex = source.indexOf("base.push({ value: 'usage'");
    const mcpIndex = source.indexOf("base.push({ value: 'mcp'");
    const instanceIndex = source.indexOf("base.push({ value: 'instance'");

    expect(usageIndex).toBeGreaterThan(-1);
    expect(mcpIndex).toBeGreaterThan(usageIndex);
    expect(instanceIndex).toBeGreaterThan(mcpIndex);
  });

  test('hides both action clusters for settings while preserving the drag filler', () => {
    const chromeSource = readSource('DesktopEdgeChrome.tsx');
    const layoutSource = readSource('MainLayout.tsx');

    expect(layoutSource).toContain('<DesktopEdgeChrome hideActions={isSettingsDialogOpen} />');
    expect(chromeSource).toContain('interface DesktopEdgeChromeProps {');
    expect(chromeSource).toContain('hideActions: boolean;');
    expect(chromeSource).toContain('export const DesktopEdgeChrome: React.FC<DesktopEdgeChromeProps> = ({ hideActions }) => {');
    expect(chromeSource.match(/!hideActions && \(/g)).toHaveLength(2);

    const dragFillerIndex = chromeSource.indexOf('app-region-drag pointer-events-auto absolute top-0 left-0 h-full');
    const firstActionGuardIndex = chromeSource.indexOf('!hideActions && (');
    expect(dragFillerIndex).toBeGreaterThan(-1);
    expect(firstActionGuardIndex).toBeGreaterThan(dragFillerIndex);
  });
});
