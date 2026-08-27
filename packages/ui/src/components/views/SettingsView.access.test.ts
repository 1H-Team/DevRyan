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
    bots: true,
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
  test('keeps Bot-specific Skills inside Bot Resources without granting host settings access', () => {
    expect(canAccessSettingsDestination(developer, 'bots')).toBe(false);
    expect(canAccessSettingsDestination(developer, 'skills.installed')).toBe(false);
    expect(canAccessSettingsDestination(developer, 'mcp')).toBe(false);
    expect(canAccessSettingsDestination(developer, 'skills.catalog')).toBe(false);
  });

  test('removes Bot-only destinations while keeping separately granted Coding Agent settings', () => {
    const agentsOnly = {
      ...developer,
      policy: {
        ...developer.policy,
        bots: false,
        settingsPages: ['skills.installed'],
      },
    };

    expect(canAccessSettingsDestination(agentsOnly, 'bots')).toBe(false);
    expect(canAccessSettingsDestination(agentsOnly, 'skills.installed')).toBe(true);
    expect(canAccessSettingsDestination(agentsOnly, 'mcp')).toBe(false);
  });
});
