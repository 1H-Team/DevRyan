import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const testDir = dirname(fileURLToPath(import.meta.url));
const sidebarSource = () => readFileSync(resolve(testDir, 'AgentsSidebar.tsx'), 'utf8');

describe('AgentsSidebar agent icons', () => {
  test('renders the icon to the left of the agent name', () => {
    const sidebar = sidebarSource();

    const iconIndex = sidebar.indexOf('<RiAiAgentLine');
    const nameIndex = sidebar.indexOf('{formatAgentDisplayName(agent.name)}');

    expect(iconIndex).toBeGreaterThan(-1);
    expect(nameIndex).toBeGreaterThan(-1);
    expect(iconIndex).toBeLessThan(nameIndex);
  });

  test('tints each icon with that agent\'s own color', () => {
    const sidebar = sidebarSource();

    expect(sidebar).toContain("import { getAgentIconColor } from '@/lib/agentColors';");
    expect(sidebar).toContain('style={{ color: `var(${getAgentIconColor(agent.name).var})` }}');
  });

  test('no longer varies the icon by agent mode', () => {
    const sidebar = sidebarSource();

    expect(sidebar).not.toContain('getAgentModeIcon');
    expect(sidebar).not.toContain('RiAiAgentFill');
    expect(sidebar).not.toContain('RiRobotLine');
  });
});
