import * as React from 'react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import {
  fullSettingsPermissions,
  permissionsFromLegacyPages,
  type SettingsPermissions,
} from '@/lib/settings/permissions';
import { cn } from '@/lib/utils';
import { SettingsPermissionMatrix } from './SettingsPermissionMatrix';
import { requestJson, roleLabel, type Role, type RolePolicyRow } from './types';

const permissionsForRole = (row: RolePolicyRow): SettingsPermissions => {
  if (row.role === 'admin') return fullSettingsPermissions();
  return row.settings_permissions || permissionsFromLegacyPages(row.settings_pages);
};

const RolePolicyEditor: React.FC<{
  row: RolePolicyRow;
  onSaved: () => Promise<void> | void;
}> = ({ row, onSaved }) => {
  const [draft, setDraft] = React.useState(row);
  const [permissions, setPermissions] = React.useState(() => permissionsForRole(row));
  const [saving, setSaving] = React.useState(false);
  const locked = row.role === 'admin';

  React.useEffect(() => {
    setDraft(row);
    setPermissions(permissionsForRole(row));
  }, [row]);

  const toggle = (key: keyof RolePolicyRow, value: boolean) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    if (locked) return;
    setSaving(true);
    try {
      await requestJson(`/api/admin/roles/${encodeURIComponent(row.role)}`, {
        method: 'PUT',
        body: JSON.stringify({
          settingsPermissions: permissions,
          files: draft.can_use_files,
          terminal: draft.can_use_terminal,
          manageProjects: draft.can_manage_projects,
          manageUsers: draft.can_manage_users,
          manageGlobalSettings: draft.can_manage_global_settings,
          manageGit: draft.can_manage_git,
          push: draft.can_push,
          github: draft.can_use_github,
        }),
      });
      await onSaved();
      toast.success(`${roleLabel(row.role)} policy saved`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save role policy');
    } finally {
      setSaving(false);
    }
  };

  const capabilityRows: Array<[keyof RolePolicyRow, string]> = [
    ['can_use_files', 'Files'], ['can_use_terminal', 'Terminal'], ['can_manage_git', 'Git'],
    ['can_push', 'Push'], ['can_use_github', 'GitHub'], ['can_manage_projects', 'Manage Projects'],
    ['can_manage_users', 'Manage Users'], ['can_manage_global_settings', 'Host Settings'],
  ];

  return (
    <div className="space-y-4">
      {locked ? (
        <div className="rounded-lg border border-border/60 bg-[var(--surface-subtle)]/35 px-3 py-2 typography-meta text-muted-foreground">
          Administrator access is fixed at full Read and Edit to prevent account lockout.
        </div>
      ) : null}

      <SettingsPermissionMatrix
        permissions={permissions}
        disabled={locked || saving}
        onChange={setPermissions}
      />

      <div className="space-y-2">
        <div>
          <div className="typography-ui-label font-medium text-foreground">Core capabilities</div>
          <p className="typography-micro text-muted-foreground">
            These permissions apply outside Settings, including files, terminals, and repository operations.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {capabilityRows.map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 typography-meta text-foreground">
              <Checkbox
                checked={locked || draft[key] === true}
                onChange={(value) => toggle(key, value)}
                disabled={locked || saving}
                ariaLabel={`${label} for ${row.role}`}
                className="size-4"
                iconClassName="size-4"
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      {!locked ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save Role Policy'}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

interface RolePoliciesSectionProps {
  roles: RolePolicyRow[];
  onSaved: () => Promise<void> | void;
}

export const RolePoliciesSection: React.FC<RolePoliciesSectionProps> = ({ roles, onSaved }) => {
  const [selectedRole, setSelectedRole] = React.useState<Role>('senior_developer');
  const selected = roles.find((role) => role.role === selectedRole) || roles[0];

  React.useEffect(() => {
    if (selected || roles.length === 0) return;
    setSelectedRole(roles[0].role);
  }, [roles, selected]);

  return (
    <SettingsSection
      title="Role Policies"
      description="Choose which Settings sections each role can read or edit. Core capabilities remain independently enforced."
      divider
    >
      <div className="space-y-4">
        <div className="inline-flex max-w-full overflow-x-auto rounded-lg border border-border/60 bg-[var(--surface-subtle)]/35 p-1">
          {roles.map((role) => {
            const active = role.role === selected?.role;
            return (
              <button
                key={role.role}
                type="button"
                onClick={() => setSelectedRole(role.role)}
                className={cn(
                  'whitespace-nowrap rounded-md px-3 py-1.5 typography-meta font-medium transition-colors',
                  active
                    ? 'bg-[var(--surface-elevated)] text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                aria-pressed={active}
              >
                <span className="capitalize">{roleLabel(role.role)}</span>
              </button>
            );
          })}
        </div>
        {selected ? <RolePolicyEditor key={selected.role} row={selected} onSaved={onSaved} /> : null}
      </div>
    </SettingsSection>
  );
};
