import type React from 'react';
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
import type { SettingsPageSlug } from './metadata';

type SettingsNavIcon = React.ComponentType<{ className?: string }>;

export const SETTINGS_NAV_ICONS = {
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
} satisfies Record<SettingsPageSlug, SettingsNavIcon | null>;

export function getSettingsNavIcon(slug: SettingsPageSlug): SettingsNavIcon | null {
  if (Object.prototype.hasOwnProperty.call(SETTINGS_NAV_ICONS, slug)) {
    return SETTINGS_NAV_ICONS[slug];
  }
  return RiRobot2Line;
}
