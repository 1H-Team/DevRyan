import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const testDir = dirname(fileURLToPath(import.meta.url));
const sidebarSource = () => readFileSync(resolve(testDir, 'AgentsSidebar.tsx'), 'utf8');

describe('AgentsSidebar agent icons', () => {
  test('renders the icon to the left of the agent name', () => {
    const sidebar = sidebarSource();
    const item = readFileSync(resolve(testDir, '../shared/SettingsSidebarItem.tsx'), 'utf8');

    // The shared row draws `icon` before `title`; the agent icon is passed as `icon`.
    expect(/icon=\{\(\s*<RiAiAgentLine/.test(sidebar)).toBe(true);
    expect(sidebar).toContain('title={entry.label}');
    expect(item.indexOf('{icon}')).toBeGreaterThan(-1);
    expect(item.indexOf('{icon}')).toBeLessThan(item.indexOf('{title}'));
  });

  test('tints each icon with that agent\'s own color', () => {
    const sidebar = sidebarSource();

    expect(sidebar).toContain("import { getAgentIconColor } from '@/lib/agentColors';");
    expect(sidebar).toContain('style={{ color: `var(${getAgentIconColor(entry.agent.name).var})` }}');
  });

  test('no longer varies the icon by agent mode', () => {
    const sidebar = sidebarSource();

    expect(sidebar).not.toContain('getAgentModeIcon');
    expect(sidebar).not.toContain('RiAiAgentFill');
    expect(sidebar).not.toContain('RiRobotLine');
  });
});
