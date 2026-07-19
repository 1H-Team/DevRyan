import { describe, expect, it, vi } from 'vitest';

import { importCursorManagedCredential } from './cursor-import.js';

describe('Cursor credential import', () => {
  it('uses a fixed sqlite argument array and returns only validated OAuth fields', () => {
    const execFile = vi.fn(() => JSON.stringify([
      { key: 'cursorAuth/accessToken', value: 'access' },
      { key: 'cursorAuth/refreshToken', value: 'refresh' },
      { key: 'unrelated', value: 'ignore-me' },
    ]));

    const credential = importCursorManagedCredential({
      platform: 'darwin',
      homedir: () => '/Users/test',
      execFile,
    });

    expect(credential).toEqual({ accessToken: 'access', refreshToken: 'refresh' });
    expect(execFile).toHaveBeenCalledTimes(1);
    const [binary, args] = execFile.mock.calls[0];
    expect(binary).toBe('sqlite3');
    expect(args[0]).toBe('-json');
    expect(args[1]).toBe('/Users/test/Library/Application Support/Cursor/User/globalStorage/state.vscdb');
    expect(args[2]).toContain('cursorAuth/accessToken');
    expect(args[2]).not.toContain('/Users/test');
  });

  it('reports a stable unavailable error without leaking process details', () => {
    expect(() => importCursorManagedCredential({ platform: 'linux' })).toThrowError(
      expect.objectContaining({ code: 'IMPORT_UNAVAILABLE' }),
    );
    expect(() => importCursorManagedCredential({
      platform: 'darwin',
      execFile: () => {
        throw new Error('secret stderr');
      },
    })).toThrowError(expect.objectContaining({
      code: 'IMPORT_UNAVAILABLE',
      message: 'Cursor credentials could not be imported',
    }));
  });
});
