import React from "react";
import { RiCodeBoxLine, RiFileTextLine, RiFolderLine, RiPlugLine } from "@remixicon/react";
import { SettingsBadge } from "@/components/sections/shared/SettingsBadge";
import { SettingsDetailHeader } from "@/components/sections/shared/SettingsDetailHeader";
import { SettingsDetailSection } from "@/components/sections/shared/SettingsDetailSection";
import { SettingsPageLayout } from "@/components/sections/shared/SettingsPageLayout";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { usePluginsStore } from "@/stores/usePluginsStore";
import type { DevRyanDefaultPlugin, PluginEntry, PluginFile } from "@/lib/api/types";

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

const EntryDetails: React.FC<{ entry: PluginEntry }> = ({ entry }) => {
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

const FileDetails: React.FC<{ file: PluginFile }> = ({ file }) => {
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


      <SettingsDetailSection title={t("settings.plugins.page.section.file")} variant="card">
        <DetailRow label={t("settings.plugins.page.field.fileName")} value={file.fileName} mono />
        <DetailRow label={t("settings.plugins.page.field.scope")} value={scopeLabel} />
        <DetailRow label={t("settings.plugins.page.field.absolutePath")} value={file.absolutePath} mono />
      </SettingsDetailSection>
    </>
  );
};

const DefaultDetails: React.FC<{ plugin: DevRyanDefaultPlugin }> = ({ plugin }) => {
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
        <p className="px-1 typography-meta text-muted-foreground">
          {t("settings.plugins.page.empty.select")}. {t("settings.plugins.page.empty.description")}
        </p>
      </SettingsPageLayout>
    );
  }

  return (
    <SettingsPageLayout>
      {selected.kind === "default"
        ? <DefaultDetails plugin={selected} />
        : selected.kind === "config"
        ? <EntryDetails entry={selected} />
        : <FileDetails file={selected} />}
    </SettingsPageLayout>
  );
};
