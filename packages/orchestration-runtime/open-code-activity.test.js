import { expect, test } from 'bun:test';
import { createManagedOpenCodeExecutor } from './open-code-executor.js';
import { createManagedAssistantActivityRegistry } from './assistant-activity.js';

const task = {
  taskId: 'dvr_activity', rootSessionId: 'parent', childSessionId: 'child',
  directory: '/workspace', providerId: 'anthropic', modelId: 'claude-opus-5',
  agent: 'designer', prompt: 'Inspect layout', label: 'Layout', mode: 'builder',
  executionKind: 'start', startedAt: 100, firstAssistantPartAt: null,
};
const output = (id = 'new', parts = [{ type: 'text', text: 'Done' }]) => ({
  info: { id, role: 'assistant', finish: 'stop', time: { created: 100, completed: 200 } }, parts,
});
const emit = (registry, id = 'new', type = 'reasoning') => {
  registry.observe({ type: 'message.updated', properties: {
    info: { id, sessionID: 'child', role: 'assistant', time: { created: 100 } },
  } });
  registry.observe({ type: 'message.part.updated', properties: {
    part: { messageID: id, sessionID: 'child', type, text: 'Working', callID: 'call' },
  } });
};
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const harness = (overrides = {}, executorOptions = {}) => {
  const registry = createManagedAssistantActivityRegistry({ now: executorOptions.now ?? (() => 101) });
  const stamps = [];
  const diagnostics = [];
  const progress = [];
  let subscriptions = 0;
  const control = {
    async setChildSessionId() { return true; }, async markAccepted() { return true; },
    async recordProgress(value) { stamps.push(value); return true; },
  };
  const transport = {
    async createSession() { return { id: 'child' }; }, async promptSession() {},
    async readSession() { return { id: 'child' }; },
    async readStatus() { return { type: 'idle' }; }, async readMessages() { return [output()]; },
    async abortSession() { return true; }, async deleteSession() { return true; },
    ...overrides,
  };
  const executor = createManagedOpenCodeExecutor({
    transport, now: () => 100, idleStablePolls: 1,
    ...executorOptions,
    subscribeAssistantActivity(input, listener, onProgress) {
      subscriptions++;
      const dispose = registry.subscribe(input, listener, value => {
        progress.push(value);
        onProgress?.(value);
      });
      let disposed = false;
      return () => { if (!disposed) { disposed = true; subscriptions--; dispose(); } };
    },
    onFirstAssistantActivity(value) { diagnostics.push(value); },
  });
  return { registry, stamps, diagnostics, progress, control, executor, subscriptions: () => subscriptions };
};

test('publishes first activity while prompt acceptance and transcript polling are still blocked', async () => {
  let acceptPrompt;
  const h = harness({ promptSession: () => new Promise((resolve) => { acceptPrompt = resolve; }) });
  const result = h.executor.start(task, h.control);
  await flush();
  expect(h.subscriptions()).toBe(1);
  emit(h.registry);
  emit(h.registry);
  await flush();
  expect(h.stamps).toEqual([{ firstAssistantPartAt: 101 }]);
  expect(h.subscriptions()).toBe(1);
  expect(h.diagnostics).toEqual([{ taskId: task.taskId, childSessionId: 'child', messageId: 'new', observedAt: 101, source: 'event' }]);
  h.registry.observe({ id: 'fresh-live-delta', type: 'message.part.delta', properties: {
    sessionID: 'child', messageID: 'new', partID: 'live-text', field: 'text', delta: 'More',
  } });
  await flush();
  expect(h.progress).toEqual([{ messageId: 'new', observedAt: 101 }]);
  expect(h.stamps).toEqual([{ firstAssistantPartAt: 101 }]);
  expect(h.subscriptions()).toBe(1);
  acceptPrompt();
  expect((await result).status).toBe('completed');
  expect(h.subscriptions()).toBe(0);
  expect(h.stamps.filter((v) => v.firstAssistantPartAt)).toHaveLength(1);
});

test.each([60_000, 750, 1500])('a terminal event during a blocked canonical read cannot be lost before the healthy wait (%ims)', async eventReconcileIntervalMs => {
  const registry=createManagedAssistantActivityRegistry();
  let releaseRead,enteredRead,statusReads=0,subscriptions=0,busy=true;
  const entered=new Promise(resolve=>{enteredRead=resolve;});
  const executor=createManagedOpenCodeExecutor({idleStablePolls:1,eventReconcileIntervalMs,
    subscribeSessionChanges(input,callback){subscriptions++;const dispose=registry.subscribeChanges(input,callback);return()=>{subscriptions--;dispose();};},
    transport:{async createSession(){return{id:'child'};},async promptSession(){},async readSession(){return{id:'child'};},
      async readStatus(){statusReads++;return{type:busy?'busy':'idle'};},
      async readMessages(){if(busy){enteredRead();return new Promise(resolve=>{releaseRead=resolve;});}return[output()];},
      async abortSession(){return true;},async deleteSession(){return true;}},
  });
  const running=executor.observe(task,{});
  try{
    await entered;busy=false;
    registry.observe({type:'session.idle',properties:{sessionID:'child'}},'/workspace');
    releaseRead([]);
    expect((await running).status).toBe('completed');
    expect(statusReads).toBe(2);expect(subscriptions).toBe(0);
  }finally{releaseRead?.([]);await executor.shutdown();}
});

test.each([['missed-event', 10], ['reconnect', 60_000], ['missed-event', 750], ['missed-event', 1500],
  ['reconnect', 750], ['reconnect', 1500]])('healthy canonical observation recovers %s without posting another prompt (%ims)',async (mode,eventReconcileIntervalMs)=>{
  const registry=createManagedAssistantActivityRegistry();let reads=0,busy=true,subscriptions=0,prompts=0;
  let firstRead;const ready=new Promise(resolve=>{firstRead=resolve;});
  const executor=createManagedOpenCodeExecutor({idleStablePolls:1,eventReconcileIntervalMs,
    subscribeSessionChanges(input,callback){subscriptions++;const dispose=registry.subscribeChanges(input,callback);return()=>{subscriptions--;dispose();};},
    transport:{async createSession(){return{id:'child'};},async promptSession(){prompts++;},async readSession(){return{id:'child'};},
      async readStatus(){return{type:busy?'busy':'idle'};},async readMessages(){reads++;if(busy){firstRead();return [];}return[output()];},
      async abortSession(){return true;},async deleteSession(){return true;}},
  });
  const running=executor.observe(task,{});
  try{
    await ready;await flush();busy=false;
    if(mode==='reconnect')registry.observe({type:'server.connected',properties:{}},'/workspace');
    expect((await running).status).toBe('completed');
    expect(reads).toBe(2);expect(prompts).toBe(0);expect(subscriptions).toBe(0);
  }finally{await executor.shutdown();}
});

test.each([60_000, 750, 1500])('shutdown releases an event wait and its subscription without claiming remote settlement (%ims)',async eventReconcileIntervalMs=>{
  const registry=createManagedAssistantActivityRegistry();let subscriptions=0,firstRead;
  const ready=new Promise(resolve=>{firstRead=resolve;});
  const executor=createManagedOpenCodeExecutor({eventReconcileIntervalMs,
    subscribeSessionChanges(input,callback){subscriptions++;const dispose=registry.subscribeChanges(input,callback);return()=>{subscriptions--;dispose();};},
    transport:{async createSession(){return{id:'child'};},async promptSession(){},async readSession(){return{id:'child'};},
      async readStatus(){return{type:'busy'};},async readMessages(){firstRead();return[];},async abortSession(){return false;},async deleteSession(){return true;}},
  });
  const running=executor.observe(task,{});void running.catch(()=>{});
  await ready;await flush();await executor.shutdown();await expect(running).rejects.toThrow();expect(subscriptions).toBe(0);
});

test.each([60_000, 750, 1500])('Stop interrupts a healthy event wait but waits for actual abort confirmation (%ims)',async eventReconcileIntervalMs=>{
  const registry=createManagedAssistantActivityRegistry();let subscriptions=0,firstRead,enteredCancellation,releaseCancellation,aborts=0;
  const ready=new Promise(resolve=>{firstRead=resolve;});
  const cancelled=new Promise(resolve=>{enteredCancellation=resolve;});
  const settlement=new Promise(resolve=>{releaseCancellation=resolve;});
  const executor=createManagedOpenCodeExecutor({eventReconcileIntervalMs,
    sleep:async()=>{enteredCancellation();await settlement;},
    subscribeSessionChanges(input,callback){subscriptions++;const dispose=registry.subscribeChanges(input,callback);return()=>{subscriptions--;dispose();};},
    transport:{async createSession(){return{id:'child'};},async promptSession(){},async readSession(){return{id:'child'};},
      async readStatus(){return{type:'busy'};},async readMessages(){firstRead();return[];},async abortSession(){return ++aborts>1;},async deleteSession(){return true;}},
  });
  const running=executor.observe(task,{});let settled=false;void running.then(()=>{settled=true;});
  try{
    await ready;await flush();expect((await executor.abort(task)).aborted).toBe(false);
    await cancelled;expect(settled).toBe(false);expect(subscriptions).toBe(0);
    expect((await executor.abort(task)).aborted).toBe(true);releaseCancellation();
    expect((await running).status).toBe('aborted');
  }finally{releaseCancellation();await executor.shutdown();}
});

test('events bypass an in-flight transcript read without adding transcript requests', async () => {
  let finishRead;
  let reads = 0;
  const h = harness({ readMessages: () => { reads++; return new Promise((resolve) => { finishRead = resolve; }); } });
  const result = h.executor.observe({ ...task, childPromptedAt: 150 }, h.control);
  await flush();
  emit(h.registry, 'new', 'tool');
  await flush();
  expect(h.stamps).toEqual([{ firstAssistantPartAt: 101 }]);
  expect(reads).toBe(1);
  finishRead([output()]);
  expect((await result).status).toBe('completed');
  expect(h.subscriptions()).toBe(0);
});

test('busy child activity does not wait for the 30-second transcript refresh', async () => {
  let clock = 100;
  let busy = true;
  let reads = 0;
  const h = harness({
    readStatus: async () => ({ type: busy ? 'busy' : 'idle' }),
    readMessages: async () => { reads++; return busy ? [] : [output()]; },
  }, {
    now: () => clock,
    sleep: async (delay) => {
      clock += delay;
      emit(h.registry);
      await flush();
      expect(h.stamps).toContainEqual({ firstAssistantPartAt: 850 });
      expect(reads).toBe(1);
      busy = false;
    },
  });
  expect((await h.executor.start(task, h.control)).status).toBe('completed');
  expect(clock).toBe(850);
  expect(reads).toBe(2); // One initial snapshot and one terminal read.
});

test('transcript recovery requires semantic output and forwards observation control', async () => {
  for (const parts of [[], [{ type: 'step-start' }], [{ type: 'reasoning', text: 'Thinking' }]]) {
    const record = output('new', parts);
    record.info.error = { name: 'UnknownError', data: { message: 'Permission denied' } };
    const h = harness({ readMessages: async () => [record] });
    // Use a terminal error so empty output does not trigger automatic continuation.
    const result = await h.executor.observe(task, h.control).catch(() => null);
    expect(result).not.toBeNull();
    expect(h.stamps.filter((v) => v.firstAssistantPartAt)).toHaveLength(parts[0]?.type === 'reasoning' ? 1 : 0);
    expect(h.subscriptions()).toBe(0);
  }
});

test('lost ownership and prompt failure dispose listeners without diagnostics', async () => {
  const h = harness();
  h.control.recordProgress = async () => false;
  await h.executor.start(task, h.control);
  expect(h.diagnostics).toEqual([]);
  expect(h.subscriptions()).toBe(0);
  const failed = harness({ async promptSession() { throw new Error('rejected'); } });
  await expect(failed.executor.start(task, failed.control)).rejects.toThrow('rejected');
  expect(failed.subscriptions()).toBe(0);
});

test('abort and shutdown release activity listeners even during blocked reads', async () => {
  for (const action of ['abort', 'shutdown']) {
    let finishRead, enteredRead;
    const entered = new Promise((resolve) => { enteredRead = resolve; });
    const h = harness({ readMessages: () => new Promise((resolve) => { finishRead = resolve; enteredRead(); }) });
    const result = h.executor.observe(task, h.control).catch(() => null);
    await entered;
    await h.executor[action](task);
    emit(h.registry);
    await flush();
    expect(h.stamps).toEqual([]);
    expect(h.subscriptions()).toBe(0);
    finishRead([output()]);
    await result;
  }
});

test('same-child retry and resume listen before posting and reject inherited output', async () => {
  for (const method of ['retryInPlace', 'resume']) {
    const prior = output('prior');
    prior.info.finish = 'abort';
    let finishPrompt;
    let prompted = false;
    const h = harness({
      promptSession: () => { prompted = true; return new Promise((resolve) => { finishPrompt = resolve; }); },
      readMessages: async () => prompted ? [prior, output()] : [prior],
    });
    const result = h.executor[method]({ ...task, executionKind: method === 'resume' ? 'resume' : 'retry_in_place' }, h.control);
    // Retry includes teardown/observation checkpoints before prompt submission.
    for (let i = 0; i < 10 && !finishPrompt; i++) await flush();
    expect(h.subscriptions()).toBe(1);
    emit(h.registry, 'prior');
    await flush();
    expect(h.stamps).toEqual([]);
    emit(h.registry);
    await flush();
    expect(h.stamps).toEqual([{ firstAssistantPartAt: 101 }]);
    finishPrompt();
    expect((await result).status).toBe('completed');
    expect(h.stamps.filter((v) => v.firstAssistantPartAt)).toHaveLength(1);
    expect(h.subscriptions()).toBe(0);
  }
});
