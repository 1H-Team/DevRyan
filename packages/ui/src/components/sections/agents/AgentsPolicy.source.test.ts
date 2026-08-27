import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const pageSource = readFileSync(new URL('./AgentsPage.tsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('./AgentsSidebar.tsx', import.meta.url), 'utf8');
const sessionsSource = readFileSync(new URL('../openchamber/AgentModelDefaultsSettings.tsx', import.meta.url), 'utf8');

describe('managed Agent settings presentation', () => {
  test('removes Global Behavior and falls back to an individual agent when hidden', () => {
    expect(sidebarSource).toContain('isGlobalAgentBehaviorUiHidden(principal)');
    expect(sidebarSource).toContain('!behaviorHidden && renderBehavior()');
    expect(sidebarSource).toContain('setSelectedAgent(fallback.name)');
    expect(pageSource).toContain('behaviorUiHidden ? null : <BehaviorPage />');
  });

  test('uses personal defaults for authorized developers and keeps other fields read-only', () => {
    expect(pageSource).toContain('canEditPersonalAgentModels(authPrincipal)');
    expect(pageSource).toContain('await persistAgentModelSelection(');
    expect(pageSource).toContain('await resetAgentModelSelection(selectedAgentName)');
    expect(pageSource).toContain('disabled={isReadOnly}');
    expect(pageSource).toContain('Reset to Host');
    expect(sessionsSource).toContain('if (!canEditPersonalAgentModels(principal)) return null;');
  });
});
