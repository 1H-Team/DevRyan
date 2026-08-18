import { describe, expect, test } from 'bun:test';

import {
  resolveManagedChildGenericStatusText,
  resolveLongRunningToolPresentation,
  resolveStatusRowAssistantDisplay,
  shouldRenderStatusRowAssistantStatus,
} from './StatusRowContainer';

describe('resolveManagedChildGenericStatusText', () => {
  const copy = {
    waitingText: 'Waiting for model',
    recoveringText: 'Recovering subtask',
  };

  test('replaces random generic copy for an active managed child', () => {
    expect(resolveManagedChildGenericStatusText({
      task: { executionKind: 'start', status: 'running' },
      isGenericStatus: true,
      ...copy,
    })).toBe('Waiting for model');
  });

  test('distinguishes same-child recovery attempts', () => {
    for (const executionKind of ['resume', 'recover_in_place', 'retry_in_place'] as const) {
      expect(resolveManagedChildGenericStatusText({
        task: { executionKind, status: 'running' },
        isGenericStatus: true,
        ...copy,
      })).toBe('Recovering subtask');
    }
  });

  test('preserves semantic assistant copy and terminal task state', () => {
    expect(resolveManagedChildGenericStatusText({
      task: { executionKind: 'retry_in_place', status: 'running' },
      isGenericStatus: false,
      ...copy,
    })).toBeNull();
    expect(resolveManagedChildGenericStatusText({
      task: { executionKind: 'start', status: 'completed' },
      isGenericStatus: true,
      ...copy,
    })).toBeNull();
  });
});

describe('shouldRenderStatusRowAssistantStatus', () => {
  test('keeps the row visible for every working state, including reasoning', () => {
    expect(shouldRenderStatusRowAssistantStatus(true)).toBe(true);
  });

  test('keeps the row visible when a managed child owns the idle status', () => {
    expect(shouldRenderStatusRowAssistantStatus(false, true)).toBe(true);
  });

  test('does not render the status row assistant placeholder while idle', () => {
    expect(shouldRenderStatusRowAssistantStatus(false)).toBe(false);
  });
});

describe('resolveStatusRowAssistantDisplay', () => {
  test('shows the localized non-blocking revert status ahead of normal assistant activity', () => {
    expect(resolveStatusRowAssistantDisplay({
      isRevertPending: true,
      revertingText: 'Reverting chat…',
      showWorkingPlaceholder: true,
      assistantStatusText: 'Editing files',
      assistantIsGenericStatus: true,
    })).toEqual({
      isWorking: true,
      statusText: 'Reverting chat…',
      isGenericStatus: false,
    });
  });

  test('preserves normal working and idle status behavior when no revert is pending', () => {
    expect(resolveStatusRowAssistantDisplay({
      isRevertPending: false,
      revertingText: 'Reverting chat…',
      showWorkingPlaceholder: true,
      assistantStatusText: 'Running tests',
      assistantIsGenericStatus: true,
    })).toEqual({
      isWorking: true,
      statusText: 'Running tests',
      isGenericStatus: true,
    });
    expect(resolveStatusRowAssistantDisplay({
      isRevertPending: false,
      revertingText: 'Reverting chat…',
      showWorkingPlaceholder: false,
      assistantStatusText: null,
      assistantIsGenericStatus: false,
    })).toEqual({
      isWorking: false,
      statusText: null,
      isGenericStatus: false,
    });
  });
});

describe('resolveLongRunningToolPresentation', () => {
  test('shows direct and MCP aliases without elapsed time before enabling Stop', () => {
    for (const tool of ['ctx_execute', 'mcp__context-mode__ctx_execute']) {
      const presentation = resolveLongRunningToolPresentation({
        tool,
        confirmedAt: null,
      }, null);

      expect(presentation?.elapsed).toBeNull();
      expect(presentation?.tool).toBe('C-Mode: Execute');
      expect(presentation?.actionable).toBe(false);
    }
  });

  test('enables Stop only after the unchanged call is confirmed', () => {
    expect(resolveLongRunningToolPresentation({
      tool: 'ctx_execute',
      confirmedAt: 300_000,
    }, '5m 0s')).toEqual({
      tool: 'C-Mode: Execute',
      elapsed: '5m 0s',
      actionable: true,
    });
  });
});
