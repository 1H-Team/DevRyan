import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { RuntimeAPIs } from '@/lib/api/types';

import {
  clearWorktreeBootstrapState,
  getWorktreeBootstrapStageLabel,
  summarizeWorktreeBootstrapError,
  waitForWorktreeBootstrapForSend,
} from './worktreeBootstrap';

const originalWindow = globalThis.window;
const directory = '/worktrees/Dev';

afterEach(() => {
  clearWorktreeBootstrapState(directory);
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: originalWindow,
  });
});

describe('worktree bootstrap send recovery', () => {
  test('retries a failed population receipt once and waits for readiness', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const bootstrapStatus = mock(async () => {
      requests.push({ url: 'bootstrap-status', method: 'GET' });
      return {
        operationId: 'op-failed',
        idempotencyKey: 'request-1',
        directory,
        stage: 'populate_worktree' as const,
        status: 'failed' as const,
        error: 'fatal: Could not write new index file.',
        updatedAt: 1,
        attempt: 1,
        warnings: [],
        stages: {},
      };
    });
    const retry = mock(async () => {
      requests.push({ url: 'operations/op-failed/retry', method: 'POST' });
      return {
          operationId: 'op-failed',
          idempotencyKey: 'request-1',
          directory,
          stage: 'populate_worktree' as const,
          status: 'queued' as const,
          error: null,
          updatedAt: 2,
          attempt: 2,
          warnings: [],
          stages: {},
      };
    });
    const operation = mock(async () => {
      requests.push({ url: 'operations/op-failed', method: 'GET' });
      return {
          operationId: 'op-failed',
          idempotencyKey: 'request-1',
          directory,
          stage: 'complete' as const,
          status: 'ready' as const,
          error: null,
          updatedAt: 3,
          attempt: 2,
          warnings: [],
          stages: {},
      };
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        __OPENCHAMBER_RUNTIME_APIS__: {
          git: { worktree: { bootstrapStatus, retry, operation } },
        } as unknown as RuntimeAPIs,
      },
    });

    await waitForWorktreeBootstrapForSend(directory);

    expect(requests).toEqual([
      { url: 'bootstrap-status', method: 'GET' },
      { url: 'operations/op-failed/retry', method: 'POST' },
      { url: 'operations/op-failed', method: 'GET' },
    ]);
  });

  test('collapses checkout progress into an actionable index error', () => {
    expect(summarizeWorktreeBootstrapError([
      'Updating files: 99% (10338/10442)',
      'Updating files: 100% (10442/10442), done.',
      'fatal: Could not write new index file.',
      'Command failed: git reset --hard',
    ].join('\r'))).toBe(
      'Git could not finalize the worktree index. Check disk space and repository permissions, then retry worktree setup.',
    );
  });

  test('exposes a visible post-checkout hook stage label', () => {
    expect(getWorktreeBootstrapStageLabel('run_post_checkout_hook')).toBe('Running post-checkout hook');
  });
});
