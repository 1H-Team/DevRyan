import React from 'react';

import { importWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import type { SettingsPageSlug } from '@/lib/settings/metadata';

type SettingsComponentModule<Props extends object> = {
  default: React.ComponentType<Props>;
};

type PreparedSettingsComponent<Props extends object> = {
  Component: React.ComponentType<Props>;
  isReady: () => boolean;
  load: () => Promise<SettingsComponentModule<Props>>;
};

const SETTINGS_CHUNK_OPTIONS = { timeoutMs: 10_000 } as const;

export function createPreparedSettingsComponent<Props extends object>(
  importComponent: () => Promise<SettingsComponentModule<Props>>,
): PreparedSettingsComponent<Props> {
  let loadedModule: SettingsComponentModule<Props> | null = null;
  let inFlight: Promise<SettingsComponentModule<Props>> | null = null;
  let rejectedError: unknown;

  const load = (): Promise<SettingsComponentModule<Props>> => {
    if (loadedModule) return Promise.resolve(loadedModule);
    if (inFlight) return inFlight;

    rejectedError = undefined;
    const next = importWithChunkRecovery(importComponent, SETTINGS_CHUNK_OPTIONS).then(
      (module) => {
        loadedModule = module;
        return module;
      },
      (error: unknown) => {
        inFlight = null;
        rejectedError = error;
        throw error;
      },
    );
    inFlight = next;
    return next;
  };

  const Component: React.FC<Props> = (props) => {
    if (loadedModule) {
      return React.createElement(loadedModule.default, props);
    }
    if (rejectedError !== undefined) {
      const error = rejectedError;
      rejectedError = undefined;
      throw error;
    }
    throw load();
  };

  Component.displayName = 'PreparedSettingsComponent';
  return { Component, isReady: () => loadedModule !== null, load };
}

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
const openChamberPage = createPreparedSettingsComponent(() =>
  import('@/components/sections/openchamber/OpenChamberPage').then((module) => ({ default: module.OpenChamberPage })));
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
export const PreparedOpenChamberPage = openChamberPage.Component;
export const PreparedAboutSettings = aboutSettings.Component;
export const PreparedUserManagementPage = userManagementPage.Component;
export const PreparedBugReportsPage = bugReportsPage.Component;
export const PreparedBotsPage = botsPage.Component;

type SettingsSectionResource = Pick<PreparedSettingsComponent<object>, 'isReady' | 'load'>;

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
  appearance: [openChamberPage],
  chat: [openChamberPage],
  shortcuts: [openChamberPage],
  sessions: [openChamberPage],
  notifications: [openChamberPage],
  voice: [openChamberPage],
  tunnel: [openChamberPage],
};

const sectionPreloads = new Map<SettingsPageSlug, Promise<void>>();
export function isSettingsSectionReady(slug: SettingsPageSlug): boolean {
  const resources = pageResources[slug];
  return !resources || resources.length === 0 || resources.every((resource) => resource.isReady());
}

export function preloadSettingsSection(slug: SettingsPageSlug): Promise<void> {
  const existing = sectionPreloads.get(slug);
  if (existing) {
    return existing;
  }

  const resources = pageResources[slug];
  if (!resources || resources.length === 0) {
    return Promise.resolve();
  }

  const preload = Promise.all(resources.map((resource) => resource.load())).then(() => undefined);
  sectionPreloads.set(slug, preload);
  return preload.catch((error: unknown) => {
    sectionPreloads.delete(slug);
    throw error;
  });
}

export function preloadSettingsSectionsWhenIdle(slugs: readonly SettingsPageSlug[]): () => void {
  if (typeof window === 'undefined') return () => {};
  const queue = [...new Set(slugs)].filter((slug) => !isSettingsSectionReady(slug));
  let cancelled = false;
  let idleId: number | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (cancelled || queue.length === 0) return;
    const run = () => {
      idleId = null;
      timeoutId = null;
      const slug = queue.shift();
      if (!slug || cancelled) return;
      void preloadSettingsSection(slug)
        .catch(() => undefined)
        .finally(schedule);
    };
    if (typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(run, { timeout: 1_500 });
      return;
    }
    timeoutId = setTimeout(run, 50);
  };

  schedule();
  return () => {
    cancelled = true;
    if (idleId !== null && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleId);
    }
    if (timeoutId !== null) clearTimeout(timeoutId);
  };
}
