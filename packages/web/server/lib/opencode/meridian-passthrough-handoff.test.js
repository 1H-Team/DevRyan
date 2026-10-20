import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { settlePassthroughQuery, validatePersistedCheckpoint, verifyPersistedCheckpoint, sdkProjectDirectory } from './meridian-passthrough-handoff.js';

const assistant = { type: 'assistant', uuid: 'assistant-1', session_id: 'sdk-session', message: { content: [
  { type: 'tool_use', id: 'call-1', name: 'mcp__oc__read' },
  { type: 'tool_use', id: 'call-2', name: 'mcp__oc__read' },
] } };
const result = id => ({ type: 'user', session_id: 'sdk-session', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
const terminal = { type: 'result', subtype: 'success', session_id: 'sdk-session' };

function fixture({ incomplete = false, canonical = true, failInterrupt = false } = {}) {
  let interrupted = false;
  const query = (async function* () {
    yield { type: 'assistant', session_id: 'sdk-session', message: { content: [{ type: 'tool_use', name: 'ToolSearch', id: 'search' }] } };
    yield assistant;
    yield result('call-1');
    if (!incomplete) yield result('call-2');
    if (!interrupted) throw new Error('Reached maximum number of turns (4)');
    if (canonical) yield terminal;
  })();
  query.interrupt = vi.fn(() => {
    if (failInterrupt) return Promise.reject(new Error('control unavailable'));
    interrupted = true;
    return Promise.resolve();
  });
  query.close = vi.fn();
  return query;
}

async function consume(query, options = {}) {
  const resolved = new Set();
  const received = [];
  const diagnostic = vi.fn();
  const run = async () => {
    for await (const message of settlePassthroughQuery(query, {
      checkpoint: () => resolved.size === 2 ? { assistantUuid: assistant.uuid, toolCallIds: ['call-1', 'call-2'] } : null,
      diagnostic,
      ...options,
    })) {
      received.push(message);
      for (const block of message.message?.content ?? []) {
        if (block.type === 'tool_result') resolved.add(block.tool_use_id);
      }
    }
  };
  return { run, diagnostic, received };
}

describe('Meridian passthrough SDK handoff', () => {
  it('settles after the complete parallel tool set, preserving the real terminal and session identity', async () => {
    const query = fixture();
    const { run, received, diagnostic } = await consume(query);
    await run();
    expect(query.interrupt).toHaveBeenCalledTimes(1);
    expect(received.at(-1)).toBe(terminal);
    expect(received.filter(message => message === assistant)).toHaveLength(1);
    expect(diagnostic).toHaveBeenLastCalledWith('passthrough.checkpoint_settled', { reason: 'sdk_terminal', toolCount: 2 });
    expect(query.close).not.toHaveBeenCalled();
  });

  it('does not interrupt an incomplete parallel set or treat max-turn failure as a canonical terminal', async () => {
    const query = fixture({ incomplete: true });
    const { run, received } = await consume(query);
    await expect(run()).rejects.toThrow('maximum number of turns');
    expect(query.interrupt).not.toHaveBeenCalled();
    expect(received.some(message => message.type === 'result')).toBe(false);
  });

  it.each(['', undefined])('rejects a missing assistant UUID (%s)', async assistantUuid => {
    const query = fixture();
    const { run } = await consume(query, { checkpoint: () => ({ assistantUuid, toolCallIds: ['call-1'] }) });
    await expect(run()).rejects.toThrow('maximum number of turns');
    expect(query.interrupt).not.toHaveBeenCalled();
  });

  it('rejects duplicate checkpoint IDs', async () => {
    const query = fixture();
    const { run } = await consume(query, { checkpoint: () => ({ assistantUuid: assistant.uuid, toolCallIds: ['call-1', 'call-1'] }) });
    await expect(run()).rejects.toThrow('maximum number of turns');
    expect(query.interrupt).not.toHaveBeenCalled();
  });

  it('never turns a client cancellation into a resumable checkpoint', async () => {
    const query = fixture();
    const { run } = await consume(query, { signal: AbortSignal.abort() });
    await expect(run()).rejects.toThrow('maximum number of turns');
    expect(query.interrupt).not.toHaveBeenCalled();
  });

  it('retains the failure when SDK control fails, without an unhandled rejection', async () => {
    const query = fixture({ failInterrupt: true });
    const { run, diagnostic } = await consume(query);
    await expect(run()).rejects.toThrow('maximum number of turns');
    expect(diagnostic).toHaveBeenCalledWith('passthrough.checkpoint_interrupt_failed', { reason: 'control_failed', toolCount: 2 });
  });

  it('does not fabricate a terminal when the SDK exits without one', async () => {
    const query = fixture({ canonical: false });
    const { run, received, diagnostic } = await consume(query);
    await run();
    expect(received.some(message => message.type === 'result')).toBe(false);
    expect(diagnostic).toHaveBeenLastCalledWith('passthrough.checkpoint_rejected', { reason: 'missing_terminal', toolCount: 2 });
  });

  it('leaves ordinary SDK queries untouched', async () => {
    const query = (async function* () { yield terminal; })();
    query.interrupt = vi.fn();
    const received = [];
    for await (const event of settlePassthroughQuery(query)) received.push(event);
    expect(received).toEqual([terminal]);
    expect(query.interrupt).not.toHaveBeenCalled();
  });
});

describe('durable native checkpoint proof', () => {
  const boundary = { sessionId: 'session', assistantUuid: 'a2', toolCallIds: ['call-1', 'call-2'], cwd: '/fixture' };
  const rows = () => [
    { uuid: 'a1', parentUuid: 'previous', type: 'assistant', sessionId: 'session', cwd: '/fixture', message: { id: 'message', content: [{ type: 'tool_use', id: 'call-1' }] } },
    { uuid: 'a2', parentUuid: 'a1', type: 'assistant', sessionId: 'session', cwd: '/fixture', message: { id: 'message', content: [{ type: 'tool_use', id: 'call-2' }] } },
    { uuid: 'u1', parentUuid: 'a2', type: 'user', sessionId: 'session', cwd: '/fixture', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1' }, { type: 'tool_result', tool_use_id: 'call-2' }] } },
  ];

  it('requires the exact assistant parent chain and complete result set', () => {
    expect(validatePersistedCheckpoint(rows(), boundary)).toBe(true);
    expect(validatePersistedCheckpoint(rows().slice(0, 2), boundary)).toBe(false);
    expect(validatePersistedCheckpoint(rows(), { ...boundary, assistantUuid: 'unrelated' })).toBe(false);
    expect(validatePersistedCheckpoint(rows(), { ...boundary, sessionId: 'other' })).toBe(false);
    expect(validatePersistedCheckpoint(rows(), { ...boundary, cwd: '/other' })).toBe(false);
    expect(validatePersistedCheckpoint(rows(), { ...boundary, toolCallIds: ['call-1'] })).toBe(false);
  });

  it.each(['missing', 'duplicate', 'mismatched', 'unrelated-parent', 'malformed-cwd', 'cycle'])('rejects %s checkpoint records', mode => {
    const records = rows();
    if (mode === 'missing') records[2].message.content.pop();
    if (mode === 'duplicate') records[2].message.content.push(records[2].message.content[0]);
    if (mode === 'mismatched') records[2].message.content[1].tool_use_id = 'other';
    if (mode === 'unrelated-parent') records[2].parentUuid = 'previous';
    if (mode === 'malformed-cwd') records[0].cwd = 42;
    if (mode === 'cycle') records[0].parentUuid = 'a2';
    expect(validatePersistedCheckpoint(records, boundary)).toBe(false);
  });

  it('retains identity over repeated max-turn handoffs without emitting fabricated results', async () => {
    const verified = vi.fn();
    for (let turn = 0; turn < 3; turn++) {
      const query = fixture({ failInterrupt: true });
      const { run, received } = await consume(query, { verified, verify: async () => true });
      await run();
      expect(received.filter(event => event === assistant)).toHaveLength(1);
      expect(received.some(event => event.type === 'result')).toBe(false);
    }
    expect(verified).toHaveBeenCalledTimes(3);
    expect(verified.mock.calls.every(([saved]) => saved.sessionId === 'sdk-session')).toBe(true);
  });

  it('propagates transport errors even when a checkpoint exists on disk', async () => {
    const query = (async function* () {
      yield assistant; yield result('call-1'); yield result('call-2');
      throw new Error('upstream disconnected');
    })();
    query.interrupt = vi.fn();
    query.close = vi.fn();
    const verify = vi.fn(async () => true);
    const { run } = await consume(query, { verify });
    await expect(run()).rejects.toThrow('upstream disconnected');
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects cancellation while durable verification is pending', async () => {
    const controller = new AbortController();
    const verified = vi.fn();
    const query = fixture({ failInterrupt: true });
    const { run } = await consume(query, { signal: controller.signal, verified, verify: async () => {
      controller.abort(); return true;
    } });
    await expect(run()).rejects.toThrow('maximum number of turns');
    expect(verified).not.toHaveBeenCalled();
  });

  it('requires a verified file for a locally interrupted diagnostic exit', async () => {
    for (const saved of [true, false]) {
      const query = (async function* () {
        yield assistant; yield result('call-1'); yield result('call-2');
        throw new Error('Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use');
      })();
      query.interrupt = vi.fn();
      query.close = vi.fn();
      const verified = vi.fn();
      const { run } = await consume(query, { verified, verify: async () => saved });
      if (saved) { await run(); expect(verified).toHaveBeenCalledTimes(1); }
      else { await expect(run()).rejects.toThrow('ede_diagnostic'); expect(verified).not.toHaveBeenCalled(); }
    }
  });
});

it('verifies the exact native file and rejects torn or missing persistence', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-native-checkpoint-')));
  try {
    const cwd = (await fs.realpath(root)).normalize('NFC');
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const assistantUuid = '22222222-2222-4222-8222-222222222222';
    const boundary = { sessionId, assistantUuid, toolCallIds: ['call'] };
    const options = { cwd, env: { CLAUDE_CONFIG_DIR: root } };
    expect(await verifyPersistedCheckpoint(boundary, options)).toBe(false);
    const directory = path.join(root, 'projects', sdkProjectDirectory(cwd));
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, sessionId + '.jsonl');
    const records = [
      { uuid: assistantUuid, type: 'assistant', sessionId, cwd, message: { id: 'message', content: [{ type: 'tool_use', id: 'call' }] } },
      { uuid: 'result', type: 'user', parentUuid: assistantUuid, sessionId, cwd, message: { content: [{ type: 'tool_result', tool_use_id: 'call' }] } },
    ];
    const contents = records.map(record => JSON.stringify(record)).join('\n');
    await fs.writeFile(file, contents + '\n');
    expect(await verifyPersistedCheckpoint(boundary, options)).toBe(true);
    await fs.writeFile(file, contents);
    expect(await verifyPersistedCheckpoint(boundary, options)).toBe(false);
    await fs.writeFile(file, contents + '\n{bad json}\n');
    expect(await verifyPersistedCheckpoint(boundary, options)).toBe(false);
    expect(await verifyPersistedCheckpoint({ ...boundary, sessionId: '../escape' }, options)).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('does not retain a terminal that arrives after the drain deadline', async () => {
  const query = (async function* () {
    yield assistant; yield result('call-1'); yield result('call-2');
    await new Promise(resolve => setTimeout(resolve, 15));
    yield terminal;
  })();
  query.interrupt = vi.fn();
  query.close = vi.fn();
  const { run, received } = await consume(query, { drainTimeoutMs: 1 });
  await expect(run()).rejects.toThrow('drain timed out');
  expect(received.some(event => event.type === 'result')).toBe(false);
  expect(query.close).toHaveBeenCalledTimes(1);
});

it('reads native checkpoints from the transport-owned directory rather than the SDK profile directory', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-checkpoint-transport-')));
  const hook = '__DEVRYAN_CLAUDE_CHECKPOINT_DIRECTORY';
  const previous = Reflect.get(globalThis, hook);
  try {
    const state = path.join(root, 'transport-state');
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const assistantUuid = '22222222-2222-4222-8222-222222222222';
    const directory = path.join(state, 'projects', sdkProjectDirectory(root));
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${sessionId}.jsonl`), [
      { uuid: assistantUuid, type: 'assistant', sessionId, cwd: root, message: { id: 'message', content: [{ type: 'tool_use', id: 'call' }] } },
      { uuid: 'result', parentUuid: assistantUuid, type: 'user', sessionId, cwd: root, message: { content: [{ type: 'tool_result', tool_use_id: 'call' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const resolve = vi.fn(() => state);
    Reflect.set(globalThis, hook, resolve);
    expect(await verifyPersistedCheckpoint({ sessionId, assistantUuid, toolCallIds: ['call'] }, {
      cwd: root, env: { CLAUDE_CONFIG_DIR: path.join(root, 'profile'), DEVRYAN_CLAUDE_DIAGNOSTIC_SCOPE: 'owned-scope' },
    })).toBe(true);
    expect(resolve).toHaveBeenCalledWith('owned-scope', root);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, hook); else Reflect.set(globalThis, hook, previous);
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.each(['config', 'projects', 'project', 'transcript'])('refuses a symlinked %s checkpoint path', async level => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-checkpoint-symlink-')));
  try {
    const config = path.join(root, 'config'), projects = path.join(config, 'projects'), project = path.join(projects, sdkProjectDirectory(root));
    const sessionId = '11111111-1111-4111-8111-111111111111', assistantUuid = '22222222-2222-4222-8222-222222222222';
    await fs.mkdir(project, { recursive: true }); const transcript = path.join(project, sessionId + '.jsonl');
    await fs.writeFile(transcript, [
      { uuid: assistantUuid, type: 'assistant', sessionId, cwd: root, message: { id: 'message', content: [{ type: 'tool_use', id: 'call' }] } },
      { uuid: 'result', parentUuid: assistantUuid, type: 'user', sessionId, cwd: root, message: { content: [{ type: 'tool_result', tool_use_id: 'call' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const boundary = { sessionId, assistantUuid, toolCallIds: ['call'] }, options = { cwd: root, env: { CLAUDE_CONFIG_DIR: config } };
    expect(await verifyPersistedCheckpoint(boundary, options)).toBe(true);
    const target = { config, projects, project, transcript }[level], moved = path.join(root, 'moved');
    await fs.rename(target, moved); await fs.symlink(moved, target);
    expect(await verifyPersistedCheckpoint(boundary, options)).toBe(false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('rechecks native attempt authority after reading a persisted checkpoint', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-checkpoint-retired-')));
  const hook = '__DEVRYAN_CLAUDE_CHECKPOINT_DIRECTORY', previous = Reflect.get(globalThis, hook);
  try {
    const sessionId = '11111111-1111-4111-8111-111111111111', assistantUuid = '22222222-2222-4222-8222-222222222222';
    const project = path.join(root, 'projects', sdkProjectDirectory(root)); await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, sessionId + '.jsonl'), [
      { uuid: assistantUuid, type: 'assistant', sessionId, cwd: root, message: { id: 'message', content: [{ type: 'tool_use', id: 'call' }] } },
      { uuid: 'result', parentUuid: assistantUuid, type: 'user', sessionId, cwd: root, message: { content: [{ type: 'tool_result', tool_use_id: 'call' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    let reads = 0; Reflect.set(globalThis, hook, () => { if (reads++) throw new Error('attempt retired'); return root; });
    expect(await verifyPersistedCheckpoint({ sessionId, assistantUuid, toolCallIds: ['call'] }, {
      cwd: root, env: { DEVRYAN_CLAUDE_DIAGNOSTIC_SCOPE: 'owned' },
    })).toBe(false);
    expect(reads).toBe(2);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, hook); else Reflect.set(globalThis, hook, previous);
    await fs.rm(root, { recursive: true, force: true });
  }
});
