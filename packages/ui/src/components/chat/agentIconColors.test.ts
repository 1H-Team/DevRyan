import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const readSource = (relativePath: string) => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8',
);

describe('agent glyph color wiring', () => {
  test('uses fixed role colors only for agent glyphs', () => {
    const messageHeader = readSource('./message/MessageHeader.tsx');
    const managedTaskList = readSource('./ManagedTaskList.tsx');
    const modelControls = readSource('./ModelControls.tsx');

    expect(messageHeader).toContain('getAgentIconColor(agentName).var');
    expect(messageHeader).toContain('getAgentColor(agentName).var');
    expect(managedTaskList).toContain('getAgentIconColor(group.agent).var');
    expect(modelControls.match(/getAgentIconColor\(uiAgentName\)\.var/g)).toHaveLength(2);
    expect(modelControls).toContain('getAgentIconColor(agent.name)');
    expect(modelControls).toContain('style={{ color: `var(${agentIconColor.var})` }}');

    expect(modelControls).toContain("getAgentColor(agent.name).class");
    expect(modelControls).toContain('const agentColor = getAgentColor(agent.name);');
  });

  test('keeps plan mode on its explicit warning-color override', () => {
    const modelControls = readSource('./ModelControls.tsx');
    const mobileAgentButton = readSource('./MobileAgentButton.tsx');

    expect(modelControls).toContain(
      "const PLAN_MODE_AGENT_STYLE: React.CSSProperties = { color: 'var(--status-warning)' };",
    );
    expect(modelControls.match(/isPlanModeSelected \? PLAN_MODE_AGENT_STYLE : uiAgentName \? \{ color: `var\(\$\{getAgentIconColor\(uiAgentName\)\.var\}\)` \} : undefined/g)).toHaveLength(2);
    expect(mobileAgentButton).toContain(
      "const PLAN_MODE_AGENT_STYLE: React.CSSProperties = { color: 'var(--status-warning)' };",
    );
    expect(mobileAgentButton).toContain('getAgentIconColor');
    expect(mobileAgentButton).toContain('style={isPlanModeSelected ? PLAN_MODE_AGENT_STYLE');
    expect(mobileAgentButton).toContain('style={PLAN_MODE_AGENT_STYLE}');
  });
});
