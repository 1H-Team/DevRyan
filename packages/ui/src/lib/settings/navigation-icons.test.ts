import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  RiAiAgentLine,
  RiAiGenerate2,
  RiBarChart2Line,
  RiBookLine,
  RiBookOpenLine,
  RiBrainLine,
  RiChatAi3Line,
  RiChatHistoryLine,
  RiCloudLine,
  RiCommandLine,
  RiFoldersLine,
  RiGithubLine,
  RiGlobalLine,
  RiInformationLine,
  RiMicLine,
  RiNotification3Line,
  RiPaletteLine,
  RiPlugLine,
  RiRobot2Line,
  RiServerLine,
  RiSlashCommands2,
} from '@remixicon/react';
import { McpIcon } from '@/components/icons/McpIcon';
import { SETTINGS_PAGE_METADATA } from './metadata';

const moduleUrl = new URL('./navigation-icons.ts', import.meta.url);

describe('settings navigation icons', () => {
  test('keeps lightweight icon metadata complete and preserves every icon mapping', async () => {
    expect(existsSync(fileURLToPath(moduleUrl))).toBe(true);

    const loaded: unknown = await import(moduleUrl.href);
    expect(Boolean(loaded) && typeof loaded === 'object').toBe(true);
    if (!loaded || typeof loaded !== 'object') {
      throw new Error('Settings navigation icon module is invalid');
    }

    const getSettingsNavIcon: unknown = Reflect.get(loaded, 'getSettingsNavIcon');
    const settingsNavIcons: unknown = Reflect.get(loaded, 'SETTINGS_NAV_ICONS');
    expect(typeof getSettingsNavIcon).toBe('function');
    expect(Boolean(settingsNavIcons) && typeof settingsNavIcons === 'object').toBe(true);

    if (typeof getSettingsNavIcon !== 'function' || !settingsNavIcons || typeof settingsNavIcons !== 'object') {
      throw new Error('Settings navigation icon exports are invalid');
    }

    const expectedIcons = {
      home: null,
      projects: RiFoldersLine,
      'remote-instances': RiServerLine,
      appearance: RiPaletteLine,
      chat: RiChatAi3Line,
      'magic-prompts': RiAiGenerate2,
      notifications: RiNotification3Line,
      shortcuts: RiCommandLine,
      sessions: RiChatHistoryLine,
      providers: RiCloudLine,
      agents: RiAiAgentLine,
      behavior: RiBrainLine,
      commands: RiSlashCommands2,
      mcp: McpIcon,
      'skills.installed': RiBookOpenLine,
      'skills.catalog': RiBookLine,
      plugins: RiPlugLine,
      git: RiGithubLine,
      usage: RiBarChart2Line,
      voice: RiMicLine,
      tunnel: RiGlobalLine,
      about: RiInformationLine,
    } as const;

    expect(Object.keys(settingsNavIcons).sort()).toEqual(
      SETTINGS_PAGE_METADATA.map((page) => page.slug).sort(),
    );

    for (const [slug, expectedIcon] of Object.entries(expectedIcons)) {
      expect(Reflect.get(settingsNavIcons, slug)).toBe(expectedIcon);
      expect(getSettingsNavIcon(slug)).toBe(expectedIcon);
    }

    expect(getSettingsNavIcon('unknown')).toBe(RiRobot2Line);
  });
});
