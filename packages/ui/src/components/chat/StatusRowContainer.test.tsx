import { describe, expect, test } from 'bun:test';

import {
  resolveCompactionStatusText,
  resolveManagedChildGenericStatusText,
  resolveManagedDelegationStatusPhase,
  shouldManagedDelegationOwnStatus,
  resolveLongRunningToolPresentation,
  resolveProviderWaitingStatusText,
  resolveStatusRowAssistantDisplay,
  shouldRenderStatusRowAssistantStatus,
} from './StatusRowContainer';

describe('resolveManagedDelegationStatusPhase', () => {
  test('shows startup copy for provisional and authoritative pre-running dispatches', () => {
    expect(resolveManagedDelegationStatusPhase({
      rootPhase: null,
      activeToolName: 'devryan_task',
      activeToolAction: 'start',
    })).toBe('starting');
    expect(resolveManagedDelegationStatusPhase({
      rootPhase: 'starting',
    })).toBe('starting');
  });

  test('switches to waiting as soon as any authoritative child is running', () => {
    expect(resolveManagedDelegationStatusPhase({
      rootPhase: 'waiting',
      activeToolName: 'devryan_task',
      activeToolAction: 'start',
    })).toBe('waiting');
  });

  test('keeps queued children in startup during a wait call', () => {
    expect(resolveManagedDelegationStatusPhase({
      rootPhase: 'starting',
      activeToolName: 'devryan_task',
      activeToolAction: 'wait',
    })).toBe('starting');
  });

  test('does not replace an unrelated active tool status', () => {
    expect(resolveManagedDelegationStatusPhase({
      rootPhase: null,
      activeToolName: 'bash',
      activeToolAction: 'start',
    })).toBeNull();
  });
});

describe('resolveManagedChildGenericStatusText', () => {
  const copy = {
    waitingText: 'Waiting for model',
    recoveringText: 'Recovering subtask',
  };

  test('never restores startup copy between Claude Designer tool and reasoning cycles', () => {
    for (const executionKind of ['start', 'resume', 'retry_in_place', 'recover_in_place'] as const) {
      for (const isGenericStatus of [false, true, false, true]) {
        expect(resolveManagedChildGenericStatusText({
          task: { executionKind, status: 'running', firstAssistantPartAt: 0 },
          isGenericStatus, ...copy,
        })).toBeNull();
      }
    }
  });

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

describe('resolveProviderWaitingStatusText', () => {
  test('shows deterministic Grok copy only before the first assistant part', () => {
    expect(resolveProviderWaitingStatusText({
      providerID: 'xai',
      activePartType: undefined,
      hasStreamedActivity: false,
      waitingForGrokText: 'Waiting for Grok',
    })).toBe('Waiting for Grok');
    expect(resolveProviderWaitingStatusText({
      providerID: 'xai',
      activePartType: 'reasoning',
      hasStreamedActivity: true,
      waitingForGrokText: 'Waiting for Grok',
    })).toBeNull();
    expect(resolveProviderWaitingStatusText({
      providerID: 'openai',
      activePartType: undefined,
      hasStreamedActivity: false,
      waitingForGrokText: 'Waiting for Grok',
    })).toBeNull();
  });

  test('stays silent in the gaps between parts once the turn has produced output', () => {
    // A closed reasoning block or a finished tool leaves no part live, but the
    // last real label still owns the row — this copy must not stomp it.
    expect(resolveProviderWaitingStatusText({
      providerID: 'xai',
      activePartType: undefined,
      hasStreamedActivity: true,
      waitingForGrokText: 'Waiting for Grok',
    })).toBeNull();
  });

  test('accepts every xAI provider alias regardless of casing', () => {
    for (const providerID of ['grok', 'xai-oauth', '  XAI  ']) {
      expect(resolveProviderWaitingStatusText({
        providerID,
        activePartType: undefined,
        hasStreamedActivity: false,
        waitingForGrokText: 'Waiting for Grok',
      })).toBe('Waiting for Grok');
    }
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
      expect(presentation?.tool).toBe('Context Mode: Execute');
      expect(presentation?.actionable).toBe(false);
    }
  });

  test('enables Stop only after the unchanged call is confirmed', () => {
    expect(resolveLongRunningToolPresentation({
      tool: 'ctx_execute',
      confirmedAt: 300_000,
    }, '5m 0s')).toEqual({
      tool: 'Context Mode: Execute',
      elapsed: '5m 0s',
      actionable: true,
    });
  });
});


describe('managed status authority', () => {
  test('clears provisional waiting when an empty snapshot confirms the root', () => {
    const input = { rootPhase: null, activeToolName: 'devryan_task', activeToolAction: 'wait', isLoadingSnapshot: true } as const;
    expect(resolveManagedDelegationStatusPhase(input)).toBe('waiting');
    expect(resolveManagedDelegationStatusPhase({ ...input, isLoadingSnapshot: false })).toBe('managing');
    expect(resolveManagedDelegationStatusPhase({ ...input, hasConfirmedSnapshot: true })).toBe('managing');
  });

  test('uses neutral copy for control and result operations without claiming children run', () => {
    for (const activeToolAction of ['status', 'cancel', 'continue', 'resume', 'recover_in_place', 'retry_in_place', 'abandon', 'read_result', undefined]) {
      expect(resolveManagedDelegationStatusPhase({ rootPhase: null, activeToolName: 'devryan_task', activeToolAction })).toBe('managing');
    }
  });
});


test('managed children preserve primary text/tools and keep recovered idle roots visible', () => {
  for (const activePartType of ['text', 'tool', 'editing'] as const) {
    expect(shouldManagedDelegationOwnStatus({ isWorking: true, hasActiveTasks: true, activePartType, activeToolName: 'bash' })).toBe(false);
  }
  expect(shouldManagedDelegationOwnStatus({ isWorking: false, hasActiveTasks: true })).toBe(true);
  expect(shouldManagedDelegationOwnStatus({ isWorking: true, hasActiveTasks: false, activePartType: 'reasoning' })).toBe(false);
  expect(shouldManagedDelegationOwnStatus({ isWorking: true, hasActiveTasks: false })).toBe(false);
});

describe('resolveCompactionStatusText', () => {
  const text = { automatic: 'Automatically compacting context…', manual: 'Compacting context…' };
  test('names automatic and manual compaction and stays silent otherwise', () => {
    expect(resolveCompactionStatusText('automatic', text)).toBe(text.automatic);
    expect(resolveCompactionStatusText('manual', text)).toBe(text.manual);
    expect(resolveCompactionStatusText(null, text)).toBeNull();
    expect(resolveCompactionStatusText(undefined, text)).toBeNull();
  });
  test('a revert still owns the row over a compacting label', () => {
    expect(resolveStatusRowAssistantDisplay({ isRevertPending: true, revertingText: 'Reverting chat…',
      showWorkingPlaceholder: true, assistantStatusText: text.automatic, assistantIsGenericStatus: false }))
      .toMatchObject({ statusText: 'Reverting chat…' });
  });
});
