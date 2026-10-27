import express from 'express';
import request from '../../test-supertest.js';
import { describe, expect, it, vi } from 'vitest';
import { createOpenCodeV2FacadeRouter } from './v2/facade-routes.js';
import { omitMessageToolOutput, omitToolPartOutput, readToolOutputMode } from './tool-output-trim.js';

const completed = (tool, output, metadata = {}) => ({
  id: `prt_${tool}`, sessionID: 'ses_a', messageID: 'msg_a', type: 'tool', tool, callID: `call_${tool}`,
  state: { status: 'completed', input: {}, output, title: tool, metadata, time: { start: 1, end: 2 } },
});

describe('finished tool output trimming', () => {
  it('reads only the omit opt-in', () => {
    expect(readToolOutputMode({})).toBe('full');
    expect(readToolOutputMode(undefined)).toBe('full');
    expect(readToolOutputMode({ toolOutput: 'omit' })).toBe('omit');
    for (const toolOutput of ['full', '', ['omit']]) expect(() => readToolOutputMode({ toolOutput })).toThrow('toolOutput must be omit');
  });

  it('marks omitted output with its UTF-8 size and keeps every other field', () => {
    const part = completed('read', 'naïve\n', { preview: 'naïve', truncated: false });
    expect(omitToolPartOutput(part)).toEqual({
      ...part, state: { ...part.state, output: '', outputOmitted: true, outputBytes: 7 },
    });
    expect(part.state.output).toBe('naïve\n');
  });

  it('returns the same reference when nothing is trimmed', () => {
    for (const part of [
      completed('read', ''), completed('bash', 'out', { output: 'out' }), completed('task', 'task_id: ses_b'),
      { ...completed('read', 'x'), state: { status: 'error', input: {}, error: 'boom', time: { start: 1, end: 2 } } },
      { id: 'prt_text', type: 'text', text: 'hello' }, null,
    ]) expect(omitToolPartOutput(part)).toBe(part);
    const record = { info: { id: 'msg_a' }, parts: [completed('grep', 'a.ts')] };
    expect(omitMessageToolOutput(record)).toBe(record);
    const once = omitMessageToolOutput({ info: { id: 'msg_a' }, parts: [completed('read', 'body')] });
    expect(omitMessageToolOutput(once)).toBe(once);
  });
});

// A long, read-heavy session in OpenCode's stored shapes: each turn reads three
// source files and also edits, greps, runs a command and keeps todos, so the
// tools that stay full are part of the measured page too.
const sourceFile = (turn, file) => `<file>\n${Array.from({ length: 140 }, (_, line) => (
  `${String(line + 1).padStart(5, '0')}| export const value${turn}_${file}_${line} = compute(${line}, '${'x'.repeat(line % 23)}');`
)).join('\n')}\n</file>`;
const longSession = (turns) => {
  const records = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const user = `msg_${String(turn).padStart(4, '0')}_u`;
    const assistant = `msg_${String(turn).padStart(4, '0')}_a`;
    const part = (id, fields) => ({ id: `prt_${assistant}_${id}`, sessionID: 'ses_long', messageID: assistant, ...fields });
    const tool = (id, name, input, output, metadata) => part(id, { type: 'tool', tool: name, callID: `call_${assistant}_${id}`,
      state: { status: 'completed', input, output, title: name, metadata, time: { start: turn * 10, end: turn * 10 + 1 } } });
    const diff = `--- a/src/f${turn}.ts\n+++ b/src/f${turn}.ts\n@@ -1,3 +1,3 @@\n-${'old line\n'.repeat(20)}+${'new line\n'.repeat(20)}`;
    const command = `${'PASS src/module.test.ts (12 tests)\n'.repeat(12)}Tests: 144 passed\n`;
    records.push({
      info: { id: user, sessionID: 'ses_long', role: 'user', time: { created: turn * 10 }, agent: 'build',
        model: { providerID: 'anthropic', modelID: 'claude-opus-5-5' } },
      parts: [{ id: `prt_${user}_text`, sessionID: 'ses_long', messageID: user, type: 'text',
        text: `Turn ${turn}: look at the three modules and fix the failing case.`.repeat(3) }],
    }, {
      info: { id: assistant, sessionID: 'ses_long', role: 'assistant', parentID: user, modelID: 'claude-opus-5-5', providerID: 'anthropic',
        mode: 'build', agent: 'build', path: { cwd: '/repo', root: '/repo' }, cost: 0.01,
        tokens: { input: 12000, output: 800, reasoning: 200, cache: { read: 9000, write: 1000 } }, time: { created: turn * 10 + 1, completed: turn * 10 + 2 } },
      parts: [
        part('start', { type: 'step-start', snapshot: 'a'.repeat(40) }),
        part('reasoning', { type: 'reasoning', text: 'Reading the modules before changing anything. '.repeat(14), time: { start: 1, end: 2 } }),
        ...[0, 1, 2].map((file) => tool(`read${file}`, 'read', { filePath: `/repo/src/m${turn}_${file}.ts` }, sourceFile(turn, file),
          { preview: sourceFile(turn, file).slice(0, 400), truncated: false })),
        tool('grep', 'grep', { pattern: `value${turn}` }, `Found 4 matches\n${'/repo/src/m.ts:\n  Line 3: value\n'.repeat(4)}`, { matches: 4, truncated: false }),
        tool('edit', 'edit', { filePath: `/repo/src/f${turn}.ts`, oldString: 'old', newString: 'new' }, 'Edit applied successfully.',
          { diff, filediff: { file: `/repo/src/f${turn}.ts`, additions: 20, deletions: 20 } }),
        tool('bash', 'bash', { command: 'bun test', description: 'Run tests' }, command, { output: command, exit: 0, description: 'Run tests' }),
        tool('todo', 'todowrite', { todos: [{ content: 'fix', status: 'completed', priority: 'high' }] },
          JSON.stringify([{ content: 'fix', status: 'completed', priority: 'high' }]), { todos: [] }),
        part('text', { type: 'text', text: 'Fixed the failing case and the tests pass. '.repeat(8), time: { start: 1, end: 2 } }),
        part('finish', { type: 'step-finish', reason: 'stop', cost: 0.01, tokens: { input: 12000, output: 800, reasoning: 200, cache: { read: 9000, write: 1000 } } }),
      ],
    });
  }
  return records;
};

describe('history page payload', () => {
  it('is at least 60% smaller for a long session when finished output is omitted', async () => {
    const records = longSession(150);
    const client = { generation: () => 2, sessions: { messages: vi.fn(async () => ({ records })) } };
    const app = express();
    app.use('/api', createOpenCodeV2FacadeRouter({ openCodeClient: client,
      getOpenCodeRuntime: () => ({ generation: 2, baseUrl: 'http://127.0.0.1:12345' }),
      resolveRequestDirectory: () => '/repo', getOpenCodeAuthHeaders: () => ({}), fetchImpl: vi.fn() }));

    const full = await request(app).get('/api/session/ses_long/message?limit=300');
    const trimmed = await request(app).get('/api/session/ses_long/message?limit=300&toolOutput=omit');
    const fullBytes = Buffer.byteLength(full.text);
    const trimmedBytes = Buffer.byteLength(trimmed.text);
    // Measured 2026-10-24: 5,213,304 B full, 1,158,204 B omitted (77.8% smaller).
    const reduction = 1 - trimmedBytes / fullBytes;
    expect(fullBytes).toBeGreaterThan(2_000_000);
    expect(reduction).toBeGreaterThanOrEqual(0.6);
    // Only the read output went; every tool the UI derives state from is intact.
    expect(trimmed.body.flatMap((record) => record.parts).filter((part) => part.state?.outputOmitted).map((part) => part.tool))
      .toEqual(Array.from({ length: 450 }, () => 'read'));
  });
});
