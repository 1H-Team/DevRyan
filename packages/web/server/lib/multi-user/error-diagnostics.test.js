import { describe, expect, it } from 'vitest';

import {
  classifyDiagnosticFailure,
  inferLegacyDiagnostic,
} from './error-diagnostics.js';

describe('managed diagnostic classification', () => {
  it.each([
    ['ENOENT: no such file or directory', 'filesystem_target'],
    ['Invalid input: path is required', 'input'],
    ['path must be a string or a file descriptor', 'input'],
    ['DEVRYAN_TOOL_INPUT_INVALID: Invalid input: grep.path accepts exactly one path', 'input'],
    ["Model tried to call unavailable tool 'invalid'. Available tools: read, grep.", 'input'],
    ['No files matched the pattern', 'input'],
    ['apply_patch verification failed: Failed to find expected lines', 'patch_context'],
    ['Invalid patch text: malformed patch', 'patch_context'],
  ])('classifies preventable tool failure %s as low impact', (failureText, failureClass) => {
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: { tool: 'read', failureText },
    })).toEqual({ impact: 'low', source: 'observed', failureClass, disposition: 'expected' });
  });

  it('classifies the deterministic Context Mode project-boundary rejection as input', () => {
    const failureText = 'File access blocked: "<HOME>/.config/opencode/skills/Impeccable/reference/shape.md" resolves outside the project root (<WORKTREE_8a7eca4fb393>). context-mode confines ctx_execute_file to the workspace so it cannot be used to bypass the host\'s sandbox/permission controls (issue #852). To intentionally process a file outside the project, add a host allow rule.';

    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: { tool: 'ctx_execute_file', failureText },
    })).toEqual({
      impact: 'low',
      source: 'observed',
      failureClass: 'input',
      disposition: 'expected',
    });
  });

  it.each([
    ['skill', 'Skill "accessibility" not found. Available skills: Accessibility (a11y)'],
    ['skill', 'Permission denied by tool policy'],
    ['devryan_task', 'Managed task barrier is active'],
    ['devryan_task', 'This result has already been acknowledged'],
    ['edit', 'filePath is required'],
    ['devryan_browser', 'SecurityError: localStorage is unavailable in a cross-origin sandboxed frame'],
    ['devryan_browser', 'Could not locate element for stale ref @e267'],
  ])('classifies investigated routine failure from %s as expected', (tool, failureText) => {
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: { tool, failureText },
    })).toMatchObject({ impact: 'low', disposition: 'expected' });
  });

  it('prefers structured routine and host codes over compatibility message matching', () => {
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: { tool: 'devryan_browser', errorCode: 'missing_selector', failureText: 'opaque' },
    })).toMatchObject({ impact: 'low', disposition: 'expected' });
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: { tool: 'devryan_browser', errorCode: 'lineage_unavailable', failureText: 'opaque' },
    })).toMatchObject({ impact: 'medium', disposition: 'actionable' });
  });

  it('keeps browser host and lineage failures actionable', () => {
    for (const failureText of [
      'DEVRYAN_BROWSER_LEASE_ACQUIRE_FAILED: Cannot resolve session lineage from OpenCode',
      'The desktop browser host could not create a lease',
    ]) {
      expect(classifyDiagnosticFailure({
        action: 'tool.failed',
        metadata: { tool: 'devryan_browser', failureText },
      })).toMatchObject({ impact: 'medium', disposition: 'actionable' });
    }
  });

  it.each(['DEVRYAN_BROWSER_EVAL_ERROR', 'DEVRYAN_BROWSER_INPUT_INVALID'])(
    'classifies explicit browser input code %s in structured and OpenCode string errors',
    (errorCode) => {
      for (const metadata of [
        { tool: 'devryan_browser', errorCode, failureText: 'opaque' },
        { tool: 'devryan_browser', failureText: `${errorCode}: malformed browser inspection` },
      ]) {
        expect(classifyDiagnosticFailure({ action: 'tool.failed', metadata })).toEqual({
          impact: 'low',
          source: 'observed',
          failureClass: 'input',
          disposition: 'expected',
        });
      }
    },
  );

  it.each([
    ['DEVRYAN_BROWSER_LEASE_ACQUIRE_FAILED', 'upstream 503'],
    ['DEVRYAN_BROWSER_CONNECTION_FAILED', 'connection closed'],
    ['DEVRYAN_BROWSER_CLEANUP_FAILED', 'process did not exit'],
    ['DEVRYAN_BROWSER_COMMAND_FAILED', 'unknown browser command'],
    ['DEVRYAN_BROWSER_COMMAND_FAILED', "Agent browser command failed: ✗ Evaluation error: TypeError: Failed to execute 'getComputedStyle' on 'Window': parameter 1 is not of type 'Element'."],
  ])('retains runtime classification for %s without the explicit input code', (errorCode, detail) => {
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: { tool: 'devryan_browser', errorCode, failureText: `${errorCode}: ${detail}` },
    })).toEqual({
      impact: 'medium',
      source: 'observed',
      failureClass: 'integration_runtime',
      disposition: 'actionable',
    });
  });

  it.each([
    { failureText: 'DEVRYAN_BROWSER_COMMAND_FAILED: DEVRYAN_BROWSER_EVAL_ERROR: TypeError: unexpected failure' },
    { failureText: 'Tool output mentioned DEVRYAN_BROWSER_EVAL_ERROR: TypeError: unexpected failure' },
    { failureText: 'Error: DEVRYAN_BROWSER_EVAL_ERROR: TypeError: unexpected failure' },
    { failureText: 'DEVRYAN_BROWSER_EVAL_ERROR_EXTRA: unexpected failure' },
    { failureText: 'DEVRYAN_BROWSER_EVAL_ERROR unexpected failure' },
    { failureText: 'DEVRYAN_BROWSER_INPUT_INVALID_EXTRA: unexpected failure' },
    { errorCode: 'DEVRYAN_BROWSER_CONNECTION_FAILED', failureText: 'DEVRYAN_BROWSER_EVAL_ERROR: TypeError: unexpected failure' },
    { errorCode: 'lineage_unavailable', failureText: 'DEVRYAN_BROWSER_INPUT_INVALID: rejected selector' },
    { errorCode: 503, failureText: 'DEVRYAN_BROWSER_EVAL_ERROR: TypeError: unexpected failure' },
  ])('does not let embedded codes or a string prefix override structured runtime codes: %j', (metadata) => {
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: { tool: 'devryan_browser', ...metadata },
    })).toMatchObject({ impact: 'medium', failureClass: 'integration_runtime', disposition: 'actionable' });
  });

  it.each(['DEVRYAN_BROWSER_EVAL_ERROR', 'DEVRYAN_BROWSER_INPUT_INVALID'])(
    'keeps the final lease touch actionable when it also reports %s',
    (secondaryCode) => {
      const errorCode = 'DEVRYAN_BROWSER_LEASE_TOUCH_FAILED';
      const failureText = `${errorCode}: browser host unavailable\nBrowser command also failed: ${secondaryCode}: Invalid input: selector is required`;
      for (const fields of [{ errorCode, failureText }, { failureText }]) {
        expect(classifyDiagnosticFailure({
          action: 'tool.failed',
          metadata: { tool: 'devryan_browser', ...fields },
        })).toEqual({
          impact: 'medium',
          source: 'observed',
          failureClass: 'integration_runtime',
          disposition: 'actionable',
        });
      }
    },
  );

  it.each([
    { tool: 'devryan_browser', failureText: 'DEVRYAN_BROWSER_LEASE_TOUCH_FAILED_EXTRA: Invalid input' },
    { tool: 'devryan_browser', failureText: 'Invalid input: output mentioned DEVRYAN_BROWSER_LEASE_TOUCH_FAILED: unavailable' },
    { tool: 'devryan_browser', errorCode: 'DEVRYAN_BROWSER_INPUT_INVALID', failureText: 'DEVRYAN_BROWSER_LEASE_TOUCH_FAILED: Invalid input' },
    { tool: 'read', errorCode: 'DEVRYAN_BROWSER_LEASE_TOUCH_FAILED', failureText: 'Invalid input' },
    { tool: 'read', failureText: 'DEVRYAN_BROWSER_LEASE_TOUCH_FAILED: Invalid input' },
  ])('does not apply touch-failure precedence to another code or tool: %j', (metadata) => {
    expect(classifyDiagnosticFailure({ action: 'tool.failed', metadata }))
      .toMatchObject({ impact: 'low', failureClass: 'input', disposition: 'expected' });
  });

  it.each(['TypeError: Invalid input', 'TypeError: missing selector'])(
    'keeps explicit generated-inspection failures actionable despite misleading detail: %s',
    (detail) => {
      const errorCode = 'DEVRYAN_BROWSER_INSPECTION_FAILED';
      const failureText = `${errorCode}: Agent browser command failed: ✗ Evaluation error: ${detail}`;
      for (const fields of [{ errorCode, failureText }, { failureText }]) {
        expect(classifyDiagnosticFailure({
          action: 'tool.failed',
          metadata: { tool: 'devryan_browser', ...fields },
        })).toEqual({
          impact: 'medium',
          source: 'observed',
          failureClass: 'integration_runtime',
          disposition: 'actionable',
        });
      }
    },
  );

  it.each([
    { tool: 'devryan_browser', failureText: 'DEVRYAN_BROWSER_INSPECTION_FAILED_EXTRA: Invalid input' },
    { tool: 'devryan_browser', failureText: 'Invalid input: output mentioned DEVRYAN_BROWSER_INSPECTION_FAILED: defect' },
    { tool: 'devryan_browser', errorCode: 'DEVRYAN_BROWSER_INPUT_INVALID', failureText: 'DEVRYAN_BROWSER_INSPECTION_FAILED: Invalid input' },
    { tool: 'read', errorCode: 'DEVRYAN_BROWSER_INSPECTION_FAILED', failureText: 'Invalid input' },
    { tool: 'read', failureText: 'DEVRYAN_BROWSER_INSPECTION_FAILED: Invalid input' },
  ])('does not apply inspection-failure precedence to another code or tool: %j', (metadata) => {
    expect(classifyDiagnosticFailure({ action: 'tool.failed', metadata }))
      .toMatchObject({ impact: 'low', failureClass: 'input', disposition: 'expected' });
  });

  it('leaves historical inspection-code inference on its existing browser default', () => {
    expect(inferLegacyDiagnostic({
      action: 'tool.failed',
      metadata: {
        tool: 'devryan_browser',
        errorCode: 'DEVRYAN_BROWSER_INSPECTION_FAILED',
        failureText: 'DEVRYAN_BROWSER_INSPECTION_FAILED: TypeError: Invalid input',
      },
    })).toMatchObject({ impact: 'medium', source: 'inferred', disposition: 'actionable' });
  });

  it.each(['DEVRYAN_BROWSER_EVAL_ERROR', 'DEVRYAN_BROWSER_INPUT_INVALID'])(
    'does not apply browser-only code %s to other tools or historical inference',
    (errorCode) => {
      for (const errorFields of [{ errorCode, failureText: 'opaque' }, { failureText: `${errorCode}: opaque` }]) {
        expect(classifyDiagnosticFailure({
          action: 'tool.failed',
          metadata: { tool: 'mcp__connector__lookup', ...errorFields },
        })).toMatchObject({ impact: 'medium', disposition: 'actionable' });
        expect(inferLegacyDiagnostic({
          action: 'tool.failed',
          metadata: { tool: 'devryan_browser', ...errorFields },
        })).toMatchObject({ impact: 'medium', source: 'inferred', disposition: 'actionable' });
      }
    },
  );

  it('classifies the benign ResizeObserver notification as expected client noise', () => {
    expect(classifyDiagnosticFailure({
      action: 'client.error',
      metadata: {
        source: 'window_error',
        failureText: 'ResizeObserver loop completed with undelivered notifications.',
      },
    })).toEqual({
      impact: 'low',
      source: 'observed',
      failureClass: 'client_runtime',
      disposition: 'expected',
    });
  });

  it.each([
    [
      'ctx_execute',
      '```javascript\nrunVitest()\n```\n\nExit code: 1\n\nstdout:\nTests 2 failed | 58 passed',
    ],
    [
      'ctx_batch_execute',
      'Command exited with status 2\nstdout:\nvalidation failed',
    ],
  ])('classifies downstream command exits from %s as low impact', (tool, failureText) => {
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: { tool, failureText },
    })).toEqual({
      impact: 'low',
      source: 'observed',
      failureClass: 'command_exit',
      disposition: 'expected',
    });
  });

  it('keeps Context Mode infrastructure failures medium even when a nested process exits', () => {
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: { tool: 'ctx_execute', failureText: 'disk I/O error\nExit code: 1' },
    })).toEqual({
      impact: 'medium',
      source: 'observed',
      failureClass: 'tool_runtime',
      disposition: 'actionable',
    });
  });

  it('classifies malformed search regexes as expected input failures', () => {
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: {
        tool: 'rg',
        failureText: 'regex parse error:\n    (?:foo\n    ^\nerror: unclosed group',
      },
    })).toEqual({
      impact: 'low',
      source: 'observed',
      failureClass: 'input',
      disposition: 'expected',
    });
  });

  it('classifies only targeted ripgrep execution failures as expected filesystem misses', () => {
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: {
        tool: 'grep',
        failureText: 'ripgrep execution failed',
        paths: ['<WORKTREE>/scripts/missing.test.ts'],
      },
    })).toEqual({
      impact: 'low',
      source: 'observed',
      failureClass: 'filesystem_target',
      disposition: 'expected',
    });
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: { tool: 'rg', failureText: 'ripgrep execution failed' },
    })).toEqual({
      impact: 'medium',
      source: 'observed',
      failureClass: 'unknown',
      disposition: 'actionable',
    });
  });

  it('classifies an unavailable browser target before the browser runtime wrapper', () => {
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: {
        tool: 'devryan_browser',
        failureText: 'DEVRYAN_BROWSER_COMMAND_FAILED: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3101',
      },
    })).toEqual({
      impact: 'low',
      source: 'observed',
      failureClass: 'integration_runtime',
      disposition: 'expected',
    });
  });

  it.each([
    [
      'skill',
      'The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules [{"permission":"skill","pattern":"*","action":"deny"}]',
    ],
    [
      'devryan_browser',
      'DEVRYAN_BROWSER_INPUT_INVALID: open requires a URL because this branch has no configured preview',
    ],
    [
      'devryan_browser',
      'DEVRYAN_BROWSER_COMMAND_FAILED: Agent browser command failed: ✗ Operation timed out',
    ],
    [
      'devryan_browser',
      'DEVRYAN_BROWSER_COMMAND_FAILED: Agent browser command failed: ✗ Navigation failed: net::ERR_NAME_NOT_RESOLVED at /admin/support/live-chat/team-settings',
    ],
  ])('classifies observed audit noise from %s as expected input', (tool, failureText) => {
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: { tool, failureText },
    })).toEqual({
      impact: 'low',
      source: 'observed',
      failureClass: 'input',
      disposition: 'expected',
    });
  });

  it('keeps branch preview authentication failures actionable', () => {
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: {
        tool: 'devryan_browser',
        failureText: 'DEVRYAN_BROWSER_BRANCH_PREVIEW_AUTH_FAILED: Cloudflare Access rejected the branch preview service token',
      },
    })).toEqual({
      impact: 'medium',
      source: 'observed',
      failureClass: 'integration_runtime',
      disposition: 'actionable',
    });
  });

  it.each([
    ['devryan_browser', 'Could not locate element "Submit" in the current page', 'input'],
    ['webfetch', 'Request failed with status code: 404', 'integration_runtime'],
    ['glob', 'stdout maxBuffer length exceeded', 'input'],
    ['search', 'Search process failed: stdout maxBuffer length exceeded', 'input'],
  ])('classifies recovered target/input outcome from %s as expected', (tool, failureText, failureClass) => {
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: { tool, failureText },
    })).toEqual({
      impact: 'low',
      source: 'observed',
      failureClass,
      disposition: 'expected',
    });
  });

  it('keeps managed dispatch parent-verification failures actionable', () => {
    expect(classifyDiagnosticFailure({
      action: 'managed_task.failed',
      metadata: { failureText: 'Managed task parent message could not be verified' },
    })).toEqual({
      impact: 'high',
      source: 'observed',
      failureClass: 'managed_task',
      disposition: 'actionable',
    });
  });

  it.each([
    ['ctx_execute', 'disk I/O error', 'tool_runtime'],
    ['ctx_execute_file', 'database is locked', 'tool_runtime'],
    ['devryan_browser', 'DEVRYAN_BROWSER_LEASE_ACQUIRE_FAILED: upstream 503', 'integration_runtime'],
    ['mcp__connector__lookup', 'connector unavailable', 'integration_runtime'],
    ['custom_managed_tool', 'unexpected runtime failure', 'unknown'],
  ])('classifies retryable runtime tool %s as medium impact', (tool, failureText, failureClass) => {
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: { tool, failureText },
    })).toEqual({
      impact: 'medium',
      source: 'observed',
      failureClass,
      disposition: 'actionable',
    });
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

  it('uses the shared transport classifier when session retryability is absent', () => {
    expect(classifyDiagnosticFailure({
      action: 'session.error',
      metadata: { errorName: 'UnknownError', failureText: 'The operation timed out.' },
    })).toMatchObject({
      impact: 'medium',
      failureClass: 'session_runtime',
      disposition: 'actionable',
    });
    expect(classifyDiagnosticFailure({
      action: 'session.error',
      metadata: {
        errorName: 'UnknownError',
        failureText: 'The operation timed out.',
        retryable: false,
      },
    })).toMatchObject({ impact: 'high', failureClass: 'session_runtime' });
  });

  it('treats recoverable child transport attempts as expected but keeps root and terminal failures actionable', () => {
    const transport = {
      errorName: 'UnknownError',
      failureText: 'Streaming response failed: [504] Upstream idle timeout exceeded',
    };
    expect(classifyDiagnosticFailure({
      action: 'session.error',
      metadata: { ...transport, rootSessionId: 'root', childSessionId: 'child' },
    })).toMatchObject({ impact: 'low', disposition: 'expected' });
    expect(classifyDiagnosticFailure({
      action: 'session.error',
      metadata: { ...transport, rootSessionId: 'root' },
    })).toMatchObject({ impact: 'medium', disposition: 'actionable' });
    expect(classifyDiagnosticFailure({
      action: 'session.error',
      metadata: { ...transport, rootSessionId: 'root', childSessionId: 'child', retryable: false },
    })).toMatchObject({ impact: 'high', disposition: 'actionable' });
    expect(classifyDiagnosticFailure({
      action: 'managed_task.failed',
      metadata: { ...transport, rootSessionId: 'root', childSessionId: 'child' },
    })).toMatchObject({ impact: 'high', disposition: 'actionable' });
  });

  it('treats a completed managed task retry as expected input misuse', () => {
    const classification = classifyDiagnosticFailure({
      action: 'managed_task.failed',
      metadata: {
        errorCode: 'DEVRYAN_TOOL_INPUT_INVALID',
        failureText: 'Retry is unavailable after a successfully completed task; use action: "continue".',
      },
    });

    expect(classification).toEqual({
      impact: 'low',
      source: 'observed',
      failureClass: 'input',
      disposition: 'expected',
    });
    expect(inferLegacyDiagnostic({
      action: 'managed_task.failed',
      metadata: { failureText: 'Retry cannot be used because the task completed successfully; use the continue action.' },
    })).toMatchObject({ impact: 'low', disposition: 'expected' });
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
      .toEqual({
        impact: 'critical',
        source: 'observed',
        failureClass: 'platform_security',
        disposition: 'actionable',
      });
    expect(classifyDiagnosticFailure({ action: 'platform.integrity_failed' }))
      .toEqual({
        impact: 'critical',
        source: 'observed',
        failureClass: 'platform_integrity',
        disposition: 'actionable',
      });
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: { tool: 'read', failureText: 'platform.integrity_failed critical breach' },
    }).impact).toBe('medium');
  });

  it.each([
    ['read', 'EISDIR: illegal operation on a directory', 'filesystem_target'],
    ['grep', 'JSON record exceeds 65,536 byte limit', 'input'],
    ['grep', 'Tool was denied by policy', 'input'],
    ['devryan_browser', 'Browser element submit was not found', 'input'],
    ['webfetch', 'HTTP 404 for requested target', 'integration_runtime'],
    ['devryan_task', 'DEVRYAN_TOOL_INPUT_INVALID: Required next action is continue', 'input'],
  ])('marks the expected operational outcome for %s as non-actionable', (tool, failureText, failureClass) => {
    expect(classifyDiagnosticFailure({
      action: 'tool.failed',
      metadata: { tool, failureText },
    })).toMatchObject({
      impact: 'low',
      failureClass,
      disposition: 'expected',
    });
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
