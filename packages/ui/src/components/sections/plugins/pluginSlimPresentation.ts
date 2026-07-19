import type { DevRyanDefaultPlugin, PluginEntry, PluginFile, SlimSetupStatus } from '@/lib/api/types';

const isSlimValue = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return normalized === 'oh-my-opencode-slim'
    || normalized.startsWith('oh-my-opencode-slim@')
    || normalized.includes('devryan-oh-my-opencode-slim.');
};

export const isSlimPlugin = (plugin: DevRyanDefaultPlugin | PluginEntry | PluginFile): boolean => {
  if (plugin.kind === 'default') return plugin.pluginId === 'oh-my-opencode-slim';
  return plugin.kind === 'config' ? isSlimValue(plugin.spec) : isSlimValue(plugin.fileName);
};

export const getSlimActions = (status: SlimSetupStatus | null): { install: boolean; repair: boolean } => {
  if (!status) return { install: true, repair: false };
  const hasExistingSetup = status.runtimeEnabled
    || status.wrapperConfigured
    || status.packageDependencyInstalled
    || Boolean(status.installedVersion);
  return hasExistingSetup
    ? { install: false, repair: true }
    : { install: true, repair: false };
};
