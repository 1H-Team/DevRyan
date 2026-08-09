import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SidebarLeftCollapseIcon,
  SidebarLeftExpandIcon,
  SidebarRightCollapseIcon,
  SidebarRightExpandIcon,
} from './ToolbarIcons';

const testDir = dirname(fileURLToPath(import.meta.url));

describe('semantic sidebar toggle icons', () => {
  test('points left-sidebar toggles toward their expand and collapse destinations', () => {
    const expandMarkup = renderToStaticMarkup(<SidebarLeftExpandIcon />);
    const collapseMarkup = renderToStaticMarkup(<SidebarLeftCollapseIcon />);

    expect(expandMarkup).toContain('d="m9.5 9.5 2.5 2.5-2.5 2.5"');
    expect(collapseMarkup).toContain('d="M14.5 9.5 12 12l2.5 2.5"');
  });

  test('points right-sidebar toggles toward their expand and collapse destinations', () => {
    const expandMarkup = renderToStaticMarkup(<SidebarRightExpandIcon />);
    const collapseMarkup = renderToStaticMarkup(<SidebarRightCollapseIcon />);

    expect(expandMarkup).toContain('d="M14.5 9.5 12 12l2.5 2.5"');
    expect(collapseMarkup).toContain('d="m9.5 9.5 2.5 2.5-2.5 2.5"');
  });

  test('keeps browser and Electron controls on the shared semantic variants', () => {
    const sources = [
      '../layout/DesktopEdgeChrome.tsx',
      '../layout/DesktopRightChromeActions.tsx',
      '../layout/Header.tsx',
      '../session/sidebar/SidebarHeader.tsx',
    ].map((path) => readFileSync(resolve(testDir, path), 'utf8'));

    expect(sources[0]).toContain('SidebarLeftCollapseIcon');
    expect(sources[0]).toContain('SidebarLeftExpandIcon');
    expect(sources[1]).toContain('SidebarRightCollapseIcon');
    expect(sources[1]).toContain('SidebarRightExpandIcon');
    expect(sources[2]).toContain('SidebarLeftExpandIcon');
    expect(sources[3]).toContain('SidebarLeftCollapseIcon');
    for (const source of sources) {
      expect(source).not.toContain('chevronDirection=');
    }
  });
});
