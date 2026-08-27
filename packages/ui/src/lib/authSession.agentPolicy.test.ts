import { describe, expect, test } from 'bun:test';

import {
  canEditPersonalAgentModels,
  isGlobalAgentBehaviorUiHidden,
  type AuthPrincipal,
} from './authSession';

const developer = ({
  hideGlobalBehaviorUi = true,
  hostSettings = false,
  agentsEdit = false,
}: {
  hideGlobalBehaviorUi?: boolean;
  hostSettings?: boolean;
  agentsEdit?: boolean;
} = {}): AuthPrincipal => ({
  id: 'agent-policy-user',
  email: 'developer@example.test',
  displayName: 'Agent Policy User',
  role: 'developer',
  scope: 'managed',
  policy: {
    settingsPages: ['agents'],
    settingsPermissions: {
      appearance: { read: false, edit: false },
      notifications: { read: false, edit: false },
      shortcuts: { read: false, edit: false },
      voice: { read: false, edit: false },
      about: { read: false, edit: false },
      chat: { read: false, edit: false },
      sessions: { read: false, edit: false },
      bots: { read: false, edit: false },
      agents: { read: true, edit: agentsEdit },
      'skills.installed': { read: false, edit: false },
      'skills.catalog': { read: false, edit: false },
      plugins: { read: false, edit: false },
      'magic-prompts': { read: false, edit: false },
      providers: { read: false, edit: false },
      usage: { read: false, edit: false },
      mcp: { read: false, edit: false },
      'remote-instances': { read: false, edit: false },
      tunnel: { read: false, edit: false },
      users: { read: false, edit: false },
      'bug-reports': { read: false, edit: false },
      git: { read: false, edit: false },
      projects: { read: false, edit: false },
      commands: { read: false, edit: false },
    },
    featureOverrides: { agents: { hideGlobalBehaviorUi } },
    bots: true,
    files: false,
    terminal: false,
    browser: true,
    createWorktrees: false,
    createBranches: false,
    manageProjects: false,
    manageUsers: false,
    manageGlobalSettings: hostSettings,
    manageGit: true,
    push: false,
    github: false,
  },
  assignments: [],
});

describe('managed Agent settings policy', () => {
  test('projects effective Global Behavior visibility', () => {
    expect(isGlobalAgentBehaviorUiHidden(developer())).toBe(true);
    expect(isGlobalAgentBehaviorUiHidden(developer({ hideGlobalBehaviorUi: false }))).toBe(false);
  });

  test('requires Host Settings and Agents Edit for personal model editing', () => {
    expect(canEditPersonalAgentModels(developer({ hostSettings: true, agentsEdit: true }))).toBe(true);
    expect(canEditPersonalAgentModels(developer({ hostSettings: false, agentsEdit: true }))).toBe(false);
    expect(canEditPersonalAgentModels(developer({ hostSettings: true, agentsEdit: false }))).toBe(false);
  });
});
