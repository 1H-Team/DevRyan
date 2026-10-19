import { describe, expect, test } from 'bun:test';

import type { AuthPrincipal } from '@/lib/authSession';
import { isVisualSettingAllowedByPolicy } from './visualSettingsPolicy';

const principal = (terminal: boolean): AuthPrincipal => ({
  id: 'visual-policy-user',
  email: 'developer@example.test',
  displayName: 'Visual Policy User',
  role: 'developer',
  scope: 'managed',
  policy: {
    settingsPages: ['appearance'],
    bots: true,
    files: false,
    terminal,
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

describe('Appearance terminal policy', () => {
  test('hides terminal-only controls while retaining Code Font', () => {
    const denied = principal(false);
    expect(isVisualSettingAllowedByPolicy('terminalFontSize', denied)).toBe(false);
    expect(isVisualSettingAllowedByPolicy('terminalQuickKeys', denied)).toBe(false);
    expect(isVisualSettingAllowedByPolicy('codeFont', denied)).toBe(true);
  });

  test('restores terminal-only controls when capability is enabled', () => {
    const allowed = principal(true);
    expect(isVisualSettingAllowedByPolicy('terminalFontSize', allowed)).toBe(true);
    expect(isVisualSettingAllowedByPolicy('terminalQuickKeys', allowed)).toBe(true);
  });
});
