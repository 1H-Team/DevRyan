import { describe, expect, test } from 'bun:test';

import type { AuthPrincipal } from './authSession';
import {
  getAvailableCustomizableShortcutActions,
  isShortcutActionAvailable,
} from './shortcuts';

const managedPrincipal = (
  capabilities: Partial<AuthPrincipal['policy']> = {},
): AuthPrincipal => ({
  id: 'user-shortcut-policy',
  email: 'developer@example.test',
  displayName: 'Shortcut Developer',
  role: 'developer',
  scope: 'managed',
  policy: {
    settingsPages: ['home', 'shortcuts'],
    files: false,
    terminal: false,
    browser: true,
    createWorktrees: false,
    createBranches: false,
    manageProjects: false,
    manageUsers: false,
    manageGlobalSettings: false,
    manageGit: false,
    push: false,
    github: false,
    ...capabilities,
    bots: capabilities.bots ?? true,
  },
  assignments: [],
});

describe('shortcut policy availability', () => {
  test('maps terminal, files, Git, and project actions to their capabilities', () => {
    const denied = managedPrincipal();

    expect(isShortcutActionAvailable('toggle_terminal', denied)).toBe(false);
    expect(isShortcutActionAvailable('toggle_terminal_expanded', denied)).toBe(false);
    expect(isShortcutActionAvailable('open_terminal_panel', denied)).toBe(false);
    expect(isShortcutActionAvailable('open_go_to_line', denied)).toBe(false);
    expect(isShortcutActionAvailable('toggle_files', denied)).toBe(false);
    expect(isShortcutActionAvailable('open_right_sidebar_files', denied)).toBe(false);
    expect(isShortcutActionAvailable('open_right_sidebar_git', denied)).toBe(false);
    expect(isShortcutActionAvailable('open_git_panel', denied)).toBe(false);
    expect(isShortcutActionAvailable('new_chat_worktree', denied)).toBe(false);

    const allowed = managedPrincipal({
      files: true,
      terminal: true,
      manageGit: true,
      createWorktrees: true,
      createBranches: true,
    });
    expect(isShortcutActionAvailable('toggle_terminal', allowed)).toBe(true);
    expect(isShortcutActionAvailable('open_go_to_line', allowed)).toBe(true);
    expect(isShortcutActionAvailable('open_right_sidebar_git', allowed)).toBe(true);
    expect(isShortcutActionAvailable('new_chat_worktree', allowed)).toBe(true);
  });

  test('keeps combined right-sidebar actions when either Files or Git is allowed', () => {
    for (const principal of [
      managedPrincipal({ files: true }),
      managedPrincipal({ manageGit: true }),
    ]) {
      expect(isShortcutActionAvailable('toggle_right_sidebar', principal)).toBe(true);
      expect(isShortcutActionAvailable('cycle_right_sidebar_tab', principal)).toBe(true);
    }

    const denied = managedPrincipal();
    expect(isShortcutActionAvailable('toggle_right_sidebar', denied)).toBe(false);
    expect(isShortcutActionAvailable('cycle_right_sidebar_tab', denied)).toBe(false);
  });

  test('filters customizable actions without changing the underlying registry', () => {
    const principal = managedPrincipal({ manageGit: true });
    const visibleIds = getAvailableCustomizableShortcutActions(principal).map(({ id }) => id);

    expect(visibleIds).toContain('open_right_sidebar_git');
    expect(visibleIds).toContain('toggle_right_sidebar');
    expect(visibleIds).not.toContain('open_right_sidebar_files');
    expect(visibleIds).not.toContain('toggle_terminal');
    expect(visibleIds).not.toContain('new_chat_worktree');
    expect(isShortcutActionAvailable('open_help', principal)).toBe(true);
    expect(isShortcutActionAvailable('missing-shortcut', principal)).toBe(false);
  });
});
