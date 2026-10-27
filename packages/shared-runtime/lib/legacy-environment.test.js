import { describe, expect, test } from 'bun:test';
import {
  adoptLegacyEnvironment, canonicalEnvironmentName, readDevRyanEnv, setDevRyanEnv,
} from './legacy-environment.js';

describe('legacy OPENCHAMBER_* environment aliases', () => {
  test('adoption copies unset names and never overrides or deletes', () => {
    const env = { OPENCHAMBER_DATA_DIR: '/legacy', OPENCHAMBER_PORT: '1', DEVRYAN_PORT: '2', PATH: '/bin' };
    expect(adoptLegacyEnvironment(env)).toEqual(['DEVRYAN_DATA_DIR']);
    expect(env).toEqual({ OPENCHAMBER_DATA_DIR: '/legacy', OPENCHAMBER_PORT: '1', DEVRYAN_PORT: '2', PATH: '/bin', DEVRYAN_DATA_DIR: '/legacy' });
    expect(adoptLegacyEnvironment(env)).toEqual([]);
  });

  test('reads prefer the DevRyan name and fall back to the alias', () => {
    expect(readDevRyanEnv({ DEVRYAN_HOST: 'a', OPENCHAMBER_HOST: 'b' }, 'DEVRYAN_HOST')).toBe('a');
    expect(readDevRyanEnv({ OPENCHAMBER_HOST: 'b' }, 'HOST')).toBe('b');
    expect(readDevRyanEnv({ DEVRYAN_HOST: '', OPENCHAMBER_HOST: 'b' }, 'OPENCHAMBER_HOST')).toBe('');
    expect(readDevRyanEnv(undefined, 'HOST')).toBeUndefined();
  });

  test('writes keep both names equal', () => {
    const env = { OPENCHAMBER_DATA_DIR: '/stale' };
    setDevRyanEnv(env, 'DEVRYAN_DATA_DIR', '/bound');
    expect(env).toEqual({ OPENCHAMBER_DATA_DIR: '/bound', DEVRYAN_DATA_DIR: '/bound' });
    setDevRyanEnv(env, 'DATA_DIR', undefined);
    expect(env).toEqual({});
  });

  test('canonical names map only the legacy prefix', () => {
    expect(canonicalEnvironmentName('OPENCHAMBER_ELECTRON_DEV')).toBe('DEVRYAN_ELECTRON_DEV');
    expect(canonicalEnvironmentName('OPENCODE_DB')).toBe('OPENCODE_DB');
  });
});
