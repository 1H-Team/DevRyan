import { describe, expect, it } from 'vitest';

import {
  synthesizeToolTitle,
  toV1ToolInput,
  toV1ToolMetadata,
  toV1ToolName,
  toV1ToolPart,
  toV1ToolState,
  toV2ToolInput,
  toV2ToolMetadata,
  toV2ToolName,
} from './tools.js';

const context = { messageID: 'msg_01', sessionID: 'ses_01' };

const fileDiff = {
  file: 'src/a.ts',
  patch: '@@ -1 +1 @@\n-a\n+b',
  additions: 1,
  deletions: 1,
  status: 'modified',
};

describe('tool names', () => {
  it.each([
    ['shell', 'bash'],
    ['subagent', 'task'],
    ['patch', 'apply_patch'],
  ])('maps %s <-> %s', (v2Name, v1Name) => {
    expect(toV1ToolName(v2Name)).toBe(v1Name);
    expect(toV2ToolName(v1Name)).toBe(v2Name);
  });

  it('passes other and already-translated names through', () => {
    for (const name of ['read', 'edit', 'write', 'glob', 'grep', 'skill', 'todowrite', 'mcp_x']) {
      expect(toV1ToolName(name)).toBe(name);
      expect(toV2ToolName(name)).toBe(name);
    }
    expect(toV1ToolName('bash')).toBe('bash');
    expect(toV2ToolName('shell')).toBe('shell');
    expect(toV1ToolName('constructor')).toBe('constructor');
  });
});

describe('input aliases', () => {
  it('adds v1 aliases without removing the v2 keys', () => {
    expect(toV1ToolInput('read', { path: 'a.ts', offset: 1 })).toEqual({ path: 'a.ts', filePath: 'a.ts', offset: 1 });
    expect(toV1ToolInput('edit', { path: 'a.ts', oldString: 'x', newString: 'y' }))
      .toEqual({ path: 'a.ts', filePath: 'a.ts', oldString: 'x', newString: 'y' });
    expect(toV1ToolInput('write', { path: 'a.ts', content: '' })).toEqual({ path: 'a.ts', filePath: 'a.ts', content: '' });
    expect(toV1ToolInput('subagent', { agent: 'fixer', description: 'd', prompt: 'p' }))
      .toEqual({ agent: 'fixer', subagent_type: 'fixer', description: 'd', prompt: 'p' });
    expect(toV1ToolInput('skill', { id: 'pdf' })).toEqual({ id: 'pdf', name: 'pdf' });
  });

  it('keeps the reference when nothing applies and never overwrites v1 keys', () => {
    const grep = { pattern: 'x', path: 'src' };
    expect(toV1ToolInput('grep', grep)).toBe(grep);
    const migrated = { filePath: 'old.ts' };
    expect(toV1ToolInput('read', migrated)).toBe(migrated);
    const both = { path: 'new.ts', filePath: 'old.ts' };
    expect(toV1ToolInput('read', both)).toBe(both);
    expect(toV1ToolInput('read', 'raw')).toBe('raw');
  });

  it('reverses exactly the aliases it adds', () => {
    for (const [name, input] of [
      ['read', { path: 'a.ts', limit: 5 }],
      ['task', { agent: 'fixer', prompt: 'p' }],
      ['skill', { id: 'pdf' }],
    ]) {
      expect(toV2ToolInput(name, toV1ToolInput(name, input))).toEqual(input);
    }
  });

  it('renames pure v1 inputs to v2 keys, preferring an existing v2 value', () => {
    expect(toV2ToolInput('read', { filePath: 'a.ts' })).toEqual({ path: 'a.ts' });
    expect(toV2ToolInput('task', { subagent_type: 'fixer', prompt: 'p' })).toEqual({ agent: 'fixer', prompt: 'p' });
    expect(toV2ToolInput('skill', { name: 'pdf' })).toEqual({ id: 'pdf' });
    expect(toV2ToolInput('edit', { path: 'b.ts', filePath: 'a.ts' })).toEqual({ path: 'b.ts' });
    const bash = { command: 'ls' };
    expect(toV2ToolInput('bash', bash)).toBe(bash);
  });
});

describe('metadata aliases', () => {
  it('mirrors the subagent sessionID as sessionId', () => {
    expect(toV1ToolMetadata('subagent', { sessionID: 'ses_c', status: 'running' }))
      .toEqual({ sessionID: 'ses_c', sessionId: 'ses_c', status: 'running' });
    const empty = {};
    expect(toV1ToolMetadata('task', empty)).toBe(empty);
  });

  it('derives diff and filediff from the first file of edit/write', () => {
    const second = { ...fileDiff, file: 'src/b.ts' };
    expect(toV1ToolMetadata('edit', { files: [fileDiff, second], replacements: 1 })).toEqual({
      files: [fileDiff, second],
      replacements: 1,
      diff: fileDiff.patch,
      filediff: { file: 'src/a.ts', additions: 1, deletions: 1 },
    });
    expect(toV1ToolMetadata('write', { files: [fileDiff] }).filediff)
      .toEqual({ file: 'src/a.ts', additions: 1, deletions: 1 });
  });

  it('leaves other tools and empty file lists untouched', () => {
    const patch = { files: [fileDiff] };
    expect(toV1ToolMetadata('patch', patch)).toBe(patch);
    const none = { files: [] };
    expect(toV1ToolMetadata('edit', none)).toBe(none);
    const existing = { files: [fileDiff], diff: 'kept', filediff: { file: 'kept' } };
    expect(toV1ToolMetadata('edit', existing)).toBe(existing);
  });

  it('reverses the aliases it adds', () => {
    const subagent = { sessionID: 'ses_c', status: 'completed' };
    expect(toV2ToolMetadata('task', toV1ToolMetadata('subagent', subagent))).toEqual(subagent);
    const edit = { files: [fileDiff], replacements: 1 };
    expect(toV2ToolMetadata('edit', toV1ToolMetadata('edit', edit))).toEqual(edit);
    const legacy = { diff: 'x', filediff: { file: 'a' } };
    expect(toV2ToolMetadata('edit', legacy)).toBe(legacy);
    const mismatched = { sessionID: 'a', sessionId: 'b' };
    expect(toV2ToolMetadata('task', mismatched)).toBe(mismatched);
  });
});

describe('synthesizeToolTitle', () => {
  it('prefers description, then command, then path', () => {
    expect(synthesizeToolTitle({ description: 'List files', command: 'ls' })).toBe('List files');
    expect(synthesizeToolTitle({ command: 'ls -la' })).toBe('ls -la');
    expect(synthesizeToolTitle({ path: 'a.ts', filePath: 'a.ts' })).toBe('a.ts');
    expect(synthesizeToolTitle({ path: 'src' })).toBe('src');
    expect(synthesizeToolTitle({ pattern: '*.ts' })).toBeUndefined();
    expect(synthesizeToolTitle(undefined)).toBeUndefined();
  });
});

describe('toV1ToolState', () => {
  const time = { created: 1000, ran: 1100, completed: 1500 };

  it('maps streaming to pending with the raw input text', () => {
    expect(toV1ToolState({ id: 'c1', name: 'shell', time: { created: 1000 }, state: { status: 'streaming', input: '{"comm' } }, context))
      .toEqual({ status: 'pending', input: {}, raw: '{"comm' });
  });

  it('maps running with aliases, metadata and a synthesized title', () => {
    expect(toV1ToolState({
      id: 'c1',
      name: 'subagent',
      time: { created: 1000, ran: 1100 },
      state: { status: 'running', input: { agent: 'fixer', description: 'Fix it', prompt: 'p' }, metadata: { sessionID: 'ses_c' } },
    }, context)).toEqual({
      status: 'running',
      input: { agent: 'fixer', subagent_type: 'fixer', description: 'Fix it', prompt: 'p' },
      metadata: { sessionID: 'ses_c', sessionId: 'ses_c' },
      title: 'Fix it',
      time: { start: 1100 },
    });
  });

  it('starts at created when the tool never ran and omits an unknown title', () => {
    const state = toV1ToolState({
      id: 'c1', name: 'glob', time: { created: 1000 }, state: { status: 'running', input: { pattern: '*' }, metadata: {} },
    }, context);
    expect(state).toEqual({ status: 'running', input: { pattern: '*' }, metadata: {}, time: { start: 1000 } });
  });

  it('maps completed: joined text output, file attachments and end time', () => {
    expect(toV1ToolState({
      id: 'call_7',
      name: 'read',
      time,
      state: {
        status: 'completed',
        input: { path: 'img.png' },
        content: [
          { type: 'text', text: 'line 1' },
          { type: 'file', uri: 'data:image/png;base64,AAAA', mime: 'image/png', name: 'img.png' },
          { type: 'text', text: 'line 2' },
          { type: 'file', uri: 'file:///tmp/x.bin', mime: 'application/octet-stream' },
        ],
        metadata: { truncated: false },
      },
    }, context)).toEqual({
      status: 'completed',
      input: { path: 'img.png', filePath: 'img.png' },
      output: 'line 1\nline 2',
      title: 'img.png',
      metadata: { truncated: false },
      time: { start: 1100, end: 1500 },
      attachments: [
        {
          id: 'msg_01:tool:call_7:file:0',
          sessionID: 'ses_01',
          messageID: 'msg_01',
          type: 'file',
          mime: 'image/png',
          url: 'data:image/png;base64,AAAA',
          filename: 'img.png',
        },
        {
          id: 'msg_01:tool:call_7:file:1',
          sessionID: 'ses_01',
          messageID: 'msg_01',
          type: 'file',
          mime: 'application/octet-stream',
          url: 'file:///tmp/x.bin',
        },
      ],
    });
  });

  it('fills completed defaults and edit diff aliases', () => {
    expect(toV1ToolState({
      id: 'c1',
      name: 'edit',
      time: { created: 1000 },
      state: { status: 'completed', input: { path: 'src/a.ts', oldString: 'a', newString: 'b' }, content: [{ type: 'text', text: 'ok' }], metadata: { files: [fileDiff], replacements: 1 } },
    }, context)).toEqual({
      status: 'completed',
      input: { path: 'src/a.ts', filePath: 'src/a.ts', oldString: 'a', newString: 'b' },
      output: 'ok',
      title: 'src/a.ts',
      metadata: { files: [fileDiff], replacements: 1, diff: fileDiff.patch, filediff: { file: 'src/a.ts', additions: 1, deletions: 1 } },
      time: { start: 1000, end: 1000 },
    });
    const bare = toV1ToolState({
      id: 'c2', name: 'websearch', time, state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'r' }] },
    }, context);
    expect(bare).toMatchObject({ title: '', metadata: {}, output: 'r' });
    expect(bare).not.toHaveProperty('attachments');
  });

  it('maps error to the structured error message', () => {
    expect(toV1ToolState({
      id: 'c1',
      name: 'shell',
      time,
      state: { status: 'error', input: { command: 'false' }, error: { type: 'tool.execution', message: 'exit 1' }, metadata: { shellID: 'sh_1' } },
    }, context)).toEqual({
      status: 'error',
      input: { command: 'false' },
      error: 'exit 1',
      metadata: { shellID: 'sh_1' },
      time: { start: 1100, end: 1500 },
    });
    expect(toV1ToolState({
      id: 'c1', name: 'shell', time: { created: 5 }, state: { status: 'error', input: {}, error: { type: 'x' } },
    }, context)).toEqual({ status: 'error', input: {}, error: '', time: { start: 5, end: 5 } });
  });

  it('returns null for unknown or malformed states', () => {
    expect(toV1ToolState({ id: 'c1', name: 'read', time, state: { status: 'paused' } }, context)).toBeNull();
    expect(toV1ToolState({ id: 'c1', name: 'read', time }, context)).toBeNull();
    expect(toV1ToolState(null, context)).toBeNull();
  });
});

describe('toV1ToolPart', () => {
  it('builds a v1 ToolPart with the synthesized id, v1 name and part metadata', () => {
    expect(toV1ToolPart({
      type: 'tool',
      id: 'call_1',
      name: 'shell',
      providerState: { itemId: 'fc_1' },
      state: { status: 'running', input: { command: 'ls' }, metadata: {} },
      time: { created: 10, ran: 11 },
    }, context)).toEqual({
      id: 'msg_01:tool:call_1',
      sessionID: 'ses_01',
      messageID: 'msg_01',
      type: 'tool',
      callID: 'call_1',
      tool: 'bash',
      state: { status: 'running', input: { command: 'ls' }, metadata: {}, title: 'ls', time: { start: 11 } },
      metadata: { opencodeTool: 'shell', providerState: { itemId: 'fc_1' } },
    });
  });

  it('keeps migrated v1 names and omits absent provider state', () => {
    const part = toV1ToolPart({
      type: 'tool', id: 'c', name: 'bash', state: { status: 'streaming', input: '' }, time: { created: 1 },
    }, context);
    expect(part).toMatchObject({ tool: 'bash', metadata: { opencodeTool: 'bash' } });
    expect(part.metadata).not.toHaveProperty('providerState');
  });

  it('returns null without a call id, a name or a known state', () => {
    expect(toV1ToolPart({ type: 'tool', id: '', name: 'read', state: { status: 'streaming', input: '' } }, context)).toBeNull();
    expect(toV1ToolPart({ type: 'tool', id: 'c', state: { status: 'streaming', input: '' } }, context)).toBeNull();
    expect(toV1ToolPart({ type: 'tool', id: 'c', name: 'read', state: { status: 'nope' } }, context)).toBeNull();
  });
});

describe('reviewed skill display names', () => {
  // Reviewed v2 skills carry a hashed id; the human name arrives in metadata.
  const HASHED = 'devryan-539ddc37a961e3aceadfc7bbb540b8e7';
  const body = '<skill_content name="Superpowers">\n# Skill: Superpowers\n</skill_content>';
  const skill = (state) => ({ id: 'call_s', name: 'skill', time: { created: 1, ran: 2, completed: 3 }, state });

  it('never aliases a hashed reviewed id into the display name', () => {
    const input = { id: HASHED };
    expect(toV1ToolInput('skill', input)).toBe(input);
    expect(toV1ToolInput('skill', { id: 'pdf' })).toEqual({ id: 'pdf', name: 'pdf' });
  });

  it('names a running skill from its progress metadata and a hash-only one not at all', () => {
    expect(toV1ToolState(skill({ status: 'running', input: { id: HASHED } }), context))
      .toEqual({ status: 'running', input: { id: HASHED }, metadata: {}, time: { start: 2 } });
    expect(toV1ToolState(skill({ status: 'running', input: { id: HASHED }, metadata: { name: 'Superpowers' } }), context))
      .toEqual({ status: 'running', input: { id: HASHED, name: 'Superpowers' }, metadata: { name: 'Superpowers' }, title: 'Superpowers', time: { start: 2 } });
  });

  it('uses metadata.name as the completed input name and title', () => {
    const metadata = { name: 'Superpowers', directory: '/skills/superpowers' };
    expect(toV1ToolState(skill({ status: 'completed', input: { id: HASHED }, content: [{ type: 'text', text: body }], metadata }), context))
      .toEqual({ status: 'completed', input: { id: HASHED, name: 'Superpowers' }, output: body, title: 'Superpowers', metadata, time: { start: 2, end: 3 } });
    expect(toV1ToolState(skill({ status: 'error', input: { id: HASHED }, error: { message: 'native_skill_unreviewed' } }), context))
      .toEqual({ status: 'error', input: { id: HASHED }, error: 'native_skill_unreviewed', time: { start: 2, end: 3 } });
  });

  it('keeps folder-name ids and existing v1 names, and strips the display name on the way back', () => {
    expect(toV1ToolState(skill({ status: 'completed', input: { id: 'pdf' }, content: [], metadata: { name: 'pdf' } }), context))
      .toMatchObject({ input: { id: 'pdf', name: 'pdf' }, title: 'pdf' });
    expect(toV1ToolState(skill({ status: 'completed', input: { id: 'pdf' }, content: [] }), context))
      .toMatchObject({ input: { id: 'pdf', name: 'pdf' }, title: '' });
    expect(toV1ToolState(skill({ status: 'completed', input: { name: 'legacy' }, content: [], metadata: { name: 'Legacy' } }), context))
      .toMatchObject({ input: { name: 'legacy' } });
    const projected = toV1ToolState(skill({ status: 'completed', input: { id: HASHED }, content: [], metadata: { name: 'Superpowers' } }), context);
    expect(toV2ToolInput('skill', projected.input)).toEqual({ id: HASHED });
  });
});
