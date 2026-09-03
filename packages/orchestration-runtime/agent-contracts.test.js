import { describe, expect, test } from 'bun:test';

import {
  MANAGED_AGENT_CONTRACT_DEFAULT_ROLE,
  MANAGED_AGENT_CONTRACT_MAX_LINES,
  MANAGED_AGENT_CONTRACT_ROLES,
  MANAGED_AGENT_CONTRACT_TAG,
  buildManagedAgentContract,
  normalizeManagedAgentContractRole,
} from './agent-contracts.js';

const SHARED_RULES = [
  'exactly one terminal marker line: **Status:** complete or **Status:** blocked',
  'edit only the files the task names',
  'unrelated work back to the parent',
  'no git commands (no status, diff, add, commit, stash, checkout)',
  'at most 2 focused test runs and 1 type-check',
  'one final acceptance check',
  'Report external failures',
  'uncommitted changes you did not make are out of scope',
  'Do not ask about them, revert them, or validate them',
  'Blocked only when the brief is missing, a tool or provider fails, or a rule cannot be satisfied',
];

describe('managed agent contracts', () => {
  test('every role carries the shared rules and stays within the line budget', () => {
    const agents = [...MANAGED_AGENT_CONTRACT_ROLES, MANAGED_AGENT_CONTRACT_DEFAULT_ROLE, 'builder', undefined];
    for (const agent of agents) {
      const contract = buildManagedAgentContract({ agent });
      expect(contract.startsWith(MANAGED_AGENT_CONTRACT_TAG)).toBe(true);
      expect(contract.split('\n').length).toBeLessThanOrEqual(MANAGED_AGENT_CONTRACT_MAX_LINES);
      for (const rule of SHARED_RULES) {
        expect(contract).toContain(rule);
      }
      // Exactly one marker of each kind: the child must not be shown competing markers.
      expect(contract.split('**Status:** complete').length - 1).toBe(1);
      expect(contract.split('**Status:** blocked').length - 1).toBe(1);
    }
  });

  test('carries role-specific guidance for designer, fixer, and the read-only roles', () => {
    const designer = buildManagedAgentContract({ agent: 'designer' });
    expect(designer).toContain('managed designer task');
    expect(designer).toContain('layout, states, dark and light themes, mobile and desktop');
    expect(designer).toContain('Do not run tsc for a UI-only task unless the task asks for it');

    const fixer = buildManagedAgentContract({ agent: 'fixer' });
    expect(fixer).toContain('managed fixer task');
    expect(fixer).toContain('focused acceptance check you were assigned');

    for (const agent of ['explorer', 'librarian', 'oracle']) {
      const contract = buildManagedAgentContract({ agent });
      expect(contract).toContain(`managed ${agent} task`);
      expect(contract).toContain('Read-only role: do not edit files, and do not run tests, builds, or linters unless the prompt assigns it');
      expect(contract).not.toContain('tsc');
    }
  });

  test('falls back to a generic contract for unknown agents and normalizes role casing', () => {
    expect(normalizeManagedAgentContractRole(' Designer ')).toBe('designer');
    expect(normalizeManagedAgentContractRole('builder')).toBe(MANAGED_AGENT_CONTRACT_DEFAULT_ROLE);
    expect(normalizeManagedAgentContractRole(null)).toBe(MANAGED_AGENT_CONTRACT_DEFAULT_ROLE);
    expect(buildManagedAgentContract({ agent: ' Designer ' })).toBe(buildManagedAgentContract({ agent: 'designer' }));

    const generic = buildManagedAgentContract({ agent: 'builder' });
    expect(generic).toContain('managed sub-agent task');
    expect(generic).not.toContain('Read-only role');
    expect(generic).not.toContain('Designer:');
    expect(generic).not.toContain('Fixer:');
    expect(buildManagedAgentContract()).toBe(generic);
  });
});
