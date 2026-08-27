import os from 'node:os';
import { describe, expect, it } from 'vitest';

import { createDiagnosticSanitizer } from '@openchamber/harness-runtime';

import { CONTEXT_MODE_WEDGE_FAILURE_TEXT } from '../opencode/context-mode-recovery.js';
import {
  ERROR_CONTEXT_TEXT_LIMIT_BYTES,
  ERROR_STACK_TEXT_LIMIT_BYTES,
  isProjectableOpenCodeActivity,
  projectOpenCodeActivity,
} from './activity-projection.js';

const ownership = {
  session_id: 'session-1',
  user_id: 'user-1',
  project_id: 'project-1',
  branch_name: 'developer',
};
const assignment = {
  publicDirectory: '/projects/project-1/developer',
  repositoryPath: '/private/worktrees/project-1/user-1/developer',
};

describe('OpenCode activity projection', () => {
  it('keeps only tool identity, state, and project-relative paths', () => {
    const projected = projectOpenCodeActivity({
      ownership,
      assignment,
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-1',
            type: 'tool',
            tool: 'write',
            sessionID: 'session-1',
            state: {
              status: 'completed',
              input: {
                path: '/private/worktrees/project-1/user-1/developer/src/index.ts',
                content: 'must never be retained',
                command: 'must never be retained',
              },
              output: 'must never be retained',
            },
          },
        },
      },
    });

    expect(projected).toEqual({
      dedupeKey: 'tool:session-1:part-1:completed',
      action: 'tool.completed',
      details: {
        targetType: 'tool',
        targetId: 'part-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        success: true,
        metadata: { tool: 'write', status: 'completed', branch: 'developer', paths: ['src/index.ts'] },
      },
    });
    expect(JSON.stringify(projected)).not.toContain('must never be retained');
  });

  it('rejects host paths outside the assignment and foreign sessions', () => {
    const outside = projectOpenCodeActivity({
      ownership,
      assignment,
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-2',
            type: 'tool',
            tool: 'read',
            sessionID: 'session-1',
            state: { status: 'running', input: { path: '/etc/passwd' } },
          },
        },
      },
    });
    expect(outside?.details.metadata).not.toHaveProperty('paths');

    expect(
      projectOpenCodeActivity({
        ownership,
        assignment,
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part-3',
              type: 'tool',
              tool: 'read',
              sessionID: 'session-other',
              state: { status: 'running' },
            },
          },
        },
      }),
    ).toBeNull();
  });

  it('projects diff events as path-only summaries', () => {
    const projected = projectOpenCodeActivity({
      ownership,
      assignment,
      payload: {
        type: 'session.diff',
        properties: {
          sessionID: 'session-1',
          diff: [{ file: 'src/a.ts', before: 'secret before', after: 'secret after' }],
        },
      },
    });
    expect(projected?.details.metadata.paths).toEqual(['src/a.ts']);
    expect(JSON.stringify(projected)).not.toContain('secret');
  });

  it('classifies errors before ownership work and ignores deltas and intentional aborts', () => {
    expect(isProjectableOpenCodeActivity({ type: 'message.part.delta', properties: {} })).toBe(false);
    expect(
      isProjectableOpenCodeActivity({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-aborted',
            type: 'tool',
            tool: 'apply_patch',
            state: { status: 'error', error: 'Tool execution aborted' },
          },
        },
      }),
    ).toBe(false);
    expect(
      isProjectableOpenCodeActivity({
        type: 'session.error',
        properties: { sessionID: 'session-1', error: { name: 'MessageAbortedError' } },
      }),
    ).toBe(false);
    expect(
      isProjectableOpenCodeActivity({
        type: 'openchamber:managed-task',
        properties: { owner: 'devryan', task: { owner: 'devryan', status: 'aborted' } },
      }),
    ).toBe(false);
    expect(
      isProjectableOpenCodeActivity({
        type: 'session.error',
        properties: { sessionID: 'session-1', error: { name: 'APIError' } },
      }),
    ).toBe(true);
  });

  it('does not project exact tool-abort boilerplate but preserves unrelated tool errors', () => {
    const payloadFor = (error) => ({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-failure',
          type: 'tool',
          tool: 'apply_patch',
          sessionID: 'session-1',
          state: { status: 'error', error },
        },
      },
    });

    expect(projectOpenCodeActivity({ ownership, payload: payloadFor({ message: 'Tool execution aborted.' }) }))
      .toBeNull();
    expect(projectOpenCodeActivity({ ownership, payload: payloadFor('Patch command crashed') }))
      .toMatchObject({ action: 'tool.failed' });
  });

  it('records normalized transport failure kind for session errors', () => {
    const projected = projectOpenCodeActivity({
      ownership,
      context: { rootSessionId: 'session-1' },
      payload: {
        type: 'session.error',
        properties: {
          sessionID: 'session-1',
          error: { name: 'UnknownError', data: { message: 'The operation timed out.' } },
        },
      },
    });

    expect(projected).toMatchObject({
      action: 'session.error',
      details: {
        diagnosticImpact: 'medium',
        diagnosticDisposition: 'actionable',
        metadata: { failureKind: 'request_timeout' },
      },
    });
  });

  it('canonicalizes paired session-error wrapper and stack variants for correlation', () => {
    const signatures = [];
    const correlateSessionError = ({ signature }) => {
      signatures.push(signature);
      return '11111111-1111-5111-8111-111111111111';
    };
    const project = (message, errorName = 'UnknownError') => projectOpenCodeActivity({
      ownership,
      context: { rootSessionId: 'session-1', correlateSessionError, observedAt: 1_000 },
      payload: {
        type: 'session.error',
        properties: {
          sessionID: 'session-1',
          error: { name: errorName, data: { message } },
        },
      },
    });

    const simple = project('Model not found: opencode/retired-model');
    const stacked = project(
      '%s: UnknownError: ProviderModelNotFoundError: Model not found: opencode/retired-model\n    at SessionPrompt.getModel',
      'ProviderModelNotFoundError',
    );

    expect(signatures).toHaveLength(2);
    expect(signatures[0]).toBe(signatures[1]);
    expect(simple.details.eventId).toBe(stacked.details.eventId);
  });

  it('projects a retry-capable child 504 idle timeout as expected stream interruption', () => {
    const projected = projectOpenCodeActivity({
      ownership,
      context: { rootSessionId: 'session-root' },
      payload: {
        type: 'session.error',
        properties: {
          sessionID: 'session-1',
          error: {
            name: 'UnknownError',
            data: { message: 'Streaming response failed: [504] Upstream idle timeout exceeded' },
          },
        },
      },
    });

    expect(projected).toMatchObject({
      action: 'session.error',
      details: {
        diagnosticImpact: 'low',
        diagnosticDisposition: 'expected',
        metadata: {
          rootSessionId: 'session-root',
          childSessionId: 'session-1',
          failureKind: 'stream_idle_timeout',
        },
      },
    });
  });

  it('projects failed tools without output and with a deterministic sanitized event id', () => {
    const payload = {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-failed',
          messageID: 'message-1',
          callID: 'call-1',
          type: 'tool',
          tool: 'bash',
          sessionID: 'session-1',
          state: {
            status: 'error',
            input: { command: 'do not retain this command' },
            output: 'do not retain this output',
            error: {
              code: 'DEVRYAN_TOOL_INPUT_INVALID',
              message: 'Failed at /private/secret with token super-secret',
            },
          },
        },
      },
    };
    const options = {
      ownership,
      payload,
      context: {
        rootSessionId: 'session-root',
        message: { messageId: 'message-1', providerId: 'openai', modelId: 'gpt-5', agent: 'build' },
      },
      sanitizeFailureText: (value) =>
        value.replace('/private/secret', '<WORKTREE>').replace('super-secret', '[REDACTED]'),
    };
    const projected = projectOpenCodeActivity(options);
    const replayed = projectOpenCodeActivity(options);

    expect(projected).toMatchObject({
      dedupeKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      action: 'tool.failed',
      details: {
        eventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        success: false,
        diagnosticImpact: 'low',
        diagnosticDisposition: 'expected',
        metadata: {
          kind: 'tool',
          tool: 'bash',
          toolId: 'part-failed',
          messageId: 'message-1',
          callId: 'call-1',
          rootSessionId: 'session-root',
          childSessionId: 'session-1',
          providerId: 'openai',
          modelId: 'gpt-5',
          agent: 'build',
          errorCode: 'DEVRYAN_TOOL_INPUT_INVALID',
          failureClass: 'input',
          failureText: 'Failed at <WORKTREE> with token [REDACTED]',
        },
      },
    });
    expect(projected.dedupeKey).toBe(projected.details.eventId);
    expect(replayed.details.eventId).toBe(projected.details.eventId);
    expect(JSON.stringify(projected)).not.toContain('do not retain');
  });

  it('projects targeted ripgrep failures as expected with only sanitized paths retained', () => {
    const projected = projectOpenCodeActivity({
      ownership,
      assignment: {
        publicDirectory: '/workspace',
        repositoryPath: '/workspace',
      },
      context: { rootSessionId: 'session-1', activeDirectory: '/workspace' },
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-ripgrep',
            type: 'tool',
            tool: 'grep',
            sessionID: 'session-1',
            state: {
              status: 'error',
              input: { path: '/workspace/scripts/missing.test.ts', pattern: 'do not retain this pattern' },
              error: 'ripgrep execution failed',
            },
          },
        },
      },
    });

    expect(projected).toMatchObject({
      details: {
        diagnosticImpact: 'low',
        diagnosticDisposition: 'expected',
        metadata: {
          failureClass: 'filesystem_target',
          paths: ['scripts/missing.test.ts'],
        },
      },
    });
    expect(JSON.stringify(projected)).not.toContain('do not retain this pattern');
  });

  it('projects nested Context Mode command exits as low impact with correlation intact', () => {
    const projected = projectOpenCodeActivity({
      ownership,
      context: {
        rootSessionId: 'session-1',
        message: { messageId: 'message-command-exit', providerId: 'openai', modelId: 'gpt-5', agent: 'builder' },
      },
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-command-exit',
            messageID: 'message-command-exit',
            callID: 'call-command-exit',
            type: 'tool',
            tool: 'ctx_execute',
            sessionID: 'session-1',
            state: {
              status: 'error',
              input: { code: 'do not retain this command' },
              error: 'Exit code: 1\n\nstdout:\nTests 2 failed | 58 passed',
            },
          },
        },
      },
    });

    expect(projected).toMatchObject({
      action: 'tool.failed',
      details: {
        diagnosticImpact: 'low',
        diagnosticSource: 'observed',
        metadata: {
          tool: 'ctx_execute',
          toolId: 'part-command-exit',
          callId: 'call-command-exit',
          messageId: 'message-command-exit',
          failureClass: 'command_exit',
          failureText: 'Exit code: 1\n\nstdout:\nTests 2 failed | 58 passed',
        },
      },
    });
    expect(JSON.stringify(projected)).not.toContain('do not retain this command');
  });

  it('sanitizes and relativizes missing targets against the authoritative active worktree', () => {
    const activeDirectory = `${os.homedir()}/.local/share/opencode/worktree/a91f247c`;
    const missingTargets = [
      `${activeDirectory}/src/components/SupportWidget/SupportWidget.test.tsx`,
      `${activeDirectory}/src/supabase/functions/_shared/browser-contract.ts`,
    ];
    const sanitizer = createDiagnosticSanitizer({ homeDir: os.homedir() });
    sanitizer.addWorktreeRoot(activeDirectory);

    for (const [index, missingTarget] of missingTargets.entries()) {
      const projected = projectOpenCodeActivity({
        ownership,
        assignment,
        context: { activeDirectory, rootSessionId: 'session-1' },
        sanitizeFailureText: (value) => sanitizer.sanitizeText(value),
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: `part-missing-${index}`,
              type: 'tool',
              tool: 'read',
              sessionID: 'session-1',
              state: {
                status: 'error',
                input: { path: missingTarget },
                error: `ENOENT: no such file or directory, open '${missingTarget}'`,
              },
            },
          },
        },
      });

      expect(projected.details).toMatchObject({
        diagnosticImpact: 'low',
        diagnosticSource: 'observed',
        metadata: {
          failureClass: 'filesystem_target',
          paths: [missingTarget.slice(activeDirectory.length + 1)],
        },
      });
      expect(projected.details.metadata.failureText).toMatch(/^ENOENT:.*<WORKTREE_[A-Fa-f0-9]{12}>\//);
      expect(projected.details.metadata.failureText).not.toContain(os.homedir());
      expect(projected.details.metadata.failureText).not.toContain('<HOME>/.');
    }
  });

  it('captures only allowlisted session error fields and bounds failure text to 8 KiB', () => {
    const projected = projectOpenCodeActivity({
      ownership,
      context: {
        rootSessionId: 'session-1',
        message: { messageId: 'message-2', providerId: 'anthropic', modelId: 'claude', agent: 'review' },
      },
      sanitizeFailureText: (value) => value.replace('secret-token', '[REDACTED]'),
      payload: {
        type: 'session.error',
        properties: {
          sessionID: 'session-1',
          error: {
            name: 'APIError',
            data: {
              message: `${'🙂'.repeat(4_000)} secret-token`,
              statusCode: 503,
              isRetryable: false,
              responseHeaders: { authorization: 'do not retain' },
              responseBody: 'do not retain',
            },
          },
        },
      },
    });

    expect(projected).toMatchObject({
      action: 'session.error',
      details: {
        success: false,
        metadata: {
          kind: 'session',
          errorName: 'APIError',
          statusCode: 503,
          retryable: false,
          messageId: 'message-2',
          providerId: 'anthropic',
          modelId: 'claude',
          agent: 'review',
        },
      },
    });
    expect(Buffer.byteLength(projected.details.metadata.failureText, 'utf8')).toBeLessThanOrEqual(
      ERROR_CONTEXT_TEXT_LIMIT_BYTES,
    );
    expect(JSON.stringify(projected)).not.toContain('responseHeaders');
    expect(JSON.stringify(projected)).not.toContain('responseBody');
    expect(JSON.stringify(projected)).not.toContain('do not retain');
  });

  it('captures sanitized stacks for session and tool failures and bounds them to 16 KiB', () => {
    const sessionProjection = projectOpenCodeActivity({
      ownership,
      context: { rootSessionId: 'session-1' },
      sanitizeFailureText: (value) => value.replace('secret-token', '[REDACTED]'),
      payload: {
        type: 'session.error',
        properties: {
          sessionID: 'session-1',
          error: {
            name: 'APIError',
            message: 'Provider rejected the request',
            stack: `APIError: Provider rejected the request\n    at call (file.js:1:1) secret-token\n${'    at frame (file.js:1:1)\n'.repeat(2_000)}`,
          },
        },
      },
    });

    expect(sessionProjection.details.metadata.stack).toContain('[REDACTED]');
    expect(sessionProjection.details.metadata.stack).not.toContain('secret-token');
    expect(Buffer.byteLength(sessionProjection.details.metadata.stack, 'utf8')).toBeLessThanOrEqual(
      ERROR_STACK_TEXT_LIMIT_BYTES,
    );

    const toolProjection = projectOpenCodeActivity({
      ownership,
      context: { rootSessionId: 'session-1' },
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-stack',
            type: 'tool',
            tool: 'bash',
            sessionID: 'session-1',
            state: {
              status: 'error',
              error: { message: 'Command failed', stack: 'Error: Command failed\n    at run (bash.js:2:2)' },
            },
          },
        },
      },
    });

    expect(toolProjection.details.metadata).toMatchObject({
      failureText: 'Command failed',
      stack: 'Error: Command failed\n    at run (bash.js:2:2)',
    });
  });

  it('excludes recoverable managed failures until abandoned and excludes successful retries', () => {
    const task = {
      owner: 'devryan',
      taskId: 'dvr_task_1',
      rootSessionId: 'session-1',
      childSessionId: 'session-child',
      sequence: 1,
      status: 'failed',
      attempt: 1,
      executionKind: 'start',
      failureReason: 'Provider disconnected',
      agentRetryAvailable: true,
    };
    const payload = { type: 'openchamber:managed-task', properties: { owner: 'devryan', task } };
    expect(isProjectableOpenCodeActivity(payload)).toBe(false);
    expect(projectOpenCodeActivity({ payload, ownership })).toBeNull();

    const retrying = {
      ...payload,
      properties: { ...payload.properties, resultEnvelope: { action: 'retry' } },
    };
    expect(isProjectableOpenCodeActivity(retrying)).toBe(false);

    const abandoned = {
      ...payload,
      properties: { ...payload.properties, resultEnvelope: { action: 'abandon' } },
    };
    expect(projectOpenCodeActivity({ payload: abandoned, ownership })).toMatchObject({
      action: 'managed_task.failed',
      details: {
        success: false,
        metadata: {
          taskId: 'dvr_task_1',
          childSessionId: 'session-child',
          failureText: 'Provider disconnected',
        },
      },
    });

    const recovered = {
      ...payload,
      properties: {
        ...payload.properties,
        task: { ...task, status: 'completed', attempt: 2, agentRetryAvailable: false },
      },
    };
    expect(isProjectableOpenCodeActivity(recovered)).toBe(false);
  });

  it('captures an exhausted retry with deterministic task and lineage context', () => {
    const payload = {
      type: 'openchamber:managed-task',
      properties: {
        owner: 'devryan',
        task: {
          owner: 'devryan',
          taskId: 'dvr_task_2',
          priorTaskId: 'dvr_task_1',
          rootSessionId: 'session-1',
          childSessionId: 'session-child-2',
          sequence: 2,
          status: 'interrupted',
          attempt: 2,
          executionKind: 'retry',
          providerId: 'openai',
          modelId: 'gpt-5',
          agent: 'worker',
          failureReason: 'Connection ended',
          failureKind: 'provider_transport',
          agentRetryAvailable: false,
          partial: true,
        },
      },
    };
    const projected = projectOpenCodeActivity({ payload, ownership });
    const replayed = projectOpenCodeActivity({ payload, ownership });

    expect(projected).toMatchObject({
      action: 'managed_task.failed',
      details: {
        eventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        metadata: {
          taskId: 'dvr_task_2',
          priorTaskId: 'dvr_task_1',
          attempt: 2,
          executionKind: 'retry',
          failureKind: 'provider_transport',
          partial: true,
        },
      },
    });
    expect(replayed.details.eventId).toBe(projected.details.eventId);
  });

  it('rewrites context-mode disk I/O failures to stable wedge copy', () => {
    const projected = projectOpenCodeActivity({
      ownership,
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-ctx-ioerr',
            type: 'tool',
            tool: 'ctx_batch_execute',
            sessionID: 'session-1',
            state: {
              status: 'error',
              error: 'Batch execution error: disk I/O error',
            },
          },
        },
      },
    });

    expect(projected).toMatchObject({
      action: 'tool.failed',
      details: {
        diagnosticImpact: 'medium',
        diagnosticSource: 'observed',
        metadata: {
          tool: 'ctx_batch_execute',
          failureClass: 'tool_runtime',
          failureText: CONTEXT_MODE_WEDGE_FAILURE_TEXT,
        },
      },
    });
    expect(projected.details.metadata.failureText).toMatch(/SQLITE_IOERR/);
    expect(Buffer.byteLength(projected.details.metadata.failureText, 'utf8')).toBeLessThanOrEqual(
      ERROR_CONTEXT_TEXT_LIMIT_BYTES,
    );
  });
});
