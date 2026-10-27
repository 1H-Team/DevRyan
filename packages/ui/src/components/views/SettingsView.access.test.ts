import { describe, expect, test } from 'bun:test';

import type { AuthPrincipal } from '@/lib/authSession';
import {
  canAccessSettingsDestination,
} from './SettingsView.access';

const developer: AuthPrincipal = {
  id: 'a0000000-0000-4000-8000-000000000001',
  email: 'developer@example.test',
  displayName: 'Developer',
  role: 'developer',
  scope: 'managed',
  policy: {
    settingsPages: [],
    files: false,
    terminal: false,
    browser: false,
    createWorktrees: false,
    createBranches: false,
    manageProjects: false,
    manageUsers: false,
    manageGlobalSettings: false,
    manageGit: false,
    push: false,
    github: false,
  },
  assignments: [],
};

describe('Settings capability access', () => {
  test('grants no Coding Agent settings without a settings permission', () => {
    expect(canAccessSettingsDestination(developer, 'skills.installed')).toBe(false);
    expect(canAccessSettingsDestination(developer, 'mcp')).toBe(false);
    expect(canAccessSettingsDestination(developer, 'skills.catalog')).toBe(false);
  });

  test('keeps separately granted Coding Agent settings', () => {
    const skillsOnly = { ...developer, policy: { ...developer.policy, settingsPages: ['skills.installed'] } };

    expect(canAccessSettingsDestination(skillsOnly, 'skills.installed')).toBe(true);
    expect(canAccessSettingsDestination(skillsOnly, 'mcp')).toBe(false);
  });
});
