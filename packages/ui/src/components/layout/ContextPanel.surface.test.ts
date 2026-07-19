import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./ContextPanel.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

describe('embedded session chat URL', () => {
  test('marks the embedded panel as an explicit desktop surface', () => {
    expect(source).toContain("url.searchParams.set('surface', 'desktop')");
  });

  test('matches right-sidebar motion for plan-only panel entrances and exits', () => {
    expect(source).toContain("import { useReducedMotion } from 'motion/react';");
    expect(source).toContain('data-plan-motion={activePlanMotion?.direction}');
    expect(source).toContain('requestContextPanelClose(directoryKey)');
    expect(source).toContain('requestContextPanelTabClose(directoryKey, tabID)');
    expect(source).not.toContain('shouldDeferPlanContent');
    expect(source).toContain("activeTab?.mode !== 'chat' && !isFileTabActive");
    expect(styles).toContain('oc-context-plan-panel-enter 300ms ease-in-out both');
    expect(styles).toContain('oc-context-plan-panel-exit 300ms ease-in-out both');
    expect(styles).toContain('oc-context-plan-content-enter 200ms ease-out both');
    expect(styles).toContain('oc-context-plan-content-exit 200ms ease-out both');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
