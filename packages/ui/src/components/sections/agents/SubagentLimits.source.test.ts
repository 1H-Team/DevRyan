import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const pageSource = readFileSync(new URL('./AgentsPage.tsx', import.meta.url), 'utf8');
const sectionSource = readFileSync(new URL('./SubagentLimitsSection.tsx', import.meta.url), 'utf8');
const behaviorSource = readFileSync(new URL('../behavior/BehaviorPage.tsx', import.meta.url), 'utf8');

describe('sub-agent limits presentation', () => {
  test('sits with the host-wide policy page, never inside a single agent editor', () => {
    expect(pageSource).toContain('<SubagentLimitsSection canEdit={isHostModelEditor} />');
    expect(pageSource).toContain('if (behaviorUiHidden) return null;');
    expect(pageSource.indexOf('<SubagentLimitsSection'))
      .toBeLessThan(pageSource.indexOf("t('settings.agents.page.section.identityRole')"));
    expect(behaviorSource).toContain('{children}');
  });

  test('offers host-only controls that other principals see read-only', () => {
    expect(sectionSource).toContain("t('settings.agents.limits.title')");
    expect(sectionSource).toContain("t('settings.agents.limits.concurrent.label')");
    expect(sectionSource).toContain("t('settings.agents.limits.concurrent.description')");
    expect(sectionSource).toContain("t('settings.agents.limits.pressure.label')");
    expect(sectionSource).toContain("t('settings.agents.limits.pressure.description')");
    expect(sectionSource).toContain('min={CONCURRENT_SUBAGENTS_MIN}');
    expect(sectionSource).toContain('max={CONCURRENT_SUBAGENTS_MAX}');
    expect(sectionSource).toContain('checked={limits.pauseUnderMemoryPressure}');
    expect(sectionSource.match(/\{canEdit \? \(/g)).toHaveLength(2);
    expect(sectionSource).toContain("t('settings.agents.limits.readOnly.on')");
  });

  test('saves on change through the agents store, reports failures, and hides an unavailable sampler', () => {
    expect(sectionSource).toContain('saveOrchestrationLimits(input).catch(');
    expect(sectionSource).toContain("t('settings.agents.limits.toast.saveFailed')");
    expect(sectionSource).toContain('getOrchestrationLimits().catch(');
    expect(sectionSource).toContain("t('settings.agents.limits.toast.loadFailed')");
    expect(sectionSource).toContain("limits.pressure.source !== 'unavailable'");
    expect(sectionSource).toContain("t('settings.agents.limits.pressure.status'");
    expect(sectionSource).toContain('if (!limits) return null;');
  });
});
