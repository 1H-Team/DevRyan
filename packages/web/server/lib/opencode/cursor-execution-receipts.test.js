import { expect, test, vi } from 'vitest';
import { createCursorExecutionReceipts } from './cursor-execution-receipts.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSessionMutationRuntime } from '@devryan/harness-runtime/lib/session-mutations.js';
import { createSessionChangeHost } from '@devryan/harness-runtime/lib/session-changes-host.js';
import { createNativeConsumerFixture } from './test-native-consumer-client.js';

const lease = { directory: '/fixture', token: 'lease_one', scope: { sessionID: 'child', messageID: 'assistant' } };
const receipt = { ...lease.scope, directory: lease.directory, callID: 'cursor_assistant', source: 'confined-execution', files: [] };
const part = (callID, tool) => ({ type: 'tool', callID, tool });
const fixture = () => {
  const runtime = { executionReceipt: vi.fn(async () => receipt), aliasCalls: vi.fn(async () => {}) };
  const recordReceipts = vi.fn(async () => {}), diagnostics = [];
  return { runtime, recordReceipts, diagnostics,
    save: createCursorExecutionReceipts({ runtime, recordReceipts, onDiagnostic: event => diagnostics.push(event) }) };
};

test('settled memo pressure replays through durable owners while an active write stays serialized', async () => {
  const f = fixture(), gate = Promise.withResolvers();
  const activeLease = {...lease, token: 'active'};
  f.recordReceipts.mockImplementationOnce(() => gate.promise);
  const active = f.save(activeLease, {parts: [part('active_edit', 'edit')]});
  await Promise.resolve(); await Promise.resolve();
  for(let index=0;index<1025;index++) await f.save({...lease, token: `settled_${index}`}, {parts: []});
  const repeated = f.save(activeLease, {parts: [part('active_edit', 'edit')]});
  gate.resolve(); await active; await repeated;
  expect(f.runtime.aliasCalls.mock.calls.filter(([input])=>input.token==='active')).toHaveLength(1);
  const before = f.recordReceipts.mock.calls.length;
  await f.save({...lease, token: 'settled_0'}, {parts: []});
  expect(f.recordReceipts.mock.calls.length).toBe(before + 1);
});

test('all calls retain aliases while only outer and mutating receipts are batched once', async () => {
  const f = fixture();
  const record = { parts: [part('read', 'read'), part('glob', 'glob'), part('grep', 'grep'), part('edit', 'edit')] };
  expect(await f.save(lease, record)).toBe(true);
  expect(await f.save(lease, record)).toBe(false);
  expect(f.runtime.aliasCalls).toHaveBeenCalledExactlyOnceWith({ directory: lease.directory, token: lease.token, calls: ['read', 'glob', 'grep', 'edit'] });
  expect(f.recordReceipts).toHaveBeenCalledExactlyOnceWith([
    { ...receipt, tool: 'cursor_sdk' }, { ...receipt, callID: 'edit', tool: 'edit', files: [] },
  ]);
  expect(f.runtime.executionReceipt).toHaveBeenCalledTimes(1);
  expect(f.diagnostics.filter(event => event.state === 'completed')).toEqual([
    expect.objectContaining({ phase: 'cursor_receipts', calls: 4, receipts: 2 }),
  ]);
});

test('failed writes retry and late snapshots collect new calls behind in-flight work', async () => {
  const f = fixture(), gate = Promise.withResolvers();
  f.recordReceipts.mockImplementationOnce(async () => { await gate.promise; throw Error('disk unavailable'); });
  const first = f.save(lease, { parts: [part('read', 'read'), part('edit', 'edit')] });
  const failed = expect(first).rejects.toThrow('disk unavailable');
  const second = f.save(lease, { parts: [part('read', 'read'), part('edit', 'edit'), part('write', 'write')] });
  gate.resolve(); await failed; await second;
  expect(f.recordReceipts).toHaveBeenCalledTimes(2);
  expect(f.recordReceipts.mock.calls[1][0].map(input => input.callID)).toEqual(['cursor_assistant', 'edit', 'write']);
  expect(f.runtime.aliasCalls.mock.calls.map(([input]) => input.calls)).toEqual([['read', 'edit'], ['write']]);
  await f.save(lease, { parts: [part('read', 'read'), part('edit', 'edit'), part('write', 'write'), part('late', 'grep')] });
  expect(f.recordReceipts).toHaveBeenCalledTimes(2);
  expect(f.runtime.aliasCalls.mock.calls.at(-1)[0].calls).toEqual(['late']);
});

test('scalar compatibility retries only uncommitted receipts', async () => {
  const runtime = { executionReceipt: vi.fn(async () => receipt), aliasCalls: vi.fn(async () => {}) };
  const recordReceipt = vi.fn(async input => { if (input.callID === 'write' && recordReceipt.mock.calls.length === 2) throw Error('failed'); });
  const save = createCursorExecutionReceipts({ runtime, recordReceipt });
  await expect(save(lease, { parts: [part('write', 'write')] })).rejects.toThrow('failed');
  await save(lease, { parts: [part('write', 'write')] });
  expect(recordReceipt.mock.calls.map(([input]) => input.callID)).toEqual(['cursor_assistant', 'write', 'write']);
});

test('unknown tools retain evidence and conflicting call identities refuse before writes', async () => {
  const f = fixture();
  await expect(f.save(lease, { parts: [part('same', 'read'), part('same', 'edit')] })).rejects.toMatchObject({ code: 'capture_identity_mismatch' });
  expect(f.runtime.aliasCalls).not.toHaveBeenCalled();
  await f.save(lease, { parts: [part('unknown', 'mcp_read')] });
  expect(f.recordReceipts.mock.calls[0][0].map(input => input.tool)).toEqual(['cursor_sdk', 'mcp_read']);
});

test('published confinement covers native tasks through exact aliases while the outer receipt owns all bytes', async () => {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'devryan-cursor-task-receipt-'));
  const directory=path.join(base,'project'); await fs.mkdir(directory);
  execFileSync('git',['init','-q'],{cwd:directory});
  const runtime=createSessionMutationRuntime({directory:path.join(base,'private')});
  const messages=[{info:{id:'prompt',sessionID:'child',role:'user',time:{created:1}},parts:[]},
    {info:{id:'assistant',parentID:'prompt',sessionID:'child',role:'assistant',providerID:'cursor-acp',time:{created:2}},
      parts:[part('outer','cursor_sdk'),part('native_task','task'),part('internal_edit','edit'),part('reader','read')]
        .map(entry=>({...entry,sessionID:'child',messageID:'assistant',state:{status:'completed'}}))}];
  const client=createNativeConsumerFixture({readFixture:async raw=>{
    const url=new URL(raw);
    if(url.pathname.endsWith('/message')) return Response.json(messages);
    if(url.pathname.endsWith('/children')) return Response.json([]);
    if(url.pathname.endsWith('/status')) return Response.json({});
    return Response.json({id:'child',directory});
  }});
  let host;
  const makeHost=()=>createSessionChangeHost({dataDirectory:base,openCodeClient:client,
    restoreOwned:async input=>{
      const tx=await runtime.prepareFileRestore(input);
      await runtime.settleRevert({directory,transactionID:tx.id,commit:true});
    }});
  try {
    const owned=await runtime.begin({directory,sessionID:'child',userMessageID:'prompt',messageID:'assistant',callID:'outer'});
    await runtime.claimLease({directory,token:owned.token,kind:'process'});
    await fs.writeFile(path.join(owned.viewDirectory,'changed.txt'),'published\n');
    host=makeHost();
    const save=createCursorExecutionReceipts({runtime,recordReceipts:input=>host.recordReceipts(input)});
    await expect(save(owned,messages[1])).rejects.toMatchObject({code:'execution_unavailable'});
    await runtime.finish({directory,token:owned.token});
    await save(owned,messages[1]);
    for(const callID of ['outer','native_task','internal_edit','reader']) {
      expect((await runtime.leaseForCall({directory,sessionID:'child',callID})).token).toBe(owned.token);
    }
    await host.drain(); host=makeHost();
    const endpoint=`/api/devryan/session/child/changes?directory=${encodeURIComponent(directory)}`;
    const summary=await host.handleRequest('GET',endpoint);
    expect(summary.body).toMatchObject({coverage:'complete',reasons:[],fileCount:1});
    expect(summary.body.files.map(file=>file.path)).toEqual(['changed.txt']);
    await expect(runtime.prepareFileRestore({directory,sessionID:'child',revision:summary.body.revision,calls:[{sessionID:'child',messageID:'assistant',callID:'unknown'}]}))
      .rejects.toMatchObject({code:'mutation_history_unavailable'});
    expect((await host.handleRequest('POST',endpoint.replace('changes?','changes/undo?'),{revision:summary.body.revision})).status).toBe(200);
    await expect(fs.readFile(path.join(directory,'changed.txt'))).rejects.toMatchObject({code:'ENOENT'});
    const undone=await host.handleRequest('GET',endpoint);
    expect((await host.handleRequest('POST',endpoint.replace('changes?','changes/redo?'),{revision:undone.body.revision})).status).toBe(200);
    expect(await fs.readFile(path.join(directory,'changed.txt'),'utf8')).toBe('published\n');
  } finally {await host?.drain(); await fs.rm(base,{recursive:true,force:true});}
},30_000);
