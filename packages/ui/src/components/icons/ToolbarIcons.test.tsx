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

  // DesktopEdgeChrome, DesktopRightChromeActions and SidebarHeader pick these variants in
  // their own mounted/rendered tests. Header.tsx cannot be rendered without its full store graph.
  test('keeps the Header toggles on the shared semantic variants', () => {
    const header = readFileSync(resolve(testDir, '../layout/Header.tsx'), 'utf8');

    expect(header).toContain('SidebarLeftExpandIcon');
    expect(header).toContain('SidebarLeftCollapseIcon');
    expect(header).toContain('SidebarRightCollapseIcon');
    expect(header).toContain('SidebarRightExpandIcon');
    expect(header).not.toContain('chevronDirection=');
  });
});
