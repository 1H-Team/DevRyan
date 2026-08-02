import { describe, expect, test } from 'bun:test';

import {
  filterPermissionCardPatterns,
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
});
