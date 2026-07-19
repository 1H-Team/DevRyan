import type { DevRyanDefaultPlugin, PluginEntry, PluginFile } from "@/lib/api/types";

export type PluginSidebarItem = {
  id: string;
  label: string;
  metadata: string;
  scope: "default" | "user" | "project";
  kind: "default" | "config" | "file";
  parsedKind?: "npm" | "path";
  version?: string | null;
  delivery?: "npm" | "bundled-file";
};

export type PluginSidebarGroup = {
  key: "devryan-defaults" | "project-entries" | "project-files" | "user-entries" | "user-files";
  scope: "default" | "user" | "project";
  kind: "default" | "config" | "file";
  items: PluginSidebarItem[];
};

const sortByLabel = (a: PluginSidebarItem, b: PluginSidebarItem) => a.label.localeCompare(b.label);

const defaultToItem = (plugin: DevRyanDefaultPlugin): PluginSidebarItem => ({
  id: plugin.id,
  label: plugin.displayName,
  metadata: plugin.version ?? plugin.delivery,
  scope: "default",
  kind: "default",
  version: plugin.version,
  delivery: plugin.delivery,
});

const entryToItem = (entry: PluginEntry): PluginSidebarItem => ({
  id: entry.id,
  label: entry.spec,
  metadata: entry.parsedKind,
  scope: entry.scope,
  kind: "config",
  parsedKind: entry.parsedKind,
});

const fileToItem = (file: PluginFile): PluginSidebarItem => ({
  id: file.id,
  label: file.fileName,
  metadata: "file",
  scope: file.scope,
  kind: "file",
});

export function groupPluginsForSidebar(input: { defaults: DevRyanDefaultPlugin[]; entries: PluginEntry[]; files: PluginFile[] }): PluginSidebarGroup[] {
  const groups: PluginSidebarGroup[] = [
    {
      key: "devryan-defaults",
      scope: "default",
      kind: "default",
      items: input.defaults.map(defaultToItem),
    },
    {
      key: "project-entries",
      scope: "project",
      kind: "config",
      items: input.entries.filter((entry) => entry.scope === "project" && !entry.defaultPluginId).map(entryToItem).sort(sortByLabel),
    },
    {
      key: "project-files",
      scope: "project",
      kind: "file",
      items: input.files.filter((file) => file.scope === "project" && !file.defaultPluginId).map(fileToItem).sort(sortByLabel),
    },
    {
      key: "user-entries",
      scope: "user",
      kind: "config",
      items: input.entries.filter((entry) => entry.scope === "user" && !entry.defaultPluginId).map(entryToItem).sort(sortByLabel),
    },
    {
      key: "user-files",
      scope: "user",
      kind: "file",
      items: input.files.filter((file) => file.scope === "user" && !file.defaultPluginId).map(fileToItem).sort(sortByLabel),
    },
  ];

  return groups.filter((group) => group.items.length > 0);
}
