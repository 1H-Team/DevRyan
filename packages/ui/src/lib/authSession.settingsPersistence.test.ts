import { describe, expect, test } from 'bun:test';

import {
  authStoragePrincipalId,
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
    bots: true,
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
  test('isolates Bot-link caches from the owner and from other grants', () => {
    const owner = managedDeveloper(true);
    const grant = { id: 'grant-one', ownerId: owner.id, profileId: 'profile', sessionId: 'session', generation: 'generation', botIds: ['bot'], expiresAt: Date.now() + 1000 };
    const guest: AuthPrincipal = { ...owner, scope: 'tunnel-bot', tunnelGrant: grant };
    expect(authStoragePrincipalId(guest)).not.toBe(authStoragePrincipalId(owner));
    expect(authStoragePrincipalId({ ...guest, tunnelGrant: { ...grant, id: 'grant-two' } })).not.toBe(authStoragePrincipalId(guest));
    expect(authStoragePrincipalId({ ...guest, tunnelGrant: { ...grant, sessionId: 'reconnected' } })).toBe(authStoragePrincipalId(guest));
    expect(canPersistHostProjectSettings(guest)).toBe(false);
  });
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
