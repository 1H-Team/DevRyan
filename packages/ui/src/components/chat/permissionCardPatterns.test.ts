import { describe, expect, test } from 'bun:test';

import {
  filterPermissionCardPatterns,
  getSkillPermissionName,
  isShellPermissionTool,
} from './permissionCardPatterns';

describe('permission card shell patterns', () => {
  test('recognizes every supported shell tool alias', () => {
    for (const toolName of ['bash', 'shell', 'shell_command', 'cmd', 'terminal']) {
      expect(isShellPermissionTool(toolName)).toBe(true);
    }

    expect(isShellPermissionTool('read')).toBe(false);
  });

  test('suppresses shell patterns already represented by the rendered command', () => {
    expect(filterPermissionCardPatterns({
      toolName: 'terminal',
      patterns: ['bun test', 'bun test', 'git *'],
      command: 'bun test',
    })).toEqual(['git *']);
  });

  test('leaves non-shell permission patterns unchanged', () => {
    const patterns = ['src/**/*.ts', 'src/**/*.ts'];
    const filtered = filterPermissionCardPatterns({
      toolName: 'edit',
      patterns,
      command: 'src/**/*.ts',
    });

    expect(filtered).toBe(patterns);
    expect(filtered).toEqual(['src/**/*.ts', 'src/**/*.ts']);
  });

  test('shows a reviewed skill by its human name instead of the hashed resource', () => {
    const hashed = 'devryan-539ddc37a961e3aceadfc7bbb540b8e7';
    expect(getSkillPermissionName('skill', { name: 'Superpowers' })).toBe('Superpowers');
    expect(filterPermissionCardPatterns({
      toolName: 'skill',
      patterns: [hashed],
      command: '',
      metadata: { name: 'Superpowers' },
    })).toEqual(['Superpowers']);
    expect(getSkillPermissionName('skill', {})).toBeNull();
    expect(getSkillPermissionName('skill', { name: '  ' })).toBeNull();
    expect(getSkillPermissionName('read', { name: 'Superpowers' })).toBeNull();
    const legacy = ['pdf'];
    expect(filterPermissionCardPatterns({ toolName: 'skill', patterns: legacy, command: '', metadata: {} })).toBe(legacy);
  });
});
