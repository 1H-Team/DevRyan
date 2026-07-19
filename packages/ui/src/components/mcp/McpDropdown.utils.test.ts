import { describe, expect, test } from 'bun:test';

import {
  getMcpIndicatorState,
  getVisibleMcpStatus,
  getVisibleMcpServerNames,
} from './McpDropdown.utils';

const connected = { status: 'connected' as const };
const disabled = { status: 'disabled' as const };

describe('MCP dropdown visibility', () => {
  test('hides known ambient MCP aliases that only exist in runtime status', () => {
    const status = {
      context7: disabled,
      ghgrep: disabled,
      'gh-grep': disabled,
      linear: connected,
    };

    expect(getVisibleMcpServerNames(status, [])).toEqual(['linear']);
    expect(getVisibleMcpStatus(status, [])).toEqual({ linear: connected });
  });

  test('keeps explicitly configured blocked aliases visible', () => {
    const status = { context7: connected, ghgrep: connected };
    const configs = [{ name: 'context7' }, { name: 'ghgrep' }];

    expect(getVisibleMcpServerNames(status, configs)).toEqual(['context7', 'ghgrep']);
    expect(getVisibleMcpStatus(status, configs)).toEqual(status);
  });

  test('keeps ordinary status-only MCPs visible and merges configured names', () => {
    const status = { remoteRuntime: connected };
    const configs = [{ name: 'configured-only' }];

    expect(getVisibleMcpServerNames(status, configs)).toEqual(['configured-only', 'remoteRuntime']);
    expect(getVisibleMcpStatus(status, configs)).toEqual(status);
  });
});

describe('MCP dropdown indicators', () => {
  test('shows connected servers as green and clears remembered issue presentation', () => {
    expect(getMcpIndicatorState({
      enabled: true,
      status: connected,
      issueKind: 'failed',
    })).toEqual({
      tone: 'success',
      status: 'connected',
      remembered: false,
    });
  });

  for (const issueKind of ['failed', 'needs_auth', 'needs_client_registration'] as const) {
    test(`shows a disabled server with a remembered ${issueKind} issue as orange`, () => {
      expect(getMcpIndicatorState({
        enabled: false,
        status: disabled,
        issueKind,
      })).toEqual({
        tone: 'warning',
        status: issueKind,
        remembered: true,
      });
    });
  }

  test('shows a disabled server without a remembered issue as gray', () => {
    expect(getMcpIndicatorState({
      enabled: false,
      status: disabled,
      issueKind: undefined,
    })).toEqual({
      tone: 'idle',
      status: 'disabled',
      remembered: false,
    });
  });

  test('uses the configured toggle state when runtime status is unavailable', () => {
    expect(getMcpIndicatorState({
      enabled: false,
      status: undefined,
      issueKind: undefined,
    })).toEqual({
      tone: 'idle',
      status: 'disabled',
      remembered: false,
    });
  });

  test('shows current connection failures as orange without changing enablement', () => {
    expect(getMcpIndicatorState({
      enabled: true,
      status: { status: 'failed', error: 'missing token' },
      issueKind: undefined,
    })).toEqual({
      tone: 'warning',
      status: 'failed',
      error: 'missing token',
      remembered: false,
    });
  });
});
