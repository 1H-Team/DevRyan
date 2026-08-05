import { describe, expect, it } from 'vitest';

import { projectOpenCodeActivity } from './activity-projection.js';

const ownership = {
  session_id: 'session-1', user_id: 'user-1', project_id: 'project-1', branch_name: 'developer',
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
            id: 'part-2', type: 'tool', tool: 'read', sessionID: 'session-1',
            state: { status: 'running', input: { path: '/etc/passwd' } },
          },
        },
      },
    });
    expect(outside?.details.metadata).not.toHaveProperty('paths');

    expect(projectOpenCodeActivity({
      ownership,
      assignment,
      payload: {
        type: 'message.part.updated',
        properties: {
          part: { id: 'part-3', type: 'tool', tool: 'read', sessionID: 'session-other', state: { status: 'running' } },
        },
      },
    })).toBeNull();
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
});
