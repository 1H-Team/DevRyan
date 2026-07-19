import React from "react";
import { RiCodeBoxLine, RiFileTextLine, RiFolderLine } from "@remixicon/react";
import { SettingsSidebarHeader } from "@/components/sections/shared/SettingsSidebarHeader";
import { SettingsSidebarItem } from "@/components/sections/shared/SettingsSidebarItem";
import { SettingsSidebarLayout } from "@/components/sections/shared/SettingsSidebarLayout";
import { useI18n } from "@/lib/i18n";
import { usePluginsStore } from "@/stores/usePluginsStore";
import { groupPluginsForSidebar, type PluginSidebarGroup } from "./pluginSidebarGrouping";

interface PluginsSidebarProps {
  onItemSelect?: () => void;
}

const groupLabelKey = (group: PluginSidebarGroup) => {
  switch (group.key) {
    case "project-entries":
      return "settings.plugins.sidebar.group.projectEntries";
    case "devryan-defaults":
      return "settings.plugins.sidebar.group.devryanDefaults";
    case "project-files":
      return "settings.plugins.sidebar.group.projectFiles";
    case "user-entries":
      return "settings.plugins.sidebar.group.userEntries";
    case "user-files":
      return "settings.plugins.sidebar.group.userFiles";
  }
};

export const PluginsSidebar: React.FC<PluginsSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const defaults = usePluginsStore((state) => state.defaults);
  const entries = usePluginsStore((state) => state.entries);
  const files = usePluginsStore((state) => state.files);
  const errors = usePluginsStore((state) => state.errors);
  const selectedId = usePluginsStore((state) => state.selectedId);
  const setSelected = usePluginsStore((state) => state.setSelected);
  const isLoading = usePluginsStore((state) => state.isLoading);
  const lastError = usePluginsStore((state) => state.lastError);

  const grouped = React.useMemo(() => groupPluginsForSidebar({ defaults, entries, files }), [defaults, entries, files]);
  const total = React.useMemo(() => grouped.reduce((count, group) => count + group.items.length, 0), [grouped]);

  return (
    <SettingsSidebarLayout
      header={(
        <div>
          <div className="border-b px-3 pt-4 pb-3">
            <h2 className="text-base font-semibold text-foreground">{t("settings.plugins.sidebar.title")}</h2>
            <p className="typography-meta mt-1 text-muted-foreground">{t("settings.plugins.sidebar.description")}</p>
          </div>
          <SettingsSidebarHeader
            count={total}
            label={t("settings.plugins.sidebar.total")}
          />
        </div>
      )}
    >
      {lastError ? (
        <div className="rounded-md border border-[var(--status-error-border)] bg-[var(--surface-elevated)] px-3 py-2">
          <p className="typography-ui-label text-[var(--status-error)]">{t("settings.plugins.sidebar.error.title")}</p>
          <p className="typography-micro text-muted-foreground">{lastError}</p>
        </div>
      ) : null}

      {errors.length > 0 ? (
        <div className="rounded-md border border-[var(--status-warning-border)] bg-[var(--surface-elevated)] px-3 py-2">
          <p className="typography-ui-label text-[var(--status-warning)]">{t("settings.plugins.sidebar.warning.title", { count: errors.length })}</p>
          <p className="typography-micro text-muted-foreground">{t("settings.plugins.sidebar.warning.description")}</p>
        </div>
      ) : null}

      {total === 0 && !isLoading ? (
        <div className="px-2 py-8 text-center text-muted-foreground">
          <RiFolderLine className="mx-auto mb-3 h-10 w-10 opacity-50" />
          <p className="typography-ui-label font-medium">{t("settings.plugins.sidebar.empty.title")}</p>
          <p className="typography-meta mt-1 opacity-75">{t("settings.plugins.sidebar.empty.description")}</p>
        </div>
      ) : null}

      {isLoading && total === 0 ? (
        <div className="px-2 py-4 text-muted-foreground">
          <span className="typography-ui">{t("settings.plugins.sidebar.loading")}</span>
        </div>
      ) : null}

      {grouped.map((group) => (
        <div key={group.key} className="space-y-1">
          <div className="typography-micro px-1 pt-2 text-muted-foreground">{t(groupLabelKey(group))}</div>
          {group.items.map((item) => {
            const Icon = item.kind === "file" ? RiFileTextLine : item.parsedKind === "path" ? RiFolderLine : RiCodeBoxLine;
            const metadata = item.kind === "default"
              ? item.version
                ? t("settings.plugins.sidebar.kind.includedVersion", { version: item.version })
                : t("settings.plugins.sidebar.kind.includedBundled")
              : item.kind === "file"
                ? t("settings.plugins.sidebar.kind.file")
                : item.parsedKind === "path"
                  ? t("settings.plugins.sidebar.kind.path")
                  : t("settings.plugins.sidebar.kind.npm");
            return (
              <SettingsSidebarItem
                key={item.id}
                title={item.label}
                metadata={metadata}
                selected={selectedId === item.id}
                onSelect={() => {
                  setSelected(item.id);
                  onItemSelect?.();
                }}
                icon={<Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground/70" />}
              />
            );
          })}
        </div>
      ))}
    </SettingsSidebarLayout>
  );
};
