import { describe, expect, test } from 'bun:test';

import {
  canEditSettingsPage,
  canPersistHostProjectSettings,
  type AuthPrincipal,
} from './authSession';
import { createSettingsPermissions } from './settings/permissions';

const managedDeveloper = (appearanceEdit: boolean): AuthPrincipal => ({
  id: 'developer-settings-policy',
  email: 'developer@example.test',
  displayName: 'Developer',
  role: 'developer',
  scope: 'managed',
  policy: {
    settingsPages: ['appearance'],
    settingsPermissions: createSettingsPermissions((slug) => ({
      read: slug === 'appearance',
      edit: slug === 'appearance' && appearanceEdit,
    })),
    files: false,
    terminal: false,
    browser: true,
    createWorktrees: false,
    createBranches: false,
    manageProjects: false,
    manageUsers: false,
    manageGlobalSettings: false,
    manageGit: true,
    push: false,
    github: false,
  },
  assignments: [],
});

describe('automatic settings persistence policy', () => {
  test('allows automatic appearance migration only with appearance edit permission', () => {
    expect(canEditSettingsPage(managedDeveloper(true), 'appearance')).toBe(true);
    expect(canEditSettingsPage(managedDeveloper(false), 'appearance')).toBe(false);
  });

  test('keeps host project metadata writes restricted to administrators', () => {
    expect(canPersistHostProjectSettings(managedDeveloper(true))).toBe(false);
    expect(canPersistHostProjectSettings({
      ...managedDeveloper(true),
      role: 'admin',
    })).toBe(true);
  });
});
