import React from "react";
import { RiCodeBoxLine, RiDownloadCloud2Line, RiFileTextLine, RiFolderLine, RiPlugLine, RiRefreshLine } from "@remixicon/react";
import { SettingsBadge } from "@/components/sections/shared/SettingsBadge";
import { SettingsDetailHeader } from "@/components/sections/shared/SettingsDetailHeader";
import { SettingsDetailSection } from "@/components/sections/shared/SettingsDetailSection";
import { SettingsPageLayout } from "@/components/sections/shared/SettingsPageLayout";
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
  <SettingsBadge tone="neutral" data-scope={scope}>{label}</SettingsBadge>
);

const DefaultBadge: React.FC = () => {
  const { t } = useI18n();
  return (
    <SettingsBadge tone="accent" data-scope="default">
      {t("settings.plugins.default.badge")}
    </SettingsBadge>
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
  const isReady = Boolean(status?.runtimeEnabled && status.wrapperConfigured);
  const issueMessages = status?.issues?.map((issue) => issue.message).filter(Boolean) ?? [];

  const statusBadge = isLoading ? (
    <SettingsBadge tone="neutral">{t("settings.plugins.slim.status.loading")}</SettingsBadge>
  ) : (
    <SettingsBadge tone={isReady ? "success" : "warning"} dot>
      {isReady ? t("settings.plugins.slim.status.ready") : t("settings.plugins.slim.status.needsSetup")}
    </SettingsBadge>
  );

  return (
    <SettingsDetailSection
      title={t("settings.plugins.slim.title")}
      meta={statusBadge}
      actions={(
        <>
          {actions.install ? <Button
            type="button"
            size="xs"
            onClick={() => { void installSlimRuntime(); }}
            disabled={busy}
          >
            <RiDownloadCloud2Line className="h-3.5 w-3.5" />
            {actionInFlight === "install" ? t("settings.plugins.slim.action.installing") : t("settings.plugins.slim.action.install")}
          </Button> : null}
          {actions.repair ? <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => { void repairSlimRuntime(); }}
            disabled={busy}
          >
            <RiRefreshLine className="h-3.5 w-3.5" />
            {actionInFlight === "repair" ? t("settings.plugins.slim.action.repairing") : t("settings.plugins.slim.action.repair")}
          </Button> : null}
        </>
      )}
      variant="card"
    >
      <DetailRow label={t("settings.plugins.slim.field.version")} value={status?.installedVersion ?? t("settings.plugins.slim.value.missing")} mono />
      <DetailRow label={t("settings.plugins.slim.field.wrapper")} value={status?.wrapperConfigured ? t("settings.plugins.slim.value.configured") : t("settings.plugins.slim.value.missing")} />
      <DetailRow label={t("settings.plugins.slim.field.background")} value={status?.backgroundSubagentsEnv ?? "true"} mono />
      {status?.backupPaths && status.backupPaths.length > 0 ? (
        <DetailRow
          label={t("settings.plugins.slim.field.backups")}
          value={(
            <div className="space-y-1">
              {status.backupPaths.map((backupPath) => (
                <div key={backupPath} className="break-all">{backupPath}</div>
              ))}
            </div>
          )}
          mono
        />
      ) : null}
      {issueMessages.length > 0 || lastError ? (
        <div className="my-3 rounded-md border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3 text-[var(--status-warning)]">
          {lastError ? <div className="typography-meta">{lastError}</div> : null}
          {issueMessages.map((message) => (
            <div key={message} className="typography-meta">{message}</div>
          ))}
        </div>
      ) : null}
    </SettingsDetailSection>
  );
};

const EntryDetails: React.FC<{ entry: PluginEntry; children?: React.ReactNode }> = ({ entry, children }) => {
  const { t } = useI18n();
  const Icon = entry.parsedKind === "path" ? RiFolderLine : RiCodeBoxLine;
  const scopeLabel = entry.scope === "project" ? t("settings.plugins.scope.project") : t("settings.plugins.scope.user");

  return (
    <>
      <SettingsDetailHeader
        icon={<Icon />}
        title={entry.spec}
        titleTooltip={entry.spec}
        badges={<ScopeBadge scope={entry.scope} label={scopeLabel} />}
        subtitle={t("settings.plugins.page.readOnly")}
      />

      {children}

      <SettingsDetailSection title={t("settings.plugins.page.section.config")} variant="card">
        <DetailRow label={t("settings.plugins.page.field.spec")} value={entry.spec} mono />
        <DetailRow
          label={t("settings.plugins.page.field.kind")}
          value={entry.parsedKind === "path" ? t("settings.plugins.sidebar.kind.path") : t("settings.plugins.sidebar.kind.npm")}
        />
        <DetailRow label={t("settings.plugins.page.field.scope")} value={scopeLabel} />
        <DetailRow label={t("settings.plugins.page.field.sourcePath")} value={entry.sourcePath} mono />
      </SettingsDetailSection>

      <SettingsDetailSection title={t("settings.plugins.page.section.options")}>
        <pre className="typography-meta max-h-[360px] overflow-auto rounded-md border border-border bg-[var(--surface-elevated)] p-3 font-mono text-foreground">
          {formatOptions(entry.options)}
        </pre>
      </SettingsDetailSection>
    </>
  );
};

const FileDetails: React.FC<{ file: PluginFile; children?: React.ReactNode }> = ({ file, children }) => {
  const { t } = useI18n();
  const scopeLabel = file.scope === "project" ? t("settings.plugins.scope.project") : t("settings.plugins.scope.user");

  return (
    <>
      <SettingsDetailHeader
        icon={<RiFileTextLine />}
        title={file.fileName}
        titleTooltip={file.fileName}
        badges={<ScopeBadge scope={file.scope} label={scopeLabel} />}
        subtitle={t("settings.plugins.page.fileReadOnly")}
      />

      {children}

      <SettingsDetailSection title={t("settings.plugins.page.section.file")} variant="card">
        <DetailRow label={t("settings.plugins.page.field.fileName")} value={file.fileName} mono />
        <DetailRow label={t("settings.plugins.page.field.scope")} value={scopeLabel} />
        <DetailRow label={t("settings.plugins.page.field.absolutePath")} value={file.absolutePath} mono />
      </SettingsDetailSection>
    </>
  );
};

const DefaultDetails: React.FC<{ plugin: DevRyanDefaultPlugin; children?: React.ReactNode }> = ({ plugin, children }) => {
  const { t } = useI18n();
  const effectiveDiffers = plugin.effectiveSpec !== plugin.shippedSpec;

  return (
    <>
      <SettingsDetailHeader
        icon={<RiCodeBoxLine />}
        title={plugin.displayName}
        badges={<DefaultBadge />}
        subtitle={t("settings.plugins.default.readOnly")}
      />

      {children}

      <SettingsDetailSection title={t("settings.plugins.default.section.package")} variant="card">
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
      </SettingsDetailSection>
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
        <SettingsDetailHeader
          icon={<RiPlugLine />}
          title={t("settings.plugins.sidebar.title")}
          subtitle={t("settings.plugins.sidebar.description")}
        />
        <SlimStatusPanel />
        <p className="px-1 typography-meta text-muted-foreground">
          {t("settings.plugins.page.empty.select")}. {t("settings.plugins.page.empty.description")}
        </p>
      </SettingsPageLayout>
    );
  }

  const slimPanel = isSlimPlugin(selected) ? <SlimStatusPanel /> : null;

  return (
    <SettingsPageLayout>
      {selected.kind === "default"
        ? <DefaultDetails plugin={selected}>{slimPanel}</DefaultDetails>
        : selected.kind === "config"
        ? <EntryDetails entry={selected}>{slimPanel}</EntryDetails>
        : <FileDetails file={selected}>{slimPanel}</FileDetails>}
    </SettingsPageLayout>
  );
};
