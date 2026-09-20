import React from 'react';

import { getAuthPrincipal, useAuthPrincipal } from '@/lib/authSession';
import { canPrepareSettingsSection, usesManagedSettings } from './SettingsView.access';
import { createPreparedSettingsComponent } from './preparedSettingsComponent';
import type { SettingsDataBoundaryProps } from './SettingsDataBoundary';
import { OpenChamberPage } from '@/components/sections/openchamber/OpenChamberPage';
import { openChamberSectionResources } from '@/components/sections/openchamber/openChamberSectionResources';

export { createPreparedSettingsComponent } from './preparedSettingsComponent';
import type { SettingsPageSlug } from '@/lib/settings/metadata';

const agentsSidebar = createPreparedSettingsComponent(() =>
  import('@/components/sections/agents/AgentsSidebar').then((module) => ({ default: module.AgentsSidebar })));
const agentsPage = createPreparedSettingsComponent(() =>
  import('@/components/sections/agents/AgentsPage').then((module) => ({ default: module.AgentsPage })));
const behaviorPage = createPreparedSettingsComponent(() =>
  import('@/components/sections/behavior/BehaviorPage').then((module) => ({ default: module.BehaviorPage })));
const commandsSidebar = createPreparedSettingsComponent(() =>
  import('@/components/sections/commands/CommandsSidebar').then((module) => ({ default: module.CommandsSidebar })));
const commandsPage = createPreparedSettingsComponent(() =>
  import('@/components/sections/commands/CommandsPage').then((module) => ({ default: module.CommandsPage })));
const mcpSidebar = createPreparedSettingsComponent(() =>
  import('@/components/sections/mcp/McpSidebar').then((module) => ({ default: module.McpSidebar })));
const mcpPage = createPreparedSettingsComponent(() =>
  import('@/components/sections/mcp/McpPage').then((module) => ({ default: module.McpPage })));
const skillsSidebar = createPreparedSettingsComponent(() =>
  import('@/components/sections/skills/SkillsSidebar').then((module) => ({ default: module.SkillsSidebar })));
const skillsPage = createPreparedSettingsComponent(() =>
  import('@/components/sections/skills/SkillsPage').then((module) => ({ default: module.SkillsPage })));
const pluginsSidebar = createPreparedSettingsComponent(() =>
  import('@/components/sections/plugins/PluginsSidebar').then((module) => ({ default: module.PluginsSidebar })));
const pluginsPage = createPreparedSettingsComponent(() =>
  import('@/components/sections/plugins/PluginsPage').then((module) => ({ default: module.PluginsPage })));
const projectsSidebar = createPreparedSettingsComponent(() =>
  import('@/components/sections/projects/ProjectsSidebar').then((module) => ({ default: module.ProjectsSidebar })));
const projectsPage = createPreparedSettingsComponent(() =>
  import('@/components/sections/projects/ProjectsPage').then((module) => ({ default: module.ProjectsPage })));
const remoteInstancesSidebar = createPreparedSettingsComponent(() =>
  import('@/components/sections/remote-instances/RemoteInstancesSidebar').then((module) => ({ default: module.RemoteInstancesSidebar })));
const remoteInstancesPage = createPreparedSettingsComponent(() =>
  import('@/components/sections/remote-instances/RemoteInstancesPage').then((module) => ({ default: module.RemoteInstancesPage })));
const providersSidebar = createPreparedSettingsComponent(() =>
  import('@/components/sections/providers/ProvidersSidebar').then((module) => ({ default: module.ProvidersSidebar })));
const providersPage = createPreparedSettingsComponent(() =>
  import('@/components/sections/providers/ProvidersPage').then((module) => ({ default: module.ProvidersPage })));
const usageSidebar = createPreparedSettingsComponent(() =>
  import('@/components/sections/usage/UsageSidebar').then((module) => ({ default: module.UsageSidebar })));
const usagePage = createPreparedSettingsComponent(() =>
  import('@/components/sections/usage/UsagePage').then((module) => ({ default: module.UsagePage })));
const magicPromptsSidebar = createPreparedSettingsComponent(() =>
  import('@/components/sections/magic-prompts/MagicPromptsSidebar').then((module) => ({ default: module.MagicPromptsSidebar })));
const magicPromptsPage = createPreparedSettingsComponent(() =>
  import('@/components/sections/magic-prompts/MagicPromptsPage').then((module) => ({ default: module.MagicPromptsPage })));
const gitPage = createPreparedSettingsComponent(() =>
  import('@/components/sections/git-identities/GitPage').then((module) => ({ default: module.GitPage })));
const aboutSettings = createPreparedSettingsComponent(() =>
  import('@/components/sections/openchamber/AboutSettings').then((module) => ({ default: module.AboutSettings })));
const userManagementPage = createPreparedSettingsComponent(() =>
  import('@/components/sections/users/UserManagementPage').then((module) => ({ default: module.UserManagementPage })));
const bugReportsPage = createPreparedSettingsComponent(() =>
  import('@/components/sections/bug-reports/BugReportsPage').then((module) => ({ default: module.BugReportsPage })));
const botsPage = createPreparedSettingsComponent(() =>
  import('@/components/sections/bots/BotsPage').then((module) => ({ default: module.BotsPage })));

export const PreparedAgentsSidebar = agentsSidebar.Component;
export const PreparedAgentsPage = agentsPage.Component;
export const PreparedBehaviorPage = behaviorPage.Component;
export const PreparedCommandsSidebar = commandsSidebar.Component;
export const PreparedCommandsPage = commandsPage.Component;
export const PreparedMcpSidebar = mcpSidebar.Component;
export const PreparedMcpPage = mcpPage.Component;
export const PreparedSkillsSidebar = skillsSidebar.Component;
export const PreparedSkillsPage = skillsPage.Component;
export const PreparedPluginsSidebar = pluginsSidebar.Component;
export const PreparedPluginsPage = pluginsPage.Component;
export const PreparedProjectsSidebar = projectsSidebar.Component;
export const PreparedProjectsPage = projectsPage.Component;
export const PreparedRemoteInstancesSidebar = remoteInstancesSidebar.Component;
export const PreparedRemoteInstancesPage = remoteInstancesPage.Component;
export const PreparedProvidersSidebar = providersSidebar.Component;
export const PreparedProvidersPage = providersPage.Component;
export const PreparedUsageSidebar = usageSidebar.Component;
export const PreparedUsagePage = usagePage.Component;
export const PreparedMagicPromptsSidebar = magicPromptsSidebar.Component;
export const PreparedMagicPromptsPage = magicPromptsPage.Component;
export const PreparedGitPage = gitPage.Component;
export const PreparedOpenChamberPage = OpenChamberPage;
export const PreparedAboutSettings = aboutSettings.Component;
export const PreparedUserManagementPage = userManagementPage.Component;
export const PreparedBugReportsPage = bugReportsPage.Component;
export const PreparedBotsPage = botsPage.Component;

type SettingsSectionResource = { isReady: () => boolean; load: () => Promise<unknown> };

const settingsData = createPreparedSettingsComponent<SettingsDataBoundaryProps>(() =>
  import('./SettingsDataBoundary').then((module) => ({ default: module.SettingsDataBoundary })));
const managedSettingsData = createPreparedSettingsComponent<SettingsDataBoundaryProps>(() =>
  import('./ManagedSettingsDataBoundary').then((module) => ({ default: module.ManagedSettingsDataBoundary })));
const getDataResource = (slug: SettingsPageSlug, managed = usesManagedSettings(getAuthPrincipal())) => {
  if (managed) return slug === 'skills.installed' || slug === 'plugins' ? managedSettingsData : null;
  return ['agents', 'commands', 'mcp', 'skills.installed', 'skills.catalog', 'plugins'].includes(slug) ? settingsData : null;
};

export const PreparedSettingsDataBoundary: React.FC<SettingsDataBoundaryProps> = (props) => {
  const principal = useAuthPrincipal();
  if (!canPrepareSettingsSection(principal, props.slug)) return null;
  const resource = getDataResource(props.slug, usesManagedSettings(principal));
  if (!resource) return props.children;
  const Component = resource.Component;
  return React.createElement(Component, props);
};

const pageResources: Partial<Record<SettingsPageSlug, readonly SettingsSectionResource[]>> = {
  users: [userManagementPage],
  'bug-reports': [bugReportsPage],
  projects: [projectsSidebar, projectsPage],
  'remote-instances': [remoteInstancesSidebar, remoteInstancesPage],
  agents: [agentsSidebar, agentsPage],
  behavior: [behaviorPage],
  commands: [commandsSidebar, commandsPage],
  mcp: [mcpSidebar, mcpPage],
  'skills.installed': [skillsSidebar, skillsPage],
  'skills.catalog': [skillsPage],
  plugins: [pluginsSidebar, pluginsPage],
  providers: [providersSidebar, providersPage],
  usage: [usageSidebar, usagePage],
  bots: [botsPage],
  'magic-prompts': [magicPromptsSidebar, magicPromptsPage],
  git: [gitPage],
  about: [aboutSettings],
  appearance: [openChamberSectionResources.visual],
  chat: [openChamberSectionResources.chat],
  shortcuts: [openChamberSectionResources.shortcuts],
  sessions: [openChamberSectionResources.sessions],
  notifications: [openChamberSectionResources.notifications],
  voice: [openChamberSectionResources.voice],
  tunnel: [openChamberSectionResources.tunnel],
};

const sectionPreloads = new Map<string, Promise<void>>();
const intentPreloads = new Set<Promise<void>>();
const resourcesFor = (slug: SettingsPageSlug): readonly SettingsSectionResource[] => {
  const data = getDataResource(slug);
  return [...(data ? [data] : []), ...(pageResources[slug] ?? [])];
};

export function isSettingsSectionReady(slug: SettingsPageSlug): boolean {
  return resourcesFor(slug).every((resource) => resource.isReady());
}

export function preloadSettingsSection(slug: SettingsPageSlug, priority: 'intent' | 'idle' = 'intent'): Promise<void> {
  if (!canPrepareSettingsSection(getAuthPrincipal(), slug)) return Promise.resolve();
  const key = `${usesManagedSettings(getAuthPrincipal()) ? 'managed' : 'full'}:${slug}`;
  let preload = sectionPreloads.get(key);
  if (!preload) {
    // Start the data entrypoint, sidebar and page together, never as an import waterfall.
    preload = Promise.all(resourcesFor(slug).map((resource) => resource.load())).then(() => undefined).catch((error: unknown) => {
      sectionPreloads.delete(key);
      throw error;
    });
    sectionPreloads.set(key, preload);
  }
  if (priority === 'intent' && !intentPreloads.has(preload)) {
    intentPreloads.add(preload);
    const tracked = preload;
    void tracked.then(() => intentPreloads.delete(tracked), () => intentPreloads.delete(tracked));
  }
  return preload;
}

export function preloadSettingsSectionsWhenIdle(slugs: readonly SettingsPageSlug[]): () => void {
  if (typeof window === 'undefined') return () => {};
  const principal = getAuthPrincipal();
  const queue = [...new Set(slugs)].filter((slug) => !isSettingsSectionReady(slug));
  let cancelled = false;
  let idleId: number | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (cancelled || principal !== getAuthPrincipal() || queue.length === 0) return;
    const run = () => {
      idleId = null;
      timeoutId = null;
      if (cancelled || principal !== getAuthPrincipal()) return;
      if (intentPreloads.size > 0) {
        // Wait for explicit navigation rather than compete with its imports.
        void Promise.allSettled([...intentPreloads]).then(schedule);
        return;
      }
      const slug = queue.shift();
      if (!slug) return;
      void preloadSettingsSection(slug, 'idle').catch(() => undefined).finally(schedule);
    };
    if (typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(run, { timeout: 1_500 });
    } else {
      timeoutId = setTimeout(run, 50);
    }
  };

  schedule();
  return () => {
    cancelled = true;
    if (idleId !== null && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idleId);
    if (timeoutId !== null) clearTimeout(timeoutId);
  };
}
