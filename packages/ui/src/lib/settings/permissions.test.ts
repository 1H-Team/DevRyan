import { describe, expect, test } from 'bun:test';

import {
  SETTINGS_PERMISSION_SECTIONS,
  SETTINGS_PERMISSION_SLUGS,
  cycleSettingsPermissionOverride,
  fullSettingsPermissions,
  mergeSettingsPermissionOverrides,
  permissionsFromLegacyPages,
} from './permissions';

describe('settings permission catalog', () => {
  test('groups every policy-managed page exactly once', () => {
    const grouped = SETTINGS_PERMISSION_SECTIONS.flatMap((section) => section.pages.map(([slug]) => slug));

    expect(grouped).toEqual(SETTINGS_PERMISSION_SLUGS);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(SETTINGS_PERMISSION_SECTIONS.map((section) => section.label)).toEqual([
      'General', 'Workflow', 'Connections', 'Development',
    ]);
    expect(grouped).toContain('skills.catalog');
    expect(grouped).toContain('remote-instances');
    expect(grouped).toContain('bug-reports');
    expect(grouped).not.toContain('home');
  });

  test('creates conservative legacy permissions', () => {
    const permissions = permissionsFromLegacyPages(['appearance', 'users']);

    expect(permissions.appearance).toEqual({ read: true, edit: true });
    expect(permissions.users).toEqual({ read: true, edit: false });
    expect(permissions.providers).toEqual({ read: false, edit: false });

    const personal = permissionsFromLegacyPages(['voice', 'usage', 'bug-reports']);
    expect(personal.voice).toEqual({ read: true, edit: true });
    expect(personal.usage).toEqual({ read: true, edit: true });
    expect(personal['bug-reports']).toEqual({ read: true, edit: true });
  });

  test('merges sparse overrides and never enables edit without read', () => {
    const inherited = fullSettingsPermissions();
    const merged = mergeSettingsPermissionOverrides(inherited, {
      appearance: { read: false },
      providers: { edit: false },
    });

    expect(merged.appearance).toEqual({ read: false, edit: false });
    expect(merged.providers).toEqual({ read: true, edit: false });
  });

  test('cycles user cells through inherit, allow, deny, and inherit', () => {
    expect(cycleSettingsPermissionOverride(undefined)).toBe(true);
    expect(cycleSettingsPermissionOverride(true)).toBe(false);
    expect(cycleSettingsPermissionOverride(false)).toBe(undefined);
  });
});
