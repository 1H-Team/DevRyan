export type DevRyanManagedPluginId =
  | 'opencode-antigravity-auth'
  | '@rama_nigg/open-cursor'
  | 'opencode-with-claude'
  | 'opencode-gpt-imagegen'
  | 'context-mode'
  | 'oh-my-opencode-slim'
  | 'superpowers'
  | 'devryan-skill-context'
  | 'devryan-document-reader'
  | 'openai-tool-schema-sanitizer';

export type DevRyanManagedPluginDelivery = 'installed-local' | 'bundled-file' | 'curated-skills';

export type DevRyanManagedPlugin = {
  id: DevRyanManagedPluginId;
  displayName: string;
  packageName: string | null;
  version: string | null;
  entrypoint: string | null;
  registrationPath: string;
  legacySpecs: readonly string[];
  delivery: DevRyanManagedPluginDelivery;
  sourcePath: string;
  profileRegistration: boolean;
  public: boolean;
};

export type DevRyanManagedPluginInstallIssue = {
  pluginId: DevRyanManagedPluginId;
  kind: 'missing-package' | 'version-mismatch' | 'missing-entrypoint';
  path: string;
  expectedVersion: string;
  installedVersion: string | null;
};

export const DEVRYAN_MANAGED_PLUGIN_IDS: Readonly<Record<string, DevRyanManagedPluginId>>;
export const DEVRYAN_MANAGED_PLUGINS: readonly DevRyanManagedPlugin[];
export const DEVRYAN_MANAGED_PROFILE_PLUGINS: readonly DevRyanManagedPlugin[];
export const DEVRYAN_MANAGED_PROFILE_PLUGIN_SPECS: readonly string[];
export const DEVRYAN_MANAGED_PROFILE_DEPENDENCIES: Readonly<Record<string, string>>;
export const DEVRYAN_MANAGED_PROFILE_PLUGIN_FILES: readonly string[];
export const RETIRED_DEVRYAN_PLUGIN_SPECS: readonly string[];

export function getDevRyanManagedPlugin(pluginId: unknown): DevRyanManagedPlugin | null;
export function getDevRyanManagedPluginForSpec(value: unknown): DevRyanManagedPlugin | null;
export function getDevRyanManagedPluginForFile(fileName: unknown): DevRyanManagedPlugin | null;
export function isRetiredDevRyanPluginSpec(value: unknown): boolean;
export function isDevRyanManagedLegacyPluginSpec(value: unknown): boolean;
export function removeDevRyanManagedLegacyPluginSpecs(entries: unknown): unknown[];
export function reconcileDevRyanManagedPluginSpecs(
  currentEntries: unknown,
  baselineEntries?: unknown,
): unknown[];
export function getDevRyanManagedPluginRegistrationForConfigPath(
  pluginId: DevRyanManagedPluginId,
  options?: { configDirectory?: string; configPath?: string },
): string | null;
export function inspectDevRyanManagedPluginInstallation(options: {
  configDirectory: string;
  fs: {
    readFileSync(path: string, encoding: 'utf8'): string;
    existsSync(path: string): boolean;
  };
  path?: typeof import('node:path');
}): DevRyanManagedPluginInstallIssue[];
