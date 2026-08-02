import { describe, expect, test } from 'bun:test';
import { resolveOpenCodeVersionViewStatus } from './openCodeVersionState';

const state = {
  checked: false,
  checking: false,
  error: null,
  currentVersion: '1.18.10',
  latestVersion: null,
  updateAvailable: null,
};

describe('OpenCode version section states', () => {
  test('covers initial and checking states', () => {
    expect(resolveOpenCodeVersionViewStatus(state)).toBe('idle');
    expect(resolveOpenCodeVersionViewStatus({ ...state, checking: true })).toBe('checking');
  });

  test('reports available, current, and newer-than-latest versions distinctly', () => {
    expect(resolveOpenCodeVersionViewStatus({
      ...state,
      checked: true,
      latestVersion: '1.18.10',
      updateAvailable: true,
    })).toBe('updateAvailable');

    expect(resolveOpenCodeVersionViewStatus({
      ...state,
      checked: true,
      latestVersion: '1.18.10',
      updateAvailable: false,
    })).toBe('upToDate');

    expect(resolveOpenCodeVersionViewStatus({
      ...state,
      checked: true,
      currentVersion: '1.18.11',
      latestVersion: '1.18.10',
      updateAvailable: false,
    })).toBe('newerThanLatest');
  });

  test('keeps unknown-version and failure states explicit', () => {
    expect(resolveOpenCodeVersionViewStatus({
      ...state,
      checked: true,
      currentVersion: null,
      latestVersion: '1.18.10',
      updateAvailable: null,
    })).toBe('currentUnavailable');

    expect(resolveOpenCodeVersionViewStatus({
      ...state,
      checked: true,
      error: 'Unable to check',
    })).toBe('error');
  });
});
