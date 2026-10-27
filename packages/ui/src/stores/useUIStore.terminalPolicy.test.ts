import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { setAuthPrincipal, type AuthPrincipal } from '@/lib/authSession';
import { getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useUIStore } from './useUIStore';

const principalWithTerminal = (terminal: boolean): AuthPrincipal => ({
  id: 'user-terminal-policy',
  email: 'developer@example.test',
  displayName: 'Terminal Developer',
  role: 'developer',
  scope: 'managed',
  policy: {
    settingsPages: ['home', 'shortcuts'],
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

describe('useUIStore terminal policy', () => {
  beforeEach(() => {
    setAuthPrincipal(null);
    useUIStore.setState({
      activeMainTab: 'chat',
      isBottomTerminalOpen: false,
      isBottomTerminalExpanded: false,
    });
  });

  afterEach(() => {
    setAuthPrincipal(null);
    useUIStore.setState({
      activeMainTab: 'chat',
      isBottomTerminalOpen: false,
      isBottomTerminalExpanded: false,
    });
  });

  test('blocks every terminal-opening state action while still allowing close operations', () => {
    setAuthPrincipal(principalWithTerminal(false));

    useUIStore.getState().toggleBottomTerminal();
    useUIStore.getState().setBottomTerminalOpen(true);
    useUIStore.getState().setBottomTerminalExpanded(true);
    useUIStore.getState().setActiveMainTab('terminal');

    expect(useUIStore.getState().isBottomTerminalOpen).toBe(false);
    expect(useUIStore.getState().isBottomTerminalExpanded).toBe(false);
    expect(useUIStore.getState().activeMainTab).toBe('chat');

    useUIStore.setState({ isBottomTerminalOpen: true, isBottomTerminalExpanded: true });
    useUIStore.getState().setBottomTerminalOpen(false);
    useUIStore.getState().setBottomTerminalExpanded(false);
    expect(useUIStore.getState().isBottomTerminalOpen).toBe(false);
    expect(useUIStore.getState().isBottomTerminalExpanded).toBe(false);
  });

  test('restores access without deleting the saved terminal shortcut override', () => {
    const originalOverrides = useUIStore.getState().shortcutOverrides;
    useUIStore.setState({
      shortcutOverrides: { ...originalOverrides, toggle_terminal: 'alt+t' },
    });

    try {
      setAuthPrincipal(principalWithTerminal(false));
      useUIStore.getState().toggleBottomTerminal();
      expect(useUIStore.getState().shortcutOverrides.toggle_terminal).toBe('alt+t');

      setAuthPrincipal(principalWithTerminal(true));
      useUIStore.getState().toggleBottomTerminal();
      useUIStore.getState().setBottomTerminalExpanded(true);
      useUIStore.getState().setActiveMainTab('terminal');

      expect(useUIStore.getState().isBottomTerminalOpen).toBe(true);
      expect(useUIStore.getState().isBottomTerminalExpanded).toBe(true);
      expect(useUIStore.getState().activeMainTab).toBe('terminal');
      expect(getEffectiveShortcutCombo('toggle_terminal', useUIStore.getState().shortcutOverrides)).toBe('alt+t');
    } finally {
      useUIStore.setState({ shortcutOverrides: originalOverrides });
    }
  });
});
