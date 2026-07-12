import { describe, expect, test } from 'bun:test';

import { getVisibleMcpStatus, getVisibleMcpServerNames } from './McpDropdown.utils';

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
