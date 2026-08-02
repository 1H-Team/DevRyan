import React from "react";
import { RiCodeBoxLine, RiDownloadCloud2Line, RiFileTextLine, RiFolderLine, RiRefreshLine } from "@remixicon/react";
import { SettingsPageLayout } from "@/components/sections/shared/SettingsPageLayout";
import { SettingsSection } from "@/components/sections/shared/SettingsSection";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { usePluginsStore } from "@/stores/usePluginsStore";
import type { DevRyanDefaultPlugin, PluginEntry, PluginFile } from "@/lib/api/types";
import { getSlimActions, isSlimPlugin } from "./pluginSlimPresentation";

const formatOptions = (options: Record<string, unknown> | undefined): string => {
  if (!options || Object.keys(options).length === 0) {
    return "{}";
  }
  return JSON.stringify(options, null, 2);
};

const getDefaultPluginDeliveryLabel = (
  delivery: DevRyanDefaultPlugin["delivery"],
  t: ReturnType<typeof useI18n>["t"],
): string => {
  if (delivery === "installed-local") {
    return t("settings.plugins.default.value.installedLocal");
  }
  if (delivery === "curated-skills") {
    return t("settings.plugins.default.value.curatedSkills");
  }
  return t("settings.plugins.default.value.bundledFile");
};

const DetailRow: React.FC<{ label: string; value: React.ReactNode; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="grid gap-1 border-b border-border/70 py-3 last:border-b-0 sm:grid-cols-[150px_minmax(0,1fr)]">
    <div className="typography-meta text-muted-foreground">{label}</div>
    <div className={cn("typography-ui min-w-0 break-words text-foreground", mono && "font-mono typography-meta")}>{value}</div>
  </div>
);

const ScopeBadge: React.FC<{ scope: "user" | "project"; label: string }> = ({ scope, label }) => (
  <span
    className="typography-micro rounded-full border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2 py-0.5 font-medium text-muted-foreground"
    data-scope={scope}
  >
    {label}
  </span>
);

const DefaultBadge: React.FC = () => {
  const { t } = useI18n();
  return (
    <span
      className="typography-micro rounded-full border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2 py-0.5 font-medium text-foreground"
      data-scope="default"
    >
      {t("settings.plugins.default.badge")}
    </span>
  );
};

const SlimStatusPanel: React.FC = () => {
  const { t } = useI18n();
  const status = usePluginsStore((state) => state.slimStatus);
  const isLoading = usePluginsStore((state) => state.slimStatusLoading);
  const actionInFlight = usePluginsStore((state) => state.slimActionInFlight);
  const lastError = usePluginsStore((state) => state.slimLastError);
  const installSlimRuntime = usePluginsStore((state) => state.installSlimRuntime);
  const repairSlimRuntime = usePluginsStore((state) => state.repairSlimRuntime);
  const busy = isLoading || actionInFlight !== null;
  const actions = getSlimActions(status);
  const stateLabel = status?.runtimeEnabled && status.wrapperConfigured
    ? t("settings.plugins.slim.status.ready")
    : t("settings.plugins.slim.status.needsSetup");
  const issueMessages = status?.issues?.map((issue) => issue.message).filter(Boolean) ?? [];

  return (
    <SettingsSection title={t("settings.plugins.slim.title")}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <DetailRow label={t("settings.plugins.slim.field.status")} value={isLoading ? t("settings.plugins.slim.status.loading") : stateLabel} />
          <DetailRow label={t("settings.plugins.slim.field.version")} value={status?.installedVersion ?? t("settings.plugins.slim.value.missing")} mono />
          <DetailRow label={t("settings.plugins.slim.field.wrapper")} value={status?.wrapperConfigured ? t("settings.plugins.slim.value.configured") : t("settings.plugins.slim.value.missing")} />
          <DetailRow label={t("settings.plugins.slim.field.background")} value={status?.backgroundSubagentsEnv ?? "true"} mono />
        </div>
        {status?.backupPaths && status.backupPaths.length > 0 ? (
          <div className="rounded-md border border-border bg-[var(--surface-elevated)] p-3">
            <div className="typography-meta text-muted-foreground">{t("settings.plugins.slim.field.backups")}</div>
            <div className="mt-1 space-y-1">
              {status.backupPaths.map((backupPath) => (
                <div key={backupPath} className="typography-meta break-all font-mono text-foreground">{backupPath}</div>
              ))}
            </div>
          </div>
        ) : null}
        {issueMessages.length > 0 || lastError ? (
          <div className="rounded-md border border-[color-mix(in_srgb,var(--status-warning)_35%,var(--border))] bg-[color-mix(in_srgb,var(--status-warning)_8%,var(--background))] p-3 text-[var(--status-warning)]">
            {lastError ? <div className="typography-meta">{lastError}</div> : null}
            {issueMessages.map((message) => (
              <div key={message} className="typography-meta">{message}</div>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {actions.install ? <Button
            type="button"
            size="sm"
            onClick={() => { void installSlimRuntime(); }}
            disabled={busy}
          >
            <RiDownloadCloud2Line className="h-4 w-4" />
            {actionInFlight === "install" ? t("settings.plugins.slim.action.installing") : t("settings.plugins.slim.action.install")}
          </Button> : null}
          {actions.repair ? <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => { void repairSlimRuntime(); }}
            disabled={busy}
          >
            <RiRefreshLine className="h-4 w-4" />
            {actionInFlight === "repair" ? t("settings.plugins.slim.action.repairing") : t("settings.plugins.slim.action.repair")}
          </Button> : null}
        </div>
      </div>
    </SettingsSection>
  );
};

const EntryDetails: React.FC<{ entry: PluginEntry }> = ({ entry }) => {
  const { t } = useI18n();
  const Icon = entry.parsedKind === "path" ? RiFolderLine : RiCodeBoxLine;

  return (
    <>
      <div className="flex items-center gap-3">
        <Icon className="h-5 w-5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="typography-ui-header truncate font-semibold text-foreground">{entry.spec}</h2>
            <ScopeBadge
              scope={entry.scope}
              label={entry.scope === "project" ? t("settings.plugins.scope.project") : t("settings.plugins.scope.user")}
            />
          </div>
          <p className="typography-meta text-muted-foreground">{t("settings.plugins.page.readOnly")}</p>
        </div>
      </div>

      <SettingsSection title={t("settings.plugins.page.section.config")}>
        <DetailRow label={t("settings.plugins.page.field.spec")} value={entry.spec} mono />
        <DetailRow
          label={t("settings.plugins.page.field.kind")}
          value={entry.parsedKind === "path" ? t("settings.plugins.sidebar.kind.path") : t("settings.plugins.sidebar.kind.npm")}
        />
        <DetailRow
          label={t("settings.plugins.page.field.scope")}
          value={entry.scope === "project" ? t("settings.plugins.scope.project") : t("settings.plugins.scope.user")}
        />
        <DetailRow label={t("settings.plugins.page.field.sourcePath")} value={entry.sourcePath} mono />
      </SettingsSection>

      <SettingsSection title={t("settings.plugins.page.section.options")}>
        <pre className="typography-meta max-h-[360px] overflow-auto rounded-md border border-border bg-[var(--surface-elevated)] p-3 font-mono text-foreground">
          {formatOptions(entry.options)}
        </pre>
      </SettingsSection>
    </>
  );
};

const FileDetails: React.FC<{ file: PluginFile }> = ({ file }) => {
  const { t } = useI18n();

  return (
    <>
      <div className="flex items-center gap-3">
        <RiFileTextLine className="h-5 w-5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="typography-ui-header truncate font-semibold text-foreground">{file.fileName}</h2>
            <ScopeBadge
              scope={file.scope}
              label={file.scope === "project" ? t("settings.plugins.scope.project") : t("settings.plugins.scope.user")}
            />
          </div>
          <p className="typography-meta text-muted-foreground">{t("settings.plugins.page.fileReadOnly")}</p>
        </div>
      </div>

      <SettingsSection title={t("settings.plugins.page.section.file")}>
        <DetailRow label={t("settings.plugins.page.field.fileName")} value={file.fileName} mono />
        <DetailRow
          label={t("settings.plugins.page.field.scope")}
          value={file.scope === "project" ? t("settings.plugins.scope.project") : t("settings.plugins.scope.user")}
        />
        <DetailRow label={t("settings.plugins.page.field.absolutePath")} value={file.absolutePath} mono />
      </SettingsSection>
    </>
  );
};

const DefaultDetails: React.FC<{ plugin: DevRyanDefaultPlugin }> = ({ plugin }) => {
  const { t } = useI18n();
  const effectiveDiffers = plugin.effectiveSpec !== plugin.shippedSpec;

  return (
    <>
      <div className="flex items-center gap-3">
        <RiCodeBoxLine className="h-5 w-5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="typography-ui-header truncate font-semibold text-foreground">{plugin.displayName}</h2>
            <DefaultBadge />
          </div>
          <p className="typography-meta text-muted-foreground">{t("settings.plugins.default.readOnly")}</p>
        </div>
      </div>

      <SettingsSection title={t("settings.plugins.default.section.package")}>
        <DetailRow label={t("settings.plugins.default.field.shippedSpec")} value={plugin.shippedSpec} mono />
        {effectiveDiffers ? (
          <DetailRow label={t("settings.plugins.default.field.effectiveSpec")} value={plugin.effectiveSpec} mono />
        ) : null}
        <DetailRow
          label={t("settings.plugins.default.field.version")}
          value={plugin.version ?? t("settings.plugins.default.value.bundled")}
          mono={plugin.version !== null}
        />
        <DetailRow
          label={t("settings.plugins.default.field.delivery")}
          value={getDefaultPluginDeliveryLabel(plugin.delivery, t)}
        />
        <DetailRow
          label={t("settings.plugins.default.field.source")}
          value={plugin.configuredSourcePath ?? plugin.sourcePath}
          mono
        />
      </SettingsSection>
    </>
  );
};

export const PluginsPage: React.FC = () => {
  const { t } = useI18n();
  const selectedId = usePluginsStore((state) => state.selectedId);
  const getById = usePluginsStore((state) => state.getById);
  const selected = selectedId ? getById(selectedId) : undefined;

  if (!selected) {
    return (
      <SettingsPageLayout>
        <SlimStatusPanel />
        <div className="flex min-h-[280px] items-center justify-center px-6">
          <div className="max-w-sm text-center text-muted-foreground">
            <RiCodeBoxLine className="mx-auto mb-3 h-12 w-12 opacity-50" />
            <p className="typography-body">{t("settings.plugins.page.empty.select")}</p>
            <p className="typography-meta mt-1 opacity-75">{t("settings.plugins.page.empty.description")}</p>
          </div>
        </div>
      </SettingsPageLayout>
    );
  }

  return (
    <SettingsPageLayout>
      {isSlimPlugin(selected) ? <SlimStatusPanel /> : null}
      {selected.kind === "default"
        ? <DefaultDetails plugin={selected} />
        : selected.kind === "config"
        ? <EntryDetails entry={selected} />
        : <FileDetails file={selected} />}
    </SettingsPageLayout>
  );
};
