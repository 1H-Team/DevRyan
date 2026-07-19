export type DevRyanDefaultPluginId =
  | 'oh-my-opencode-slim'
  | 'opencode-with-claude'
  | 'openai-tool-schema-sanitizer';

export type DevRyanDefaultPlugin = {
  id: string;
  pluginId: DevRyanDefaultPluginId;
  displayName: string;
  shippedSpec: string;
  effectiveSpec: string;
  version: string | null;
  delivery: 'npm' | 'bundled-file';
  sourcePath: string;
  configuredSourcePath?: string;
  kind: 'default';
};

export const DEVRYAN_DEFAULT_PLUGIN_IDS: Readonly<{
  SLIM: 'oh-my-opencode-slim';
  CLAUDE: 'opencode-with-claude';
  OPENAI_TOOL_SCHEMA_SANITIZER: 'openai-tool-schema-sanitizer';
}>;
export const DEVRYAN_DEFAULT_PLUGINS: ReadonlyArray<Omit<DevRyanDefaultPlugin, 'effectiveSpec' | 'kind' | 'configuredSourcePath'>>;
export const OPENAI_TOOL_SCHEMA_SANITIZER_FILE: string;
export const OPENAI_TOOL_SCHEMA_SANITIZER_SPEC: string;

export function getDevRyanDefaultPluginIdForSpec(spec: unknown): DevRyanDefaultPluginId | null;
export function getDevRyanDefaultPluginIdForFile(fileName: unknown): DevRyanDefaultPluginId | null;
export function buildDevRyanDefaultPluginInventory<
  TEntry extends { spec?: unknown; sourcePath?: unknown },
  TFile extends { fileName?: unknown; absolutePath?: unknown },
>(input?: { entries?: TEntry[]; files?: TFile[] }): {
  defaults: DevRyanDefaultPlugin[];
  entries: Array<TEntry & { defaultPluginId?: DevRyanDefaultPluginId }>;
  files: Array<TFile & { defaultPluginId?: DevRyanDefaultPluginId }>;
};
