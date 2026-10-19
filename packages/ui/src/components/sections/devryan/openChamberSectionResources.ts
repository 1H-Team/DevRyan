import { createPreparedSettingsComponent } from '@/components/views/preparedSettingsComponent';

export const openChamberSectionResources = {
  visual: createPreparedSettingsComponent(() => import('./VisualSectionContent').then((module) => ({ default: module.VisualSectionContent }))),
  chat: createPreparedSettingsComponent(() => import('./VisualSectionContent').then((module) => ({ default: module.ChatSectionContent }))),
  shortcuts: createPreparedSettingsComponent(() => import('./KeyboardShortcutsSettings').then((module) => ({ default: module.KeyboardShortcutsSettings }))),
  git: createPreparedSettingsComponent(() => import('./GitSettings').then((module) => ({ default: module.GitSettings }))),
  notifications: createPreparedSettingsComponent(() => import('./NotificationSettings').then((module) => ({ default: module.NotificationSettings }))),
  voice: createPreparedSettingsComponent(() => import('./VoiceSettings').then((module) => ({ default: module.VoiceSettings }))),
  tunnel: createPreparedSettingsComponent(() => import('./TunnelSettings').then((module) => ({ default: module.TunnelSettings }))),
};
