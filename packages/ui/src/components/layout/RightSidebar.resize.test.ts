import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rightSidebarSource = readFileSync(
  fileURLToPath(new URL('./RightSidebar.tsx', import.meta.url)),
  'utf8',
);

describe('RightSidebar resize presentation', () => {
  test('updates the outer shell and inner content from the same live width', () => {
    const liveWidthBody = rightSidebarSource.slice(
      rightSidebarSource.indexOf('const applyLiveWidth'),
      rightSidebarSource.indexOf('const appliedWidth'),
    );

    expect(liveWidthBody).toContain(
      "sidebar.style.setProperty('--oc-right-sidebar-width', `${nextWidth}px`)",
    );
    expect(liveWidthBody).toContain(
      "sidebar.style.setProperty('--oc-right-sidebar-content-width', `${nextWidth}px`)",
    );
  });

  test('keeps the stored content width independent while the sidebar collapses', () => {
    expect(rightSidebarSource).toContain(
      "['--oc-right-sidebar-content-width' as string]: `${isResizing ? (resizingWidthRef.current ?? contentWidth) : contentWidth}px`",
    );
    expect(rightSidebarSource).toContain("width: 'var(--oc-right-sidebar-content-width)'");
    expect(rightSidebarSource).not.toContain(
      "['--oc-right-sidebar-content-width' as string]: `${contentWidth}px`,\n        }}",
    );
  });
});
