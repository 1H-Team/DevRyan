import * as React from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import {
  SETTINGS_PERMISSION_SECTIONS,
  cycleSettingsPermissionOverride,
  normalizeSettingsPermissions,
  type SettingsPagePermission,
  type SettingsPermissionOverrides,
  type SettingsPermissions,
  type SettingsPermissionSlug,
} from '@/lib/settings/permissions';
import { cn } from '@/lib/utils';

const PermissionHeader: React.FC = () => (
  <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-center gap-2 border-b border-border/50 px-3 py-2">
    <span className="typography-micro font-medium uppercase tracking-wide text-muted-foreground">Section</span>
    <span className="typography-micro font-medium uppercase tracking-wide text-center text-muted-foreground">Read</span>
    <span className="typography-micro font-medium uppercase tracking-wide text-center text-muted-foreground">Edit</span>
  </div>
);

interface PermissionCellProps {
  checked: boolean;
  disabled?: boolean;
  indeterminate?: boolean;
  label: string;
  status?: string;
  onChange: () => void;
}

const PermissionCell: React.FC<PermissionCellProps> = ({
  checked,
  disabled,
  indeterminate,
  label,
  status,
  onChange,
}) => (
  <div className="flex min-w-0 flex-col items-center justify-center gap-0.5">
    <Checkbox
      checked={checked}
      indeterminate={indeterminate}
      disabled={disabled}
      onChange={onChange}
      ariaLabel={label}
      className="size-4"
      iconClassName="size-4"
    />
    {status ? <span className="max-w-full truncate typography-micro text-[0.625rem] text-muted-foreground">{status}</span> : null}
  </div>
);

interface SettingsPermissionMatrixProps {
  permissions: SettingsPermissions;
  disabled?: boolean;
  onChange: (permissions: SettingsPermissions) => void;
}

export const SettingsPermissionMatrix: React.FC<SettingsPermissionMatrixProps> = ({
  permissions,
  disabled = false,
  onChange,
}) => {
  const safePermissions = React.useMemo(
    () => normalizeSettingsPermissions(permissions),
    [permissions],
  );

  const updatePermission = (slug: SettingsPermissionSlug, key: keyof SettingsPagePermission, value: boolean) => {
    const current = safePermissions[slug];
    const next = key === 'read'
      ? { read: value, edit: value ? current.edit : false }
      : { read: value ? true : current.read, edit: value };
    onChange({ ...safePermissions, [slug]: next });
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-[var(--surface-elevated)]">
      <PermissionHeader />
      {SETTINGS_PERMISSION_SECTIONS.map((section, sectionIndex) => (
        <section key={section.id} className={cn(sectionIndex > 0 && 'border-t border-border/60')}>
          <div className="bg-[var(--surface-subtle)]/55 px-3 py-1.5 typography-micro font-semibold uppercase tracking-wide text-muted-foreground">
            {section.label}
          </div>
          {section.pages.map(([slug, label], pageIndex) => {
            const permission = safePermissions[slug];
            return (
              <div
                key={slug}
                className={cn(
                  'grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-center gap-2 px-3 py-2',
                  pageIndex > 0 && 'border-t border-border/35',
                )}
              >
                <span className="min-w-0 truncate typography-ui-label text-foreground">{label}</span>
                <PermissionCell
                  checked={permission.read}
                  disabled={disabled}
                  label={`Read ${label} settings`}
                  onChange={() => updatePermission(slug, 'read', !permission.read)}
                />
                <PermissionCell
                  checked={permission.edit}
                  disabled={disabled}
                  label={`Edit ${label} settings`}
                  onChange={() => updatePermission(slug, 'edit', !permission.edit)}
                />
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
};

interface SettingsPermissionOverrideMatrixProps {
  overrides: SettingsPermissionOverrides;
  effective: SettingsPermissions;
  inherited: SettingsPermissions;
  disabled?: boolean;
  onChange: (overrides: SettingsPermissionOverrides) => void;
}

export const SettingsPermissionOverrideMatrix: React.FC<SettingsPermissionOverrideMatrixProps> = ({
  overrides,
  effective,
  inherited,
  disabled = false,
  onChange,
}) => {
  const safeEffective = React.useMemo(
    () => normalizeSettingsPermissions(effective),
    [effective],
  );
  const safeInherited = React.useMemo(
    () => normalizeSettingsPermissions(inherited),
    [inherited],
  );

  const updateOverride = (slug: SettingsPermissionSlug, key: keyof SettingsPagePermission) => {
    const rawCurrent = overrides?.[slug];
    const current = rawCurrent && typeof rawCurrent === 'object' && !Array.isArray(rawCurrent)
      ? rawCurrent
      : {};
    const nextValue = cycleSettingsPermissionOverride(current[key]);
    const next = { ...current, [key]: nextValue };
    if (nextValue === undefined) delete next[key];

    if (key === 'read' && nextValue === false) next.edit = false;
    if (key === 'edit' && nextValue === true && safeEffective[slug].read === false) next.read = true;

    const nextOverrides = { ...overrides };
    if (Object.keys(next).length === 0) delete nextOverrides[slug];
    else nextOverrides[slug] = next;
    onChange(nextOverrides);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-[var(--surface-elevated)]">
      <PermissionHeader />
      {SETTINGS_PERMISSION_SECTIONS.map((section, sectionIndex) => (
        <section key={section.id} className={cn(sectionIndex > 0 && 'border-t border-border/60')}>
          <div className="bg-[var(--surface-subtle)]/55 px-3 py-1.5 typography-micro font-semibold uppercase tracking-wide text-muted-foreground">
            {section.label}
          </div>
          {section.pages.map(([slug, label], pageIndex) => {
            const rawPermission = overrides?.[slug];
            const permission = rawPermission && typeof rawPermission === 'object' && !Array.isArray(rawPermission)
              ? rawPermission
              : {};
            const readInherited = permission.read === undefined;
            const editInherited = permission.edit === undefined;
            return (
              <div
                key={slug}
                className={cn(
                  'grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-center gap-2 px-3 py-2',
                  pageIndex > 0 && 'border-t border-border/35',
                )}
              >
                <span className="min-w-0 truncate typography-ui-label text-foreground">{label}</span>
                <PermissionCell
                  checked={permission.read === true}
                  indeterminate={readInherited}
                  disabled={disabled}
                  label={`${label} read override: ${readInherited ? `Inherit (${safeInherited[slug].read ? 'On' : 'Off'})` : permission.read ? 'On' : 'Off'}`}
                  status={readInherited ? `Inherit (${safeInherited[slug].read ? 'On' : 'Off'})` : permission.read ? 'On' : 'Off'}
                  onChange={() => updateOverride(slug, 'read')}
                />
                <PermissionCell
                  checked={permission.edit === true}
                  indeterminate={editInherited}
                  disabled={disabled}
                  label={`${label} edit override: ${editInherited ? `Inherit (${safeInherited[slug].edit ? 'On' : 'Off'})` : permission.edit ? 'On' : 'Off'}`}
                  status={editInherited ? `Inherit (${safeInherited[slug].edit ? 'On' : 'Off'})` : permission.edit ? 'On' : 'Off'}
                  onChange={() => updateOverride(slug, 'edit')}
                />
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
};
