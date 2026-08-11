import { describe, expect, it } from 'vitest';

import {
  classifyDiagnosticFailure,
  inferLegacyDiagnostic,
} from './error-diagnostics.js';

describe('managed diagnostic classification', () => {
  it.each([
    ['ENOENT: no such file or directory', 'filesystem_target'],
    ['Invalid input: path is required', 'input'],
    ['DEVRYAN_TOOL_INPUT_INVALID: Invalid input: grep.path accepts exactly one path', 'input'],
    ['No files matched the pattern', 'input'],
    ['apply_patch verification failed: Failed to find expected lines', 'patch_context'],
  ])('classifies preventable tool failure %s as low impact', (failureText, failureClass) => {
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: { tool: 'read', failureText },
    })).toEqual({ impact: 'low', source: 'observed', failureClass });
  });

  it.each([
    ['ctx_execute', 'disk I/O error', 'tool_runtime'],
    ['devryan_browser', 'DEVRYAN_BROWSER_LEASE_ACQUIRE_FAILED: upstream 503', 'integration_runtime'],
    ['mcp__connector__lookup', 'connector unavailable', 'integration_runtime'],
    ['custom_managed_tool', 'unexpected runtime failure', 'unknown'],
  ])('classifies retryable runtime tool %s as medium impact', (tool, failureText, failureClass) => {
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: { tool, failureText },
    })).toEqual({ impact: 'medium', source: 'observed', failureClass });
  });

  it('uses authoritative lifecycle state for session and managed task impact', () => {
    expect(classifyDiagnosticFailure({
      action: 'session.error',
      metadata: { retryable: true },
    })).toMatchObject({ impact: 'medium', failureClass: 'session_runtime' });
    expect(classifyDiagnosticFailure({
      action: 'session.error',
      metadata: { retryable: false },
    })).toMatchObject({ impact: 'high', failureClass: 'session_runtime' });
    expect(classifyDiagnosticFailure({ action: 'managed_task.failed' }))
      .toMatchObject({ impact: 'high', failureClass: 'managed_task' });
  });

  it.each(['rg', 'search', 'shell'])(
    'keeps the legacy read/search/shell family low impact for %s',
    (tool) => {
      expect(inferLegacyDiagnostic({ action: 'tool.failed', metadata: { tool } }))
        .toMatchObject({ impact: 'low', source: 'inferred' });
    },
  );

  it('reserves critical impact for exact trusted core actions, never arbitrary text', () => {
    expect(classifyDiagnosticFailure({ action: 'platform.security_failed' }))
      .toEqual({ impact: 'critical', source: 'observed', failureClass: 'platform_security' });
    expect(classifyDiagnosticFailure({ action: 'platform.integrity_failed' }))
      .toEqual({ impact: 'critical', source: 'observed', failureClass: 'platform_integrity' });
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: { tool: 'read', failureText: 'platform.integrity_failed critical breach' },
    }).impact).toBe('medium');
  });

  it('reproduces the retained Zoubair legacy snapshot as 75 low and 82 medium', () => {
    const counts = {
      apply_patch: 26,
      ctx_execute: 25,
      devryan_browser: 25,
      read: 17,
      grep: 15,
      ctx_execute_file: 10,
      skill: 10,
      ctx_batch_execute: 9,
      devryan_task: 5,
      oc_read: 5,
      gh_grep_searchGitHub: 3,
      stat: 1,
      stripe: 1,
      bash: 1,
      linear: 1,
      list_mcp_resource_templates: 1,
      list_mcp_resources: 1,
      ctx_index: 1,
    };
    const totals = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const [tool, count] of Object.entries(counts)) {
      const classification = inferLegacyDiagnostic({ action: 'tool.failed', metadata: { tool } });
      totals[classification.impact] += count;
      expect(classification.source).toBe('inferred');
    }
    expect(totals).toEqual({ low: 75, medium: 82, high: 0, critical: 0 });
  });
});
