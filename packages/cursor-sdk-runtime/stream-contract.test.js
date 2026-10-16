import { describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCursorSdkRuntime } from './index.js';
import { pinnedAccumulatorSource } from './fixtures/pinned-accumulator.js';
import { createDiagnosticJournal } from '../harness-runtime/lib/journal.js';
import { createDiagnosticSanitizer } from '../harness-runtime/lib/sanitizer.js';

const fragments = [' /', '/', ' -', '-', '*', '*', '`', '`', '`', 'é', '👩‍💻', '\t', '\n', '  '];
const exact = fragments.join('');
const thought = ' \tReasoning.\n\n-*`é👩‍💻  ';
const fixture = `
  import { runInNewContext } from 'node:vm';
  if (process.argv[1]?.endsWith('worker.mjs')) console.log('fixture SDK import log');
  const PinnedAccumulator = runInNewContext(${JSON.stringify(pinnedAccumulatorSource)});
  const fragments = ${JSON.stringify(fragments)}, thought = ${JSON.stringify(thought)};
  const assistant = text => ({type:'assistant',message:{content:[{type:'text',text}]}});
  let failCleanup=false;
  const makeAgent = () => ({agentId:'agent-fixture',close(){if(failCleanup)throw Error('private cleanup failed');},async send({text},{onDelta}){
    const scenario=text.match(/stream-fixture:([a-z-]+)/)?.[1];
    failCleanup=scenario==='authcleanup'||scenario==='quotacleanup';
    if(scenario==='send-auth'||scenario==='send-quota') throw Object.assign(Error('fixture send refused'),{name:scenario==='send-auth'?'AuthenticationError':'RateLimitError',code:scenario==='send-auth'?'UNAUTHENTICATED':'RESOURCE_EXHAUSTED'});
    if(scenario==='overflow') for(let n=0;n<5000;n++) onDelta({type:'turn-ended',usage:{inputTokens:1}});
    const textDelta = text => ({type:'text-delta',text});
    const tool = {type:'tool-call-completed',callId:'boundary',toolCall:{type:'read'}};
    const trace = scenario==='running-tool' ? [textDelta('A'),{type:'tool-call-started',callId:'boundary',toolCall:{type:'read'}},textDelta('B'),tool,textDelta('C')]
      : scenario==='empty-thinking' ? [textDelta('A'),{type:'thinking-delta',text:''},textDelta('B')]
      : scenario==='completed-thinking-only' ? [textDelta('A'),{type:'thinking-completed',thinkingDurationMs:12},textDelta('B')]
      : scenario==='finalonly' ? [textDelta('  Final only.\\n')]
      : scenario==='empty-none' ? [tool,textDelta('')]
      : scenario==='empty-one' ? [textDelta('erase me'),tool,textDelta('')]
      : scenario==='trailing-tool' ? [textDelta('erase me'),tool]
      : ['absent','duplicates','drainfail','cancel'].includes(scenario) ? fragments.map(textDelta)
      : scenario==='quiettool'||scenario==='overflow'||scenario==='pipes'||scenario==='worker-overflow' ? []
      : [textDelta('Earlier step.'),{type:'thinking-delta',text:thought},{type:'thinking-completed',thinkingDurationMs:12},
         {type:'thinking-delta',text:'Second thought.'},tool,
         textDelta(scenario==='empty'?'':scenario==='same'?'last tail':'  corrected last\\n')];
    if(scenario==='late-reasoning'||scenario==='nested') trace.push({type:'thinking-delta',text:scenario==='nested'?'After nested preview.':'After final text.'});
    const accumulator = new PinnedAccumulator();
    for(const update of trace) await accumulator.apply(update);
    let release;
    const cancelGate = new Promise(resolve=>{release=resolve;});
    const run={id:'run-fixture',agentId:'agent-fixture',status:'running',
      async *stream(){
        if(scenario==='finalonly') return;
        if(['running-tool','empty-thinking','completed-thinking-only'].includes(scenario)) {
          for(const update of trace) {
            if(update.type==='text-delta') yield assistant(update.text);
            else if(update.type==='thinking-delta') yield {type:'thinking',text:update.text};
            else if(update.type==='thinking-completed') yield {type:'thinking',text:'',thinking_duration_ms:update.thinkingDurationMs};
            else yield {type:'tool_call',call_id:'boundary',name:'read',status:update.type==='tool-call-started'?'running':'completed'};
          }
          return;
        }
        if(scenario==='sdklogs') {console.log('fixture SDK log');console.info('fixture SDK info');console.debug('fixture SDK debug');}
        if(scenario==='empty-none') {yield {type:'tool_call',call_id:'empty',name:'read',status:'completed',result:'done'};return;}
        if(scenario==='empty-one'||scenario==='trailing-tool') {yield assistant('erase me');yield {type:'tool_call',call_id:'empty',name:'read',status:'completed',result:'done'};return;}
        if(scenario==='quiettool') {yield {type:'tool_call',call_id:'quiet',name:'read',status:'running'};await new Promise(resolve=>setTimeout(resolve,70));yield {type:'tool_call',call_id:'quiet',name:'read',status:'completed',result:'done'};return;}
        if(scenario==='worker-overflow') {yield assistant(fragments.join(''));yield assistant('x'.repeat(9*1024*1024));return;}
        if(scenario==='pipes') {yield assistant('🧪é'.repeat(20000));yield assistant(' end\t ');return;}
        if(scenario==='absent' || scenario==='duplicates' || scenario==='drainfail' || scenario==='cancel') {
          for(const text of fragments) {
            yield assistant(text);
            onDelta({type:'text-delta',text});
            await new Promise(resolve=>setTimeout(resolve,1));
            onDelta({type:'text-delta',text});
          }
          if(scenario==='drainfail') throw Error('fixture drain failed');
          if(scenario==='cancel') {const keepAlive=setInterval(()=>{},1000);try{await cancelGate; yield assistant('cancel tail');}finally{clearInterval(keepAlive);}}
          return;
        }
        yield assistant('Earlier step.');
        if(scenario==='slow-success') await new Promise(resolve=>setTimeout(resolve,200));
        yield {type:'thinking',text:thought};
        yield {type:'thinking',text:'',thinking_duration_ms:12};
        yield {type:'thinking',text:'Second thought.'};
        yield {type:'tool_call',call_id:'read-fixture',name:'read',status:'completed',args:{path:'fixture'},result:'read result'};
        yield assistant('last');
        onDelta({type:'text-delta',text:'Earlier step.'});
        onDelta({type:'thinking-delta',text:'callback thought'});
        onDelta({type:'tool-call-completed',callId:'duplicate-tool',toolCall:{name:'read',result:'callback'}});
        await new Promise(resolve=>setTimeout(resolve,30));
        yield {type:'status',status:'FINISHED'};
        yield assistant(' tail');
        onDelta({type:'text-delta',text:'last tail'});
        if(scenario==='late-reasoning') yield {type:'thinking',text:'After final text.'};
        if(scenario==='nested') onDelta({type:'tool-call-delta',callId:'read-fixture',taskUpdate:{type:'text-delta',text:'nested preview'}});
        if(scenario==='nested') yield {type:'thinking',text:'After nested preview.'};
        run.status='finished';
      },
      async wait(){
        if(scenario==='resolved-auth'||scenario==='resolved-quota'||scenario==='long-error') return {status:'error',error:{code:scenario==='resolved-auth'?'UNAUTHENTICATED':'RESOURCE_EXHAUSTED',message:scenario==='long-error'?'\\u0000'.repeat(30000):'fixture provider refused'}};
        if(scenario==='authfail'||scenario==='quotafail'||scenario==='authcleanup'||scenario==='quotacleanup') throw Object.assign(Error('fixture provider refused'),{name:scenario.startsWith('auth')?'AuthenticationError':'RateLimitError',code:scenario.startsWith('auth')?'UNAUTHENTICATED':'RESOURCE_EXHAUSTED'});
        if(scenario==='quiettool') {await new Promise(resolve=>setTimeout(resolve,75));return {status:'finished'};}
        if(scenario==='cancel') {await cancelGate; return {status:'finished',result:'cancel final'};}
        return {status:'finished',...(!['absent','duplicates','drainfail','overflow','pipes'].includes(scenario) && accumulator.finalAssistantText() !== undefined ? {result:accumulator.finalAssistantText()} : {})};
      },
      async conversation(){
        if(scenario==='missing-witness') return [];
        if(scenario==='bad-witness') return [{type:'agentConversationTurn',turn:{steps:[{type:'assistantMessage',message:{text:'inconsistent'}}]}}];
        if(scenario==='large-witness') return Array(4097).fill({type:'agentConversationTurn',turn:{steps:[]}});
        return accumulator.conversation();
      },
      async cancel(){run.status='cancelled';release();}
    };return run;
  }});
  export const Agent={async create(){return makeAgent();},async resume(){return makeAgent();}};
  export const Cursor={models:{async list(){return [{id:'fixture'}];}}};
`;

const setup = async (mode, timeoutMs = 500, options = {}) => {
  const root = path.resolve(import.meta.dirname, '../../.cache/qa');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'cursor-stream-contract-'));
  try {
  for (const name of await readdir(import.meta.dirname)) {
    if (/\.(mjs|js)$/.test(name) && !name.includes('.test.')) await copyFile(path.join(import.meta.dirname, name), path.join(directory, name));
  }
  const sdkRoot = path.join(directory, 'node_modules/@cursor/sdk');
  await mkdir(sdkRoot, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(sdkRoot, 'package.json'), '{"type":"module","exports":"./index.js"}');
  await writeFile(path.join(sdkRoot, 'index.js'), fixture);
  const sdk = await import(pathToFileURL(path.join(sdkRoot, 'index.js')).href);
  const emitted = [], timings = [], diagnostics = [];
  const sanitizer = createDiagnosticSanitizer();
  const journal = createDiagnosticJournal({ directory: path.join(directory, 'journal'), sanitizer, runtime: 'test' });
  const runtime = createCursorSdkRuntime({
    storageDir: path.join(directory, 'state'), env: {}, readAuth: () => ({ 'cursor-acp': { key: 'fixture-key' } }),
    loadSdk: async () => sdk, useNodeWorkerForPrompts: mode !== 'direct', usePersistentWorkerForPrompts: mode === 'persistent',
    nodeBinary: 'node', workerPath: path.join(directory, 'node-worker.mjs'), persistentWorkerPath: path.join(directory, 'persistent-worker.mjs'),
    getWorkspaceDiff: async () => '', emitEvent: event => emitted.push(event), recordTimingMark: mark => timings.push(mark), recordDiagnostic: entry => { diagnostics.push(entry); journal.enqueue(entry); }, streamIdleTimeoutMs: timeoutMs,
    ...options,
  });
  return { directory, runtime, emitted, timings, diagnostics, journal, sanitizer, async cleanup() { await runtime.dispose(); await journal.close(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
};
const send = (runtime, directory, scenario, sessionID = 'ses_fixture') => runtime.handlePromptAsync({sessionID,directory,body:{
  model:{providerID:'cursor-acp',modelID:'fixture'},messageID:'msg_fixture',parts:[{type:'text',text:'stream-fixture:'+scenario}],
}});
const readAssistant = async (runtime, predicate = row => row.info.finish, sessionID = 'ses_fixture') => {
  for (let attempt = 0; attempt < 500; attempt++) {
    const assistant = (await runtime.getSessionMessages(sessionID)).find(row => row.info.role === 'assistant');
    if (assistant && predicate(assistant)) return assistant;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('fixture assistant did not settle');
};

for (const mode of ['direct', 'persistent', 'oneshot']) {
  describe(`${mode} Cursor stream contract`, () => {
    for (const scenario of ['absent', 'duplicates', 'pipes', 'same', 'different', 'empty', 'finalonly', 'late-reasoning', 'nested', 'drainfail', 'cancel']) {
      test(scenario, async () => {
        const context = await setup(mode);
        const { runtime, directory, emitted, timings } = context;
        try {
          await send(runtime, directory, scenario);
          if (scenario === 'cancel') {
            await readAssistant(runtime, row => row.parts.some(part => part.type === 'text' && part.text === exact));
            await runtime.abortAndWait('ses_fixture');
          }
          const assistant = await readAssistant(runtime);
          const texts = assistant.parts.filter(part => part.type === 'text');
          if (scenario === 'absent' || scenario === 'duplicates' || scenario === 'cancel' || scenario === 'drainfail') {
            expect(texts.map(part => part.text)).toEqual([exact]);
          } else if (scenario === 'pipes') {
            expect(texts.map(part => part.text)).toEqual(['🧪é'.repeat(20000) + ' end\t ']);
          } else if (scenario === 'finalonly') {
            expect(texts.map(part => part.text)).toEqual(['  Final only.\n']);
          } else {
            expect(texts.map(part => part.text)).toEqual(['Earlier step.', scenario === 'empty' ? '' : scenario === 'same' ? 'last tail' : '  corrected last\n']);
            expect(texts.map(part => part.id)).toEqual(['msg_fixture_assistant_part_000001_text', 'msg_fixture_assistant_part_000005_text']);
            const reasoning = assistant.parts.filter(part => part.type === 'reasoning');
            expect(reasoning[0].text).toBe(thought);
            expect(reasoning[0].time.end).toBeNumber();
            expect(reasoning[1].text).toBe('Second thought.');
            expect(assistant.parts.filter(part => part.type === 'tool')).toHaveLength(1);
            if (scenario === 'late-reasoning' || scenario === 'nested') expect(reasoning).toHaveLength(3);
            const lastStreamDelta = emitted.findIndex(event => event.type === 'message.part.delta' && event.properties.delta === ' tail');
            const correction = emitted.findIndex(event => event.type === 'message.part.updated' && event.properties.part.text === '  corrected last\n');
            if (scenario !== 'empty' && scenario !== 'same') expect(correction).toBeGreaterThan(lastStreamDelta);
          }
          expect(assistant.info.finish).toBe(scenario === 'drainfail' ? 'error' : scenario === 'cancel' ? 'cancelled' : 'stop');
          if (scenario === 'drainfail') expect(assistant.info.error.name).toBe('CursorStreamPartialError');
          expect(assistant.parts.every(part => !String(part.text).includes('callback'))).toBe(true);
          if (mode === 'oneshot' && scenario === 'different') {
            const marks = timings.map(row => row.mark);
            expect(marks).toContain('cursor_run_create_started');
            expect(marks).toContain('cursor_run_created');
            expect(marks).toContain('cursor_provider_send_started');
            expect(marks).toContain('cursor_provider_send_accepted');
            expect(JSON.stringify(timings)).not.toContain('fixture-key');
            expect(JSON.stringify(timings)).not.toContain('Earlier step.');
          }
        } finally { await context.cleanup(); }
      }, 10_000);
    }
  });
}

test('direct callback FIFO overflow is partial and does not publish the final result', async () => {
  const context = await setup('direct');
  try {
    await send(context.runtime, context.directory, 'overflow');
    const assistant = await readAssistant(context.runtime);
    expect(assistant.info.finish).toBe('error');
    expect(assistant.info.error).toEqual({name:'CursorStreamPartialError',message:'Cursor stream incomplete (CURSOR_STREAM_QUEUE_OVERFLOW).'});
  } finally { await context.cleanup(); }
}, 10_000);

for (const mode of ['persistent', 'oneshot']) {
  test(`${mode} rejects an oversized SDK event as partial`, async () => {
    const context = await setup(mode);
    try {
      await send(context.runtime, context.directory, 'worker-overflow');
      const assistant = await readAssistant(context.runtime);
      expect(assistant.parts.filter(part => part.type === 'text').map(part => part.text)).toEqual([exact]);
      expect(assistant.info.finish).toBe('error');
      expect(assistant.info.error).toEqual({name:'CursorStreamPartialError',message:'Cursor stream incomplete (CURSOR_STREAM_QUEUE_OVERFLOW).'});
    } finally { await context.cleanup(); }
  }, 10_000);
}

for (const mode of ['direct', 'persistent', 'oneshot']) {
  test(`${mode} does not apply a drain deadline to a live quiet tool`, async () => {
    const context = await setup(mode, 20);
    try {
      await send(context.runtime, context.directory, 'quiettool');
      const assistant = await readAssistant(context.runtime);
      expect(assistant.info.finish).toBe('stop');
      expect(assistant.info.error).toBeUndefined();
      expect(assistant.parts.find(part => part.type === 'tool').state.status).toBe('completed');
    } finally { await context.cleanup(); }
  }, 10_000);
}

for (const mode of ['direct', 'persistent', 'oneshot']) {
  test(`${mode} keeps an explicit empty final part without fabricating a tool summary`, async () => {
    const context = await setup(mode);
    try {
      await send(context.runtime, context.directory, 'empty-one');
      const assistant = await readAssistant(context.runtime);
      expect(assistant.info.finish).toBe('stop');
      expect(assistant.parts.map(part => part.type)).toEqual(['text', 'tool', 'text']);
      expect(assistant.parts[0]).toMatchObject({id:'msg_fixture_assistant_part_000001_text',text:'erase me'});
      expect(assistant.parts[2].text).toBe('');
    } finally { await context.cleanup(); }
  }, 10_000);
}

for (const mode of ['direct', 'persistent', 'oneshot']) {
  test(`${mode} preserves explicit empty final-only output without inventing assistant text`, async () => {
    const context = await setup(mode);
    try {
      await send(context.runtime, context.directory, 'empty-none');
      const assistant = await readAssistant(context.runtime);
      expect(assistant.info.finish).toBe('stop');
      expect(assistant.parts.map(part => part.type)).toEqual(['tool', 'text']);
      expect(assistant.parts[1].text).toBe('');
    } finally { await context.cleanup(); }
  }, 10_000);
}

for (const mode of ['direct', 'persistent', 'oneshot']) {
  for (const scenario of ['authfail','quotafail','missing-witness','bad-witness','large-witness']) test(`${mode} keeps ${scenario} classification and buffered content`, async () => {
    const context = await setup(mode);
    try {
      await send(context.runtime, context.directory, scenario);
      const assistant = await readAssistant(context.runtime);
      expect(assistant.parts.filter(part=>part.type==='text').map(part=>part.text)).toEqual(['Earlier step.','last tail']);
      expect(assistant.info.finish).toBe('error');
      expect(assistant.info.error.name).toBe(scenario.endsWith('witness')?'CursorStreamPartialError':scenario.startsWith('auth')?'AuthenticationError':'RateLimitError');
      if(scenario.endsWith('witness')) expect(assistant.info.error.message).toContain('CURSOR_STREAM_FINAL_ASSOCIATION_INVALID');
      else expect(assistant.info.error.code).toBe(scenario.startsWith('auth')?'UNAUTHENTICATED':'RESOURCE_EXHAUSTED');
      if (scenario.endsWith('witness')) {
        await context.journal.flush();
        const records = (await context.journal.readRecords()).filter(row => row.event === 'cursor_final_association');
        expect(records.map(row => row.payload)).toEqual([{ assistantMessageID: assistant.info.id, streamedParts: 2,
          state: 'unavailable', reason: scenario === 'large-witness' ? 'limit' : 'mismatch', code: 'CURSOR_STREAM_FINAL_ASSOCIATION_INVALID' }]);
        expect(context.sanitizer.sanitizeExportValue(records)).toEqual(records);
      }
      expect(JSON.stringify(context.diagnostics)).not.toMatch(/Earlier step|last tail|fixture provider|fixture-key|stream-fixture/);
    } finally {await context.cleanup();}
  }, 10_000);
}

for (const mode of ['direct','persistent','oneshot']) test(`${mode} trailing tool retains last SDK assistant identity`, async () => {
  const context=await setup(mode);
  try {
    await send(context.runtime,context.directory,'trailing-tool');
    const assistant=await readAssistant(context.runtime);
    expect(assistant.info.finish).toBe('stop');
    expect(assistant.parts.map(part=>part.type)).toEqual(['text','tool']);
    expect(assistant.parts[0]).toMatchObject({id:'msg_fixture_assistant_part_000001_text',text:'erase me'});
  } finally {await context.cleanup();}
},10_000);

for (const mode of ['persistent','oneshot']) test(`${mode} observes unawaited SDK callback output overflow before completion`, async () => {
  const context=await setup(mode);
  try {
    await send(context.runtime,context.directory,'overflow');
    const assistant=await readAssistant(context.runtime);
    expect(assistant.info.finish).toBe('error');
    expect(assistant.info.error).toEqual({name:'CursorStreamPartialError',message:'Cursor stream incomplete (CURSOR_STREAM_QUEUE_OVERFLOW).'});
  } finally {await context.cleanup();}
},10_000);

for (const scenario of ['authcleanup','quotacleanup']) test(`one-shot preserves ${scenario} primary identity when cleanup also fails`, async () => {
  const context=await setup('oneshot');
  try {
    await send(context.runtime,context.directory,scenario);
    const assistant=await readAssistant(context.runtime);
    expect(assistant.info.finish).toBe('error');
    expect(assistant.info.error).toMatchObject({name:scenario==='authcleanup'?'AuthenticationError':'RateLimitError',code:scenario==='authcleanup'?'UNAUTHENTICATED':'RESOURCE_EXHAUSTED'});
    expect(assistant.info.error.message).toContain('fixture provider refused');
    expect(assistant.info.error.message).toContain('cleanup also failed');
    expect(assistant.parts.filter(part=>part.type==='text').map(part=>part.text)).toEqual(['Earlier step.','last tail']);
  } finally {await context.cleanup();}
},10_000);

for (const mode of ['direct', 'persistent', 'oneshot']) {
  for (const scenario of ['running-tool', 'empty-thinking', 'completed-thinking-only']) test(`${mode} preserves the pinned ${scenario} boundary through persistence and journal`, async () => {
    const context = await setup(mode);
    try {
      await send(context.runtime, context.directory, scenario);
      const assistant = await readAssistant(context.runtime);
      const expected = scenario === 'running-tool' ? [['text','AB'],['tool',undefined],['text','C']]
        : scenario === 'empty-thinking' ? [['text','A'],['reasoning',''],['text','B']] : [['text','AB']];
      expect(assistant.info.finish).toBe('stop');
      expect(assistant.info.error).toBeUndefined();
      expect(assistant.parts.map(part => [part.type, part.text])).toEqual(expected);
      const reloaded = createCursorSdkRuntime({ storageDir: path.join(context.directory, 'state'), env: {} });
      try { expect((await reloaded.getSessionMessages('ses_fixture')).find(row => row.info.role === 'assistant')).toEqual(assistant); }
      finally { await reloaded.dispose(); }
      await context.journal.flush();
      const rows = (await context.journal.readRecords()).filter(row => row.event === 'cursor_final_association');
      const lastText = assistant.parts.filter(part => part.type === 'text').at(-1);
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toEqual({ assistantMessageID: assistant.info.id, partID: lastText.id,
        assistantOrdinal: scenario === 'completed-thinking-only' ? 1 : 2,
        streamedParts: scenario === 'completed-thinking-only' ? 1 : 2,
        previousLength: lastText.text.length, finalLength: lastText.text.length, equal: true, state: 'matched' });
      expect(context.sanitizer.sanitizeExportValue(rows[0])).toEqual(rows[0]);
    } finally { await context.cleanup(); }
  }, 10_000);

  for (const scenario of ['resolved-auth', 'resolved-quota', 'send-auth', 'send-quota', 'long-error']) test(`${mode} preserves ${scenario} provider identity`, async () => {
    const context = await setup(mode);
    try {
      await send(context.runtime, context.directory, scenario);
      const assistant = await readAssistant(context.runtime);
      expect(assistant.info.finish).toBe('error');
      expect(assistant.info.error).toMatchObject({
        name: scenario.startsWith('send-') ? scenario === 'send-auth' ? 'AuthenticationError' : 'RateLimitError' : 'CursorAgentError',
        code: scenario.endsWith('auth') ? 'UNAUTHENTICATED' : 'RESOURCE_EXHAUSTED',
      });
      if (!scenario.startsWith('send-')) expect(assistant.parts.filter(part => part.type === 'text').map(part => part.text)).toEqual(['Earlier step.','last tail']);
      if (scenario === 'long-error' && mode !== 'direct') expect(assistant.info.error.message.length).toBeLessThanOrEqual(1025);
    } finally { await context.cleanup(); }
  }, 10_000);
}

for (const mode of ['persistent', 'oneshot']) test(`${mode} SDK startup and stream console logging stay outside strict stdout framing`, async () => {
  const context = await setup(mode);
  try {
    await send(context.runtime, context.directory, 'sdklogs');
    const assistant = await readAssistant(context.runtime);
    expect(assistant.info.finish).toBe('stop');
    expect(assistant.parts.filter(part => part.type === 'text').map(part => part.text)).toEqual(['Earlier step.','  corrected last\n']);
  } finally { await context.cleanup(); }
}, 10_000);

test('persistent bounded provider reports preserve a concurrent sibling and subsequent requests', async () => {
  const context = await setup('persistent');
  try {
    await send(context.runtime, context.directory, 'slow-success', 'ses_sibling');
    await readAssistant(context.runtime, row => row.parts.some(part => part.text === 'Earlier step.'), 'ses_sibling');
    await send(context.runtime, context.directory, 'long-error');
    expect((await readAssistant(context.runtime)).info.error.code).toBe('RESOURCE_EXHAUSTED');
    const sibling = await readAssistant(context.runtime, row => row.info.finish, 'ses_sibling');
    expect(sibling.info.finish).toBe('stop');
    expect(sibling.parts.filter(part => part.type === 'text').map(part => part.text)).toEqual(['Earlier step.','  corrected last\n']);
    await send(context.runtime, context.directory, 'running-tool', 'ses_next');
    expect((await readAssistant(context.runtime, row => row.info.finish, 'ses_next')).info.finish).toBe('stop');
  } finally { await context.cleanup(); }
}, 10_000);

const waitForPresentation = async (predicate) => {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('presentation fixture did not reach its boundary');
};

for (const mode of ['direct', 'persistent', 'oneshot']) {
  test(`${mode} reports only drained, validated finalization until durable terminal persistence`, async () => {
    const updates = [], retired = [], order = [];
    let release;
    const persisted = new Promise(resolve => { release = resolve; });
    let terminalEntered = false;
    const context = await setup(mode, 500, {
      onPresentationProgress: value => { updates.push(value); order.push(value.phase); },
      onPresentationOwnerRetired: ownerID => retired.push(ownerID),
      onPersistRecord: async ({ record }) => {
        if (record.info.role === 'assistant' && record.info.finish) { terminalEntered = true; await persisted; }
      },
      emitEvent: event => order.push(event.type === 'session.status' ? event.properties.status.type : event.type),
    });
    try {
      await send(context.runtime, context.directory, 'different');
      await waitForPresentation(() => terminalEntered);
      expect(updates).toHaveLength(1);
      const begin = updates[0];
      expect(begin).toEqual({ provider: 'cursor', ownerID: expect.any(String), sessionID: 'ses_fixture',
        generation: expect.any(String), sequence: 1, objectiveID: 'msg_fixture', assistantID: 'msg_fixture_assistant',
        stepID: null, attemptID: null, phase: 'finalizing', progress: 0 });
      expect(order.indexOf('finalizing')).toBeGreaterThan(order.lastIndexOf('message.part.delta'));
      expect(order).not.toContain('idle');
      release();
      await waitForPresentation(() => order.includes('idle'));
      expect(updates.map(row => [row.phase, row.progress, row.sequence])).toEqual([
        ['finalizing', 0, 1], ['finalizing', 1, 2], ['cleared', 1, 3],
      ]);
      expect(updates.every(row => row.generation === begin.generation && row.ownerID === begin.ownerID)).toBe(true);
      expect(order.indexOf('cleared')).toBeLessThan(order.indexOf('idle'));
      await context.runtime.dispose();
      expect(retired).toEqual([begin.ownerID]);
    } finally { release(); await context.cleanup(); }
  }, 10_000);

  for (const scenario of ['drainfail', 'bad-witness', 'resolved-auth', 'cancel']) {
    test(`${mode} never presents finalizing for ${scenario}`, async () => {
      const updates = [];
      const context = await setup(mode, 500, { onPresentationProgress: value => updates.push(value) });
      try {
        await send(context.runtime, context.directory, scenario);
        if (scenario === 'cancel') {
          await readAssistant(context.runtime, row => row.parts.some(part => part.text === exact));
          await context.runtime.abortAndWait('ses_fixture');
        }
        await readAssistant(context.runtime);
        expect(updates).toEqual([]);
      } finally { await context.cleanup(); }
    }, 10_000);
  }

  for (const action of ['stop', 'replacement', 'delete', 'retire', 'persist-failure']) {
    test(`${mode} fences finalization across ${action} without stale progress`, async () => {
      const updates = [], retired = [];
      let release, terminalEntered = false;
      const gate = new Promise(resolve => { release = resolve; });
      const context = await setup(mode, 500, {
        onPresentationProgress: value => {
          updates.push(value);
          if (action === 'stop' || action === 'persist-failure') throw Error('observer refused');
        },
        onPresentationOwnerRetired: ownerID => retired.push(ownerID),
        logger: { error() {}, warn() {} },
        onPersistRecord: async ({ record }) => {
          if (record.info.id === 'msg_fixture_assistant' && record.info.finish) {
            terminalEntered = true;
            await gate;
            if (action === 'persist-failure') throw new Error('fixture persistence refused');
          }
        },
      });
      try {
        await send(context.runtime, context.directory, 'different');
        await waitForPresentation(() => terminalEntered);
        const generation = updates[0].generation;
        let operation;
        if (action === 'stop') operation = context.runtime.abortSession('ses_fixture');
        if (action === 'delete') operation = context.runtime.deleteSessionState('ses_fixture');
        if (action === 'retire') operation = context.runtime.dispose();
        if (action === 'replacement') operation = context.runtime.handlePromptAsync({ sessionID: 'ses_fixture', directory: context.directory,
          body: { model: { providerID: 'cursor-acp', modelID: 'fixture' }, messageID: 'msg_next', parts: [{ type: 'text', text: 'stream-fixture:different' }] } });
        if (action !== 'persist-failure') await waitForPresentation(() => updates.some(row => row.phase === 'cleared'));
        release();
        await operation;
        if (action === 'replacement') await waitForPresentation(() => updates.some(row => row.objectiveID === 'msg_next' && row.phase === 'cleared'));
        else if (action === 'persist-failure') await waitForPresentation(() => updates.some(row => row.phase === 'cleared'));
        const original = updates.filter(row => row.generation === generation);
        expect(original.map(row => [row.phase, row.progress])).toEqual([['finalizing', 0], ['cleared', 0]]);
        expect(updates.map(row => row.sequence)).toEqual(updates.map((_, i) => i + 1));
        if (action === 'replacement') expect(updates.find(row => row.objectiveID === 'msg_next').generation).not.toBe(generation);
        if (action === 'retire') expect(retired).toEqual([updates[0].ownerID]);
      } finally { release(); await context.cleanup(); }
    }, 10_000);
  }

  test(`${mode} presentation observer errors cannot replace final persistence or cancellation`, async () => {
    let calls = 0;
    const context = await setup(mode, 500, {
      onPresentationProgress: () => { calls++; if (calls % 2) throw Error('observer refused'); return Promise.reject(Error('observer rejected')); },
      onPresentationOwnerRetired: () => { throw Error('retirement refused'); },
    });
    try {
      await send(context.runtime, context.directory, 'different');
      expect((await readAssistant(context.runtime)).info.finish).toBe('stop');
      expect(calls).toBe(3);
      await send(context.runtime, context.directory, 'cancel', 'ses_cancel_observer');
      await readAssistant(context.runtime, row => row.parts.some(part => part.text === exact), 'ses_cancel_observer');
      await context.runtime.abortAndWait('ses_cancel_observer');
      expect((await readAssistant(context.runtime, row => row.info.finish, 'ses_cancel_observer')).info.finish).toBe('cancelled');
    } finally { await context.cleanup(); }
  }, 10_000);
}

for (const finalStatus of [null, 'unknown']) test(`unknown final proof (${finalStatus}) cannot present finalizing`, async () => {
  const updates = [];
  const context = await setup('direct', 500, {
    onPresentationProgress: value => updates.push(value),
    createPromptRun: async () => ({
      finalResultAvailable: finalStatus !== null,
      async *stream() { yield { type: 'assistant', message: { content: [{ type: 'text', text: 'fixture' }] } }; },
      waitFinalResult: async () => ({ ok: true, finalStatus }),
    }),
  });
  try {
    await send(context.runtime, context.directory, 'different');
    await readAssistant(context.runtime);
    expect(updates).toEqual([]);
  } finally { await context.cleanup(); }
});

test('Stop between drained stream and late final result cannot reintroduce finalizing', async () => {
  const updates = [];
  let release, waits = 0;
  const final = new Promise(resolve => { release = resolve; });
  const context = await setup('direct', 500, {
    onPresentationProgress: value => updates.push(value),
    createPromptRun: async () => ({
      async *stream() { yield { type: 'assistant', message: { content: [{ type: 'text', text: 'fixture' }] } }; },
      waitFinalResult: async () => { waits++; await final; return { ok: true, finalStatus: 'success' }; },
      cancel: async () => {},
    }),
  });
  try {
    await send(context.runtime, context.directory, 'different');
    await waitForPresentation(() => waits === 2);
    await context.runtime.abortSession('ses_fixture');
    release();
    await readAssistant(context.runtime);
    expect(updates).toEqual([]);
  } finally { release(); await context.cleanup(); }
});

for (const stage of ['model-selection', 'before-prompt', 'owned-prompt']) test(`presentation preparation cleanup preserves ${stage} refusal`, async () => {
  const updates = [], retired = [];
  const refusal = Object.assign(new Error('fixture admission refused'), { code: 'fixture_admission_refused' });
  const context = await setup('direct', 500, {
    onPresentationProgress: value => updates.push(value),
    onPresentationOwnerRetired: ownerID => retired.push(ownerID),
    ...(stage === 'before-prompt' ? { executionAdapter: { beforePrompt: async () => { throw refusal; } } } : {}),
    ...(stage === 'owned-prompt' ? { ownedPrompt: async () => { throw refusal; } } : {}),
  });
  try {
    if (stage === 'model-selection') {
      await expect(context.runtime.handlePromptAsync({ sessionID: 'ses_refused', directory: context.directory,
        body: { model: { providerID: 'cursor-acp', modelID: 'missing-model' }, parts: [{ type: 'text', text: 'fixture' }] } })).rejects.toMatchObject({ code: 'cursor_model_unavailable' });
      await send(context.runtime, context.directory, 'different');
      await readAssistant(context.runtime);
      expect(updates.map(row => row.phase)).toEqual(['finalizing', 'finalizing', 'cleared']);
      expect(updates.every(row => row.sessionID === 'ses_fixture')).toBe(true);
    } else {
      await expect(send(context.runtime, context.directory, 'different')).rejects.toBe(refusal);
      expect(updates).toEqual([]);
    }
    await context.runtime.dispose();
    await context.runtime.dispose();
    expect(retired).toHaveLength(1);
  } finally { await context.cleanup(); }
});
