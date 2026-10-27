import { describe, expect, it } from 'vitest';
import { resolveNativeClaudeEnrollmentDirectory } from './native-claude-enrollment-location.js';

const locations = [{ directory: '/home/admin' }, { directory: '/home/admin/project' }, { directory: '/home/admin/registered' }];
const projectMap = [{ targetDirectory: '/home/admin' }, { targetDirectory: '/home/admin/project' }];

describe('resolveNativeClaudeEnrollmentDirectory', () => {
  it('keeps a reviewed request directory', () => {
    expect(resolveNativeClaudeEnrollmentDirectory({ directory: '/home/admin/project', locations, projectMap })).toBe('/home/admin/project');
  });

  it('binds registered, unknown and missing directories to the default location', () => {
    for (const directory of ['/home/admin/registered', '/elsewhere', undefined, null]) {
      expect(resolveNativeClaudeEnrollmentDirectory({ directory, locations, projectMap })).toBe('/home/admin');
    }
  });

  it('fails closed without a reviewed default location', () => {
    for (const input of [{ locations: [], projectMap }, { locations, projectMap: [] }, { locations: [{ directory: '/home/admin/registered' }], projectMap }]) {
      expect(() => resolveNativeClaudeEnrollmentDirectory({ directory: '/elsewhere', ...input })).toThrow('native_claude_enrollment_location_unreviewed');
    }
  });
});
