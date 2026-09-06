import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  createLoopbackOpenCodeFixture,
  PERF_CHILD_SESSION_IDS,
  PERF_PARENT_SESSION_ID,
} from './loopback-opencode-fixture.mjs';

describe('loopback OpenCode performance fixture', () => {
  const post = (url, body) => fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const waitIdle = async (fixture) => {
    const deadline = Date.now() + 3000;
    while (fixture.getState().activePrompts && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve,10));
    assert.equal(fixture.getState().activePrompts,0);
  };
  it('preserves exact historical response byte sizes through the production fetched-text normalizer', async () => {
    const fixture = await createLoopbackOpenCodeFixture({ directory: '/qa-history-fidelity' });
    const texts = [];
    try {
      for (const textBytes of [32, 256, 4096, 65536]) {
        fixture.seedHistory(PERF_PARENT_SESSION_ID, { turns: 2, textBytes });
        const rows = await fetch(`${fixture.origin}/session/${PERF_PARENT_SESSION_ID}/message`).then(response => response.json());
        for (const row of rows.filter(row => row.info.role === 'assistant')) {
          const text = row.parts[0].text;
          assert.equal(Buffer.byteLength(text), textBytes);
          assert.match(text, /^History response [12]\. /);
          texts.push(text);
        }
      }
      // Bun is the repository runtime and resolves the real TypeScript module;
      // do not duplicate the production normalization algorithm in this test.
      const normalized = JSON.parse(execFileSync('bun', ['-e', `
        import { normalizeAssistantPartText } from './packages/ui/src/sync/part-delta.ts';
        const texts=JSON.parse(await Bun.stdin.text());
        process.stdout.write(JSON.stringify(texts.map(text=>normalizeAssistantPartText(text,'text'))));
      `], { cwd: new URL('../../', import.meta.url), input: JSON.stringify(texts), encoding: 'utf8', maxBuffer: 1024 * 1024 }));
      assert.deepEqual(normalized, texts);
    } finally { await fixture.close(); }
  });
  it('delays only the exact canonical user echo with bounded one-use next-session configuration', async () => {
    const fixture = await createLoopbackOpenCodeFixture({directory:'/qa-delayed-user'});
    const controller = new AbortController();
    let reading;
    try {
      for (const canonicalUserDelayMs of [-1,10_001,1.5,'200']) {
        assert.throws(() => fixture.configureNextCreatedSessionPrompt({canonicalUserDelayMs}),/Invalid fixture prompt/);
      }
      fixture.configureNextCreatedSessionPrompt({canonicalUserDelayMs:300,hold:true,chunks:1,intervalMs:10});
      assert.throws(() => fixture.configureNextCreatedSessionPrompt({}),/already configured/);
      const session = await post(`${fixture.origin}/session`,{}).then(response => response.json());
      const route = `${fixture.origin}/session/${session.id}`;
      const received = [];
      const stream = await fetch(`${fixture.origin}/global/event`,{signal:controller.signal});
      reading = (async () => {
        let pending = '';const decoder = new TextDecoder();
        for await (const chunk of stream.body) {
          pending += decoder.decode(chunk,{stream:true});
          const frames = pending.split('\n\n');pending = frames.pop();
          for (const frame of frames) {
            const data = frame.split('\n').find(line => line.startsWith('data: '));
            if (data) received.push(JSON.parse(data.slice(6)).payload);
          }
        }
      })().catch(error => {if(error.name!=='AbortError')throw error;});
      const input = {messageID:'msg_delayed_user',agent:'build',variant:'low',model:{providerID:'fixture',modelID:'fixture-model'},parts:[{type:'text',text:'Keep Low'}]};
      assert.equal((await post(route+'/prompt_async',input)).status,204);
      const during = await fetch(route+'/message').then(response => response.json());
      assert.equal(during.some(row => row.info.id === input.messageID),false);
      assert.equal((await fetch(route+'/message/'+input.messageID)).status,404);
      assert.equal(during.at(-1).info.parentID,input.messageID);
      assert.equal(fixture.getState().receivedPrompts[0].variant,'low');
      assert.equal(fixture.getState().canonicalUserDelays[0].releasedAt,null);
      await new Promise(resolve => setTimeout(resolve,30));
      assert.ok(received.some(event => event.type==='session.status' && event.properties.status.type==='busy'));
      assert.ok(received.some(event => event.type==='message.updated' && event.properties.info.parentID===input.messageID));
      assert.equal(received.some(event => event.properties.info?.id===input.messageID || event.properties.part?.messageID===input.messageID),false);
      const deadline = Date.now()+2000;
      while (!fixture.getState().canonicalUserDelays[0].releasedAt && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
      const released = await fetch(route+'/message').then(response => response.json());
      const user = released.filter(row => row.info.id===input.messageID);
      assert.equal(user.length,1);assert.equal(user[0].info.model.variant,'low');
      assert.equal(user[0].parts[0].text,'Keep Low');
      const observation = fixture.getState().canonicalUserDelays[0];
      assert.ok(observation.releasedAt>=observation.releaseDueAt-2);
      await new Promise(resolve => setTimeout(resolve,20));
      assert.equal(received.filter(event=>event.type==='message.updated'&&event.properties.info.id===input.messageID).length,1);
      fixture.releasePrompt(session.id);await waitIdle(fixture);
      assert.equal((await post(route+'/prompt_async',input)).status,409,'Delayed rows must keep duplicate identity protection');
      const second = await post(`${fixture.origin}/session`,{}).then(response => response.json());
      fixture.configureNextPrompt(second.id,{chunks:1,intervalMs:10});
      await post(`${fixture.origin}/session/${second.id}/prompt_async`,{...input,messageID:'msg_no_delay'});
      assert.ok((await fetch(`${fixture.origin}/session/${second.id}/message`).then(response=>response.json())).some(row=>row.info.id==='msg_no_delay'));
      assert.equal(fixture.getState().canonicalUserDelays.length,1);
    } finally {controller.abort();await reading;await fixture.close();}
  });
  it('echoes client message identity, persists parts, and stops an owned prompt on abort', async () => {
    const fixture = await createLoopbackOpenCodeFixture({ directory: '/qa-fixture' });
    try {
      const route = `${fixture.origin}/session/${PERF_PARENT_SESSION_ID}`;
      const before = await fetch(`${route}/message`).then((r) => r.json());
      assert.equal(before.length, 1, 'idle fixture must not seed an unfinished assistant');
      assert.deepEqual(await fetch(`${fixture.origin}/session?directory=/other`).then((r) => r.json()), []);
      assert.equal((await fetch(`${route}/message?directory=/other`)).status, 404);
      const config = await fetch(`${fixture.origin}/config/providers`).then((r) => r.json());
      const catalog = await fetch(`${fixture.origin}/provider`).then((r) => r.json());
      assert.equal(config.providers[0].id, 'fixture');
      assert.deepEqual(config.providers, catalog.all);
      assert.ok(config.providers[0].models[config.default.fixture]);
      const response = await fetch(`${route}/prompt_async`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageID: 'msg_client_qa', parts: [
          { type: 'text', text: 'fixture prompt' },
          { type: 'file', mime: 'text/plain', url: 'file:///qa-fixture/example.txt' },
        ] }),
      });
      assert.equal(response.status, 204);
      await fetch(`${route}/abort`, { method: 'POST' });
      const rows = await fetch(`${route}/message`).then((r) => r.json());
      assert.equal(rows.filter((row) => row.info.id === 'msg_client_qa').length, 1);
      assert.deepEqual(rows.at(-2).parts.map((part) => part.type), ['text', 'file']);
      assert.equal(rows.at(-1).info.parentID, 'msg_client_qa');
      assert.ok(rows.at(-1).info.time.completed);
      assert.equal(fixture.getState().activePrompts, 0);
      assert.equal((await fetch(`${fixture.origin}/session/status`).then((r) => r.json()))[PERF_PARENT_SESSION_ID].type, 'idle');
    } finally { await fixture.close(); }
  });

  it('serves one parent, three children, and deterministic concurrent deltas', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devryan-perf-fixture-'));
    const fixture = await createLoopbackOpenCodeFixture({ directory });
    try {
      const sessions = await fetch(`${fixture.origin}/session`).then((response) => response.json());
      assert.equal(sessions.length, 4);
      assert.equal(sessions[0].id, PERF_PARENT_SESSION_ID);
      assert.deepEqual(
        sessions.filter((session) => session.parentID === PERF_PARENT_SESSION_ID).map((session) => session.id),
        PERF_CHILD_SESSION_IDS,
      );

      fixture.startScenario('four-stream');
      await new Promise((resolve) => setTimeout(resolve, 40));
      const state = fixture.getState();
      for (const sessionID of [PERF_PARENT_SESSION_ID, ...PERF_CHILD_SESSION_IDS]) {
        assert.ok(state.textLengths[sessionID] > 0);
      }
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('paginates real history with disjoint before cursors and rejects invalid coverage', async () => {
    const fixture = await createLoopbackOpenCodeFixture({directory:'/qa-history'});
    try {
      fixture.seedHistory(PERF_PARENT_SESSION_ID,{turns:113,textBytes:256});
      const base = `${fixture.origin}/session/${PERF_PARENT_SESSION_ID}/message`;
      const seen = new Set(); let before;
      do {
        const response = await fetch(base + '?limit=50' + (before ? '&before=' + before : ''));
        assert.equal(response.status,200);
        const rows = await response.json();
        assert.ok(rows.length > 0 && rows.length <= 50);
        for (const row of rows) {assert.equal(seen.has(row.info.id),false);seen.add(row.info.id);}
        before=response.headers.get('x-next-cursor');
        if (before) assert.equal(before,rows[0].info.id);
      } while (before);
      assert.equal(seen.size,227);
      assert.equal((await fetch(base + '?before=missing&limit=50')).status,400);
      assert.equal((await fetch(base + '?limit=-1')).status,400);
      assert.equal(fixture.getState().olderMessageRequestCounts[PERF_PARENT_SESSION_ID],4);
      assert.throws(() => fixture.seedHistory(PERF_PARENT_SESSION_ID,{turns:2000,textBytes:65536}),/history size/);
    } finally {await fixture.close();}
  });

  it('keeps seeded message and part identities unique across sessions with stable chronological IDs', async () => {
    const fixture = await createLoopbackOpenCodeFixture({directory:'/qa-history-identities'});
    try {
      const messageIDs = new Set(); const partIDs = new Set();
      for (const sessionID of [PERF_PARENT_SESSION_ID, ...PERF_CHILD_SESSION_IDS]) {
        fixture.seedHistory(sessionID,{turns:180,textBytes:256});
        const read = () => fetch(`${fixture.origin}/session/${sessionID}/message?limit=1000`).then(r=>r.json());
        const rows = await read();
        const seeded = rows.filter(row => row.parts.some(part => part.id.startsWith('prt_history_')));
        assert.equal(seeded.length,360);
        assert.deepEqual(seeded.map(row=>row.info.id),seeded.map(row=>row.info.id).sort());
        for (const row of rows) {
          assert.equal(messageIDs.has(row.info.id),false);messageIDs.add(row.info.id);
          for (const part of row.parts) {
            assert.equal(partIDs.has(part.id),false);partIDs.add(part.id);
            assert.equal(part.messageID,row.info.id);
          }
        }
        fixture.seedHistory(sessionID,{turns:180,textBytes:256});
        assert.deepEqual((await read()).map(row=>row.info.id),rows.map(row=>row.info.id));
      }
    } finally {await fixture.close();}
  });

  it('captures exact send configuration while delayed reasoning and tools survive settlement', async () => {
    const fixture = await createLoopbackOpenCodeFixture({directory:'/qa-reasoning'});
    try {
      const route = `${fixture.origin}/session/${PERF_PARENT_SESSION_ID}`;
      fixture.configureNextPrompt(PERF_PARENT_SESSION_ID,{reasoning:'delayed',reasoningDelayChunks:1,reasoningText:'Read the current plan.',tool:'completed',hold:true,chunks:3,intervalMs:10});
      const input = {messageID:'msg_config',agent:'orchestrator',model:{providerID:'fixture',modelID:'fixture-model'},variant:null,tools:{edit:false},parts:[{type:'text',text:'Plan this task'}]};
      assert.equal((await post(`${route}/prompt_async`,input)).status,204);
      const initial = (await fetch(`${route}/message`).then((response) => response.json())).at(-1);
      assert.equal(initial.parts.find((part) => part.type === 'reasoning').text,'');
      assert.equal(initial.parts.find((part) => part.type === 'tool').state.status,'running');
      fixture.setPromptReasoning(PERF_PARENT_SESSION_ID,'Read the current plan.');
      const latePart=(await fetch(`${route}/message`).then((response) => response.json())).at(-1).parts.find((part) => part.type==='reasoning');
      assert.equal(latePart.text,'Read the current plan.');
      assert.equal((await post(`${route}/prompt_async`,{...input,messageID:'msg_busy'})).status,409);
      fixture.releasePrompt(PERF_PARENT_SESSION_ID); await waitIdle(fixture);
      const final = (await fetch(`${route}/message`).then((response) => response.json())).at(-1);
      assert.equal(final.parts.find((part) => part.type === 'reasoning').text,'Read the current plan.');
      assert.ok(final.parts.find((part) => part.type === 'reasoning').time.end);
      assert.equal(final.parts.find((part) => part.type === 'tool').state.status,'completed');
      assert.equal(final.info.agent,'orchestrator');
      assert.throws(() => fixture.setPromptReasoning(PERF_PARENT_SESSION_ID,'Too late'),/No active fixture/);
      const captured = fixture.getState().receivedPrompts[0];
      assert.equal(captured.variant,null); assert.equal(captured.agent,'orchestrator');assert.deepEqual(captured.tools,{edit:false});
      captured.model.modelID='modified'; assert.equal(fixture.getState().receivedPrompts[0].model.modelID,'fixture-model');
      assert.equal((await post(`${route}/prompt_async`,input)).status,409);
      assert.equal(fixture.getState().receivedPrompts.length,1);
    } finally {await fixture.close();}
  });

  it('suppresses bounded exact-message SSE frames while canonical HTTP state and other sessions continue', async () => {
    const fixture = await createLoopbackOpenCodeFixture({ directory: '/qa-missing-events' });
    try {
      const eventText = fetch(`${fixture.origin}/global/event`).then(response => response.text());
      const connectionDeadline = Date.now() + 1000;
      while (!fixture.getState().sseClientCount && Date.now() < connectionDeadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(fixture.getState().sseConnectionCount, 1);
      const route = `${fixture.origin}/session/${PERF_PARENT_SESSION_ID}`;
      fixture.configureNextPrompt(PERF_PARENT_SESSION_ID, { hold: true, chunks: 3, intervalMs: 10 });
      await post(`${route}/prompt_async`, { messageID: 'msg_missing_events', parts: [{ type: 'text', text: 'Recover this exact turn' }] });
      const assistant = (await fetch(`${route}/message`).then(response => response.json())).at(-1);
      const rule = { sessionID: PERF_PARENT_SESSION_ID, messageID: assistant.info.id,
        types: ['message.part.delta', 'message.part.updated', 'message.updated', 'session.status'], maximumEvents: 16, durationMs: 1000 };
      for (const patch of [{ messageID: 'missing' }, { maximumEvents: 129 }, { durationMs: 30001 }, { types: ['session.deleted'] }]) {
        assert.throws(() => fixture.suppressMessageEvents({ ...rule, ...patch }), /Invalid/);
      }
      fixture.suppressMessageEvents(rule);
      assert.throws(() => fixture.suppressMessageEvents(rule), /overlapping/);
      fixture.configureNextPrompt(PERF_CHILD_SESSION_IDS[0], { chunks: 1, intervalMs: 10 });
      await post(`${fixture.origin}/session/${PERF_CHILD_SESSION_IDS[0]}/prompt_async`, { messageID: 'msg_untouched_child', parts: [{ type: 'text', text: 'Continue another session' }] });
      fixture.releasePrompt(PERF_PARENT_SESSION_ID); await waitIdle(fixture);
      const canonical = (await fetch(`${route}/message`).then(response => response.json())).at(-1);
      assert.equal(canonical.info.id, assistant.info.id);
      assert.ok(canonical.info.time.completed);
      assert.match(canonical.parts.find(part => part.type === 'text').text, /QA response chunk 3/);
      const statuses = await fetch(`${fixture.origin}/session/status`).then(response => response.json());
      assert.equal(statuses[PERF_PARENT_SESSION_ID].type, 'idle');
      fixture.clearMessageEventSuppression();
      const state = fixture.getState();
      assert.equal(state.suppressedEvents.length, 9);
      assert.ok(state.suppressedEvents.every(event => event.sessionID === PERF_PARENT_SESSION_ID
        && (event.messageID === assistant.info.id || event.type === 'session.status')));
      assert.equal(new Set(state.suppressedEvents.map(event => event.eventID)).size, 9);
      assert.equal(state.suppressionRuns[0].endedReason, 'explicit-clear');
      assert.equal(state.receivedPrompts.length, 2);
      assert.equal(state.statusRequestCount, 1);
      fixture.disconnectEvents();
      const frames = await eventText;
      assert.ok(frames.includes('msg_untouched_child'));
      assert.ok(frames.includes('QA response chunk 1.'));
      for (const event of state.suppressedEvents) assert.equal(frames.includes(`id: ${event.eventID}\n`), false);
      assert.throws(() => fixture.suppressMessageEvents(rule), /Invalid/);
    } finally { await fixture.close(); }
  });

  it('settles empty reasoning/tool errors and rejects a configured prompt without optimistic server rows', async () => {
    const fixture = await createLoopbackOpenCodeFixture({directory:'/qa-failures'});
    try {
      const route = `${fixture.origin}/session/${PERF_PARENT_SESSION_ID}`;
      fixture.configureNextPrompt(PERF_PARENT_SESSION_ID,{rejectStatus:400});
      assert.equal((await post(`${route}/prompt_async`,{messageID:'msg_reject',parts:[{type:'text',text:'Reject me'}]})).status,400);
      assert.equal((await fetch(`${route}/message`).then((response) => response.json())).length,1);
      assert.equal(fixture.getState().activePrompts,0);
      fixture.configureNextPrompt(PERF_PARENT_SESSION_ID,{reasoning:'empty',tool:'error',chunks:1,intervalMs:10});
      await post(`${route}/prompt_async`,{messageID:'msg_error_tool',variant:'high',parts:[{type:'text',text:'Show failure'}]});
      await waitIdle(fixture);
      const row = (await fetch(`${route}/message`).then((response) => response.json())).at(-1);
      assert.equal(row.parts.find((part) => part.type === 'reasoning').text,'');
      assert.ok(row.parts.find((part) => part.type === 'reasoning').time.end);
      assert.equal(row.parts.find((part) => part.type === 'tool').state.status,'error');
      assert.equal(fixture.getState().receivedPrompts[0].variant,'high');
      assert.equal((await fetch(`${fixture.origin}/session/${PERF_PARENT_SESSION_ID}/unknown-required-route`)).status,404);
      assert.equal(fixture.getState().unknownRoutes.length,1);
    } finally {await fixture.close();}
  });

  it('preserves real native variant metadata while synthetic compaction users omit selection overrides', async () => {
    const fixture=await createLoopbackOpenCodeFixture({directory:'/qa-compaction-selection'});
    try {
      const sessionID=(await post(`${fixture.origin}/session`,{title:'Compaction selection'}).then(r=>r.json())).id;
      assert.throws(()=>fixture.appendCompactionBoundary(sessionID),/real fixture user turn/);
      for(const variant of ['','high']) {
        fixture.configureNextPrompt(sessionID,{chunks:1,intervalMs:10,hold:true});
        const userMessageID=`msg_selection_${variant||'default'}`;
        await post(`${fixture.origin}/session/${sessionID}/prompt_async`,{messageID:userMessageID,agent:'build',variant,
          model:{providerID:'fixture',modelID:'fixture-model'},parts:[{type:'text',text:'Keep this selection'}]});
        assert.throws(()=>fixture.appendCompactionBoundary(sessionID),/active prompt/);
        fixture.releasePrompt(sessionID);await waitIdle(fixture);
        const boundary=fixture.appendCompactionBoundary(sessionID);
        const rows=await fetch(`${fixture.origin}/session/${sessionID}/message`).then(r=>r.json());
        const user=rows.find(row=>row.info.id===userMessageID);const compact=rows.at(-2);const summary=rows.at(-1);
        assert.equal(user.info.model.variant,variant);assert.equal(Object.hasOwn(user.info,'variant'),false);
        assert.equal(boundary.previousUserMessageID,userMessageID);assert.equal(compact.info.id,boundary.userMessageID);
        assert.equal(compact.parts[0].type,'compaction');assert.equal(compact.parts[0].auto,false);
        assert.equal(Object.hasOwn(compact.info,'variant'),false);assert.equal(Object.hasOwn(compact.info.model,'variant'),false);
        assert.equal(summary.info.summary,true);assert.equal(summary.info.parentID,compact.info.id);assert.ok(summary.info.time.completed);
      }
    } finally {await fixture.close();}
  });

  it('retains exact plan text and ordered linked summaries without claiming native compaction', async () => {
    const fixture=await createLoopbackOpenCodeFixture({directory:'/qa-plan-approval'});
    try {
      const sessionID=(await post(`${fixture.origin}/session`,{title:'Plan approval'}).then(r=>r.json())).id;
      const responseText='<!--plan-->\n# Fixture plan\n\n## Context\n\nRetain the source.\n\n## Implementation\n\n1. Verify approval.';
      assert.throws(()=>fixture.configureNextPrompt(sessionID,{responseText:16}),/Invalid fixture prompt/);
      assert.throws(()=>fixture.configureNextPrompt(sessionID,{responseText:'x'.repeat(16_385)}),/Invalid fixture prompt/);
      fixture.configureNextPrompt(sessionID,{responseText,chunks:3,intervalMs:10});
      await post(`${fixture.origin}/session/${sessionID}/prompt_async`,{messageID:'msg_fixture_plan',agent:'build',variant:'high',
        model:{providerID:'fixture',modelID:'fixture-model'},parts:[{type:'text',text:'Plan the task'},
          {type:'text',synthetic:true,text:'User has requested to enter plan mode.'}]});
      await waitIdle(fixture);
      const summaryText='Fixture compaction summary: the saved plan awaits approval.';
      assert.throws(()=>fixture.appendCompactionBoundary(sessionID,{summaryText:''}),/Invalid fixture compaction/);
      assert.throws(()=>fixture.appendCompactionBoundary(sessionID,{summaryText:'x'.repeat(16_385)}),/Invalid fixture compaction/);
      assert.throws(()=>fixture.appendCompactionBoundary(sessionID,{autoContinue:'true'}),/Invalid fixture compaction/);
      const first=fixture.appendCompactionBoundary(sessionID,{summaryText});const second=fixture.appendCompactionBoundary(sessionID,{summaryText});
      const rows=await fetch(`${fixture.origin}/session/${sessionID}/message`).then(r=>r.json());
      assert.equal(rows.find(row=>row.info.parentID==='msg_fixture_plan').parts[0].text,responseText);
      assert.equal(rows.find(row=>row.info.id===second.summaryMessageID).parts[0].text,summaryText);
      assert.ok(rows.find(row=>row.info.id===second.userMessageID).info.time.created>rows.find(row=>row.info.id===first.summaryMessageID).info.time.created);
      assert.equal(rows.filter(row=>row.info.summary===true).length,2);
      assert.equal(fixture.getState().receivedPrompts.length,1);
      const automatic=fixture.appendCompactionBoundary(sessionID,{autoContinue:true});
      const continued=await fetch(`${fixture.origin}/session/${sessionID}/message`).then(r=>r.json());
      const generated=continued.find(row=>row.info.id===automatic.continuationUserMessageID);
      assert.equal(continued.find(row=>row.info.id===automatic.userMessageID).parts[0].auto,true);
      assert.deepEqual(generated.info.model,continued.find(row=>row.info.id==='msg_fixture_plan').info.model);
      assert.ok(generated.info.time.created>continued.find(row=>row.info.id===automatic.summaryMessageID).info.time.completed);
      assert.equal(generated.parts.length,1);assert.equal(generated.parts[0].synthetic,true);
      assert.equal(generated.parts[0].metadata.compaction_continue,true);
      assert.equal(generated.parts[0].text,'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.');
      assert.ok(continued.find(row=>row.info.parentID===generated.info.id).info.time.completed);
      assert.equal(fixture.appendCompactionBoundary(sessionID).previousUserMessageID,'msg_fixture_plan');
      assert.equal(fixture.getState().receivedPrompts.length,1,'Stored continuations must not claim a real provider request');
    } finally {await fixture.close();}
  });

  it('permission/question HTTP replies unblock the correct prompt and expose canonical reply identities', async () => {
    const fixture = await createLoopbackOpenCodeFixture({directory:'/qa-dialogs'});
    try {
      const id=PERF_PARENT_SESSION_ID;
      const permission=fixture.askPermission(id); const question=fixture.askQuestion(id);
      fixture.setTodos(id,[{id:'todo_1',content:'Verify the task board',status:'in_progress',priority:'high'}]);
      fixture.configureNextPrompt(id,{chunks:2,intervalMs:10});
      await post(`${fixture.origin}/session/${id}/prompt_async`,{messageID:'msg_dialog',parts:[{type:'text',text:'Ask first'}]});
      assert.equal((await fetch(`${fixture.origin}/permission`).then((response) => response.json()))[0].id,permission);
      assert.equal((await fetch(`${fixture.origin}/question`).then((response) => response.json()))[0].id,question);
      assert.equal((await post(`${fixture.origin}/permission/${permission}/reply`,{reply:'invalid'})).status,400);
      assert.equal((await post(`${fixture.origin}/permission/${permission}/reply`,{reply:'once'})).status,200);
      assert.equal(fixture.getState().activePrompts,1);
      assert.equal((await post(`${fixture.origin}/question/${question}/reply`,{answers:[['Keep creation order']]})).status,200);
      await waitIdle(fixture);
      assert.equal(fixture.getState().permissionCount,0);assert.equal(fixture.getState().questionCount,0);
      assert.deepEqual(fixture.getState().replies.map((reply) => reply.requestID),[permission,question]);
      assert.equal((await fetch(`${fixture.origin}/session/${id}/todo`).then((response) => response.json()))[0].status,'in_progress');
      assert.equal((await post(`${fixture.origin}/question/${question}/reply`,{answers:[['Keep creation order']]})).status,404);
    } finally {await fixture.close();}
  });

  it('creates, renames, and permanently deletes sessions with explicit agent catalog coverage', async () => {
    const fixture = await createLoopbackOpenCodeFixture({directory:'/qa-create'});
    try {
      const agents=await fetch(`${fixture.origin}/agent`).then((response) => response.json());
      assert.deepEqual(agents.map((agent) => agent.name),['build','builder','orchestrator']);
      const response=await post(`${fixture.origin}/session`,{title:'A new QA session',parentID:PERF_PARENT_SESSION_ID});
      const created=await response.json(); assert.equal(response.status,200);assert.match(created.id,/^ses_[a-zA-Z0-9]+$/);
      assert.equal(created.title,'A new QA session');
      const route=`${fixture.origin}/session/${created.id}`;
      const renamed=await fetch(route,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Revised QA session'})}).then((result) => result.json());
      assert.equal(renamed.title,'Revised QA session');
      fixture.askPermission(created.id);fixture.askQuestion(created.id);
      assert.equal((await fetch(route,{method:'DELETE'})).status,200);
      assert.equal((await fetch(route)).status,404);assert.equal((await fetch(route+'/message')).status,404);
      assert.equal(fixture.getState().permissionCount,0);assert.equal(fixture.getState().questionCount,0);
    } finally {await fixture.close();}
  });
});
