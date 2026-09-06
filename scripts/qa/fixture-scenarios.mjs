import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLoopbackOpenCodeFixture, PERF_PARENT_SESSION_ID } from '../perf/loopback-opencode-fixture.mjs';
import { evaluate } from './cdp.mjs';
import { captureQaCompactionProjectPlan, prepareQaCompactionApproval } from './compaction-approval.mjs';
import { findQaPlanApprovalUser } from './compaction-scenarios.mjs';
import { assertQaSubmittedPlanMode } from './submitted-turn.mjs';
import { runQaFixtureFailureRecovery } from './fixture-failures.mjs';
import { runQaFixtureMobileCoverage } from './fixture-mobile-coverage.mjs';
import { QA_COMPACTION_COMPOSER, QA_QUEUE_MODE_CONTROL, QA_QUEUE_MODE_STATE,
  readQaManualCompactionQueueMode, withQaManualCompactionSubmission } from './manual-compaction-submission.mjs';

const root = fileURLToPath(new URL('../../',import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve,ms));
const within = (parent, target) => {
  const relative=path.relative(parent,target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const canonicalTarget = async (target) => {
  const suffix=[];let ancestor=path.resolve(target);
  for (;;) {
    try {await lstat(ancestor);return path.resolve(await realpath(ancestor),...suffix);}
    catch(error) {if(error.code!=='ENOENT')throw error;const parent=path.dirname(ancestor);if(parent===ancestor)throw error;suffix.unshift(path.basename(ancestor));ancestor=parent;}
  }
};

export async function prepareQaFixtureProfile({runtimeRoot,workspace,cell}) {
  if (cell?.transport !== 'fixture' || cell.providerId !== 'fixture' || cell.modelId !== 'fixture-model'
    || !['web','electron'].includes(cell.runtime) || !['core-journey','mobile'].includes(cell.scenarioId)
    || !['builder','orchestrator'].includes(cell.agent) || typeof cell.planMode !== 'boolean'
    || ![null,'low','high'].includes(cell.variant)
    || (cell.scenarioId === 'mobile' && cell.runtime !== 'web')) throw new Error('Unsupported QA fixture matrix selection');
  const cache=path.join(await realpath(root),'.cache');
  if (!path.isAbsolute(runtimeRoot) || !path.isAbsolute(workspace) || !within(cache,path.resolve(runtimeRoot))
    || !within(cache,await realpath(workspace)) || !within(cache,await canonicalTarget(runtimeRoot))) throw new Error('Fixture profile must use an owned repository cache workspace');
  await mkdir(runtimeRoot,{recursive:true,mode:0o700});
  if (!within(cache,await realpath(runtimeRoot))) throw new Error('Fixture runtime root escaped the repository cache');
  const home=path.join(runtimeRoot,'home');
  await mkdir(home,{mode:0o700});
  await writeFile(path.join(home,'.devryan-qa-home'),'owned fixture QA home\n',{flag:'wx',mode:0o600});
  const data=path.join(home,'.config/openchamber');
  const browserProfile=path.join(runtimeRoot,'browser-profile');
  await Promise.all([data,browserProfile,path.join(home,'tmp'),path.join(home,'.cache'),path.join(home,'.config/opencode/.openchamber')]
    .map((directory) => mkdir(directory,{recursive:true,mode:0o700})));
  await writeFile(path.join(runtimeRoot,'credentials.env.json'),'{}\n',{flag:'wx',mode:0o600});
  const agentNames=['build','builder','orchestrator'];
  const modelSelection={providerId:cell.providerId,modelId:cell.modelId,variant:'low'};
  const modelRef=`${modelSelection.providerId}/${modelSelection.modelId}`;
  const agents=Object.fromEntries(agentNames.map(name => [name,{model:modelRef,variant:modelSelection.variant}]));
  await writeFile(path.join(home,'.config/opencode/oh-my-opencode-slim.json'),JSON.stringify({preset:'qa',presets:{qa:agents},agents}),{mode:0o600});
  await writeFile(path.join(home,'.config/opencode/opencode.json'),JSON.stringify({model:modelRef,default_agent:cell.agent === 'builder' ? 'build' : cell.agent,agent:agents,plugin:[],mcp:{}}),{mode:0o600});
  // Standalone /api/config/agents overlays packaged metadata onto native
  // /agent. Its supported sidecar must share the same private fixture pins.
  await writeFile(path.join(home,'.config/opencode/.openchamber/config.json'),JSON.stringify({agentOverrides:agents}),{mode:0o600});
  await writeFile(path.join(home,'.gitconfig'),'[user]\n\tname = DevRyan QA\n\temail = qa@devryan.invalid\n',{mode:0o600});
  // Private app defaults match the fixture's native Low fallback. The driver
  // still selects each requested Default/High through the actual controls.
  await writeFile(path.join(data,'settings.json'),JSON.stringify({messageStreamTransport:'sse',showReasoningTraces:true,lastDirectory:workspace,
    defaultModel:modelRef,defaultAgent:cell.agent === 'builder' ? 'build' : cell.agent,
    agentModelSelections:Object.fromEntries(agentNames.map(name => [name,modelSelection])),
    projects:[{id:'qa-project',path:workspace,label:'QA workspace'}],activeProjectId:'qa-project',queueModeEnabled:true,
    desktopWindowState:{width:1280,height:800,maximized:false}}),{mode:0o600});
  // A distinct native agent fallback makes explicit Default/High restoration
  // observable when a later synthetic user omits its variant.
  const fixture=await createLoopbackOpenCodeFixture({directory:workspace,agentVariant:modelSelection.variant});
  try {
    fixture.seedHistory(PERF_PARENT_SESSION_ID,{turns:180,textBytes:256});
    const env={DEVRYAN_QA_RUNTIME_ROOT:runtimeRoot,DEVRYAN_QA_HOME:home,DEVRYAN_QA_RUNTIME:cell.runtime,
      OPENCODE_TEST_HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share'),
      OPENCODE_CONFIG_DIR:path.join(home,'.config/opencode'),GH_CONFIG_DIR:path.join(home,'.config/gh'),
      GIT_CONFIG_GLOBAL:path.join(home,'.gitconfig'),GIT_CONFIG_NOSYSTEM:'1',GH_TOKEN:'',GITHUB_TOKEN:'',
      XDG_STATE_HOME:path.join(home,'.local/state'),XDG_CACHE_HOME:path.join(home,'.cache'),TMPDIR:path.join(home,'tmp'),
      OPENCHAMBER_DATA_DIR:data,OPENCHAMBER_ELECTRON_USER_DATA_DIR:browserProfile,
      OPENCHAMBER_DIST_DIR:path.join(root,'packages/web/dist'),OPENCHAMBER_ELECTRON_DEV:'1',
      OPENCODE_HOST:fixture.origin,OPENCODE_SKIP_START:'true',OPENCHAMBER_SKIP_OPENCODE_START:'true',
      NODE_OPTIONS:`--import=${JSON.stringify(fileURLToPath(new URL('./isolated-home.mjs',import.meta.url)))}`,
      NO_PROXY:'localhost,127.0.0.1',no_proxy:'localhost,127.0.0.1'};
    return {env,bootstrapPath:fileURLToPath(new URL('./isolated-host.mjs',import.meta.url)),fixture,close:() => fixture.close(),
      evidence:{transport:'fixture',version:'perf-fixture',credentialsCopied:false,globalConfigurationRead:false,
        agentFallbackVariant:modelSelection.variant,applicationAgentFallbackVariant:modelSelection.variant,modelSelection,history:{sessionID:PERF_PARENT_SESSION_ID,turns:180},
        isolation:{home,data,browserProfile,workspace},managedScheduler:'not-simulated'}};
  } catch (error) {await fixture.close();throw error;}
}

export async function runQaFixtureScenario({cell,fixture,projectFixture,cdp,ui,api,check,screenshot,runDeadline}) {
  if (cell?.transport !== 'fixture' || !['core-journey','mobile'].includes(cell.scenarioId)
    || (cell.scenarioId === 'mobile' && cell.runtime !== 'web')) throw new Error('Unsupported QA fixture scenario');
  const evidence={sessionIDs:[],expectedFailures:[],managedScheduler:'not-tested'};
  const rows = (id) => api(`/api/session/${id}/message?directory=${encodeURIComponent(projectFixture.fixtureRoot)}`);
  const idle = (id) => ui.waitFor('fixture turn idle',async () => {
    const status=await api(`/api/session/status?directory=${encodeURIComponent(projectFixture.fixtureRoot)}`);
    return status[id]?.type === 'idle';
  });
  const visibleRow = (id) => `[data-message-id=${JSON.stringify(id)}]`;
  const selectedSession = () => evaluate(cdp,"new URL(location.href).searchParams.get('session')");
  const latestAssistant = async (id) => (await rows(id)).filter((row) => row.info.role === 'assistant').at(-1);
  const send = async (text,{keyboard=false}={}) => {
    const previous=fixture.getState().receivedPrompts.length;
    if(keyboard) {await ui.type(text);await ui.key('Enter',{code:'Enter',windowsVirtualKeyCode:13});}
    else await ui.send(text);
    const accepted=await ui.waitFor('fixture accepted visible composer submission',() => fixture.getState().receivedPrompts[previous]);
    await ui.waitExpression('canonical user row',`Boolean(document.querySelector(${JSON.stringify(visibleRow(accepted.messageID))}))`);
    return accepted;
  };
  const selectSession = async (id) => {
    const open=await evaluate(cdp,"Boolean([...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')==='Open Sessions' && e.getBoundingClientRect().width>0))");
    if(open) await ui.click({label:'Open Sessions',touch:cell.scenarioId==='mobile'});
    await ui.click({selector:`[data-session-row="${id}"] button:has(span.truncate)`,text:id === PERF_PARENT_SESSION_ID ? 'Performance parent' : undefined,touch:cell.scenarioId==='mobile'});
    await ui.waitFor('selected canonical session',async () => await selectedSession() === id);
    if(open && await evaluate(cdp,"Boolean(document.querySelector('button[aria-label=\"Close Sessions\"]'))")) {
      await ui.click({label:'Close Sessions',touch:cell.scenarioId==='mobile'});
      await ui.waitExpression('selection drawer closed',"[...document.querySelectorAll('aside[aria-hidden=\"true\"]')].every(e=>{const r=e.getBoundingClientRect();return r.right<=1||r.left>=innerWidth-1})");
    }
    await ui.waitExpression('mounted composer',"Boolean(document.querySelector('textarea'))");
  };
  const setVariant = async (value) => {
    await ui.click({selector:'button.model-controls__variant-trigger'});
    await ui.click({selector:'[role="menuitem"]',text:value === null ? 'Default' : value === 'high' ? 'High' : 'Low'});
    await ui.waitExpression('selected thinking label',`[...document.querySelectorAll('.model-controls__variant-trigger')].some(e=>e.innerText.trim()===${JSON.stringify(value === null ? 'Default' : value === 'high' ? 'High' : 'Low')})`);
  };
  const planModeControl = `(() => {const e=[...document.querySelectorAll('[aria-pressed]')].find(e=>e.innerText?.trim().startsWith('Plan'));return e?{enabled:e.getAttribute('aria-pressed')==='true'}:null;})()`;
  const closeAgentMenu = async () => {
    await ui.key('Escape',{code:'Escape',windowsVirtualKeyCode:27});
    await ui.waitExpression('agent menu fully closed',"![...document.querySelectorAll('[role=\"menu\"]')].some(e=>e.getBoundingClientRect().width>0)");
  };
  const setPlanMode = async expected => {
    await ui.click({selector:'button:has(.model-controls__agent-label)'});
    const current=await ui.waitExpression('Plan mode control',planModeControl);
    if(current.enabled!==expected) await ui.click({selector:'[aria-pressed]',text:'Plan',exact:false});
    await ui.waitExpression('selected Plan mode',`(${planModeControl}).enabled===${expected}`);
    await closeAgentMenu();
  };
  const expectPlanMode = async (expected,name) => {
    await ui.click({selector:'button:has(.model-controls__agent-label)'});
    const current=await ui.waitExpression('restored Plan mode control',planModeControl);
    assert.equal(current.enabled,expected,'Reload must restore the canonical Plan preference');
    if(name) {
      await ui.waitExpression('Plan menu animation settled',"[...document.querySelectorAll('[role=\"menu\"]')].every(e=>e.getAnimations({subtree:true}).every(a=>a.playState!=='running'))");
      await screenshot(name);
    }
    await closeAgentMenu();
  };

  let sessionID;
  await check('fixture new-session send and attachment reconciliation',async () => {
    await ui.attach(projectFixture.attachments.map((attachment) => attachment.path));
    const accepted=await send('QA fixture: use the attached task requirements.');
    sessionID=accepted.sessionID;evidence.sessionIDs.push(sessionID);
    assert.match(sessionID,/^ses_[a-zA-Z0-9]+$/);
    assert.ok(accepted.partTypes.includes('file'),'The actual send must retain attached files');
    await idle(sessionID);
    await ui.waitExpression('completed response visible',"document.body.innerText.includes('QA response chunk 20.')");
    assert.equal((await rows(sessionID)).filter((row) => row.info.id === accepted.messageID).length,1);
    await screenshot('fixture-first-response');
  });

  await check('empty reasoning remains a non-expandable active status and clears on cancellation',async () => {
    fixture.configureNextPrompt(sessionID,{reasoning:'empty',hold:true});
    await send('QA empty thinking state.');
    const assistant=await latestAssistant(sessionID);
    const selector=visibleRow(assistant.info.id);
    await ui.waitExpression('pending reasoning status',`Boolean(document.querySelector(${JSON.stringify(selector + ' [data-reasoning-pending="true"]')}))`);
    assert.equal(await evaluate(cdp,`Boolean(document.querySelector(${JSON.stringify(selector + ' [data-reasoning-group] button')}))`),false);
    await screenshot('fixture-empty-thinking-active');
    await ui.click({label:'Stop Generating'});await idle(sessionID);
    await ui.waitExpression('empty completed reasoning removed',`!document.querySelector(${JSON.stringify(selector + ' [data-reasoning-pending], ' + selector + ' [data-reasoning-group]')})`);
  });

  await check('delayed reasoning becomes keyboard-expandable without losing its text',async () => {
    fixture.configureNextPrompt(sessionID,{reasoning:'delayed',hold:true,chunks:2,intervalMs:100});
    await send('QA delayed thinking state.');
    const assistant=await latestAssistant(sessionID);const selector=visibleRow(assistant.info.id);
    await ui.waitExpression('delayed pending state',`Boolean(document.querySelector(${JSON.stringify(selector + ' [data-reasoning-pending]')}))`);
    fixture.setPromptReasoning(sessionID,'Retain the latest plan revision and preserve the user edit.');
    const trigger=selector + ' [data-reasoning-group] button';
    await ui.waitExpression('reasoning disclosure',`Boolean(document.querySelector(${JSON.stringify(trigger)}))`);
    await evaluate(cdp,`document.querySelector(${JSON.stringify(trigger)}).focus()`);
    await ui.key('Enter',{code:'Enter',windowsVirtualKeyCode:13});
    await ui.waitExpression('reasoning disclosure layout opened',`(() => {const e=document.querySelector(${JSON.stringify(selector + ' [data-reasoning-disclosure-content]')});return e && e.getBoundingClientRect().height>0 && e.getBoundingClientRect().height>=e.scrollHeight-1;})()`);
    await ui.waitVisibleText('Retain the latest plan revision',selector);
    assert.equal(await evaluate(cdp,`document.activeElement===document.querySelector(${JSON.stringify(trigger)})`),true);
    await screenshot('fixture-reasoning-expanded');
    fixture.releasePrompt(sessionID);await idle(sessionID);
    await ui.reload();
    await ui.waitExpression('reasoning retained after reload',`document.querySelector(${JSON.stringify(selector)})?.innerText.includes('Retain the latest plan revision')`);
  });

  await check('queued thinking snapshot survives later selector changes',async () => {
    await setVariant(null);
    fixture.configureNextPrompt(sessionID,{hold:true,chunks:2,intervalMs:100});
    await send('QA hold the current turn while another request is queued.');
    await ui.type('QA queued with provider-default thinking.');
    await ui.key('Enter',{code:'Enter',windowsVirtualKeyCode:13});
    await ui.waitExpression('queued row present',"Boolean(document.querySelector('button[aria-label=\"Remove from Queue\"]'))");
    await setVariant('high');
    const before=fixture.getState().receivedPrompts.length;
    fixture.releasePrompt(sessionID);
    const queued=await ui.waitFor('queued submission dispatched',() => fixture.getState().receivedPrompts[before]);
    assert.ok(queued.variant === null || queued.variant === '', 'The queued provider-default selection must not become high effort');
    await idle(sessionID);
    await ui.waitExpression('queue cleared',"!document.querySelector('button[aria-label=\"Remove from Queue\"]')");
    evidence.queuedSnapshot={messageID:queued.messageID,variant:queued.variant,model:queued.model,agent:queued.agent};
    await screenshot('fixture-queue-completed');
  });

  await check('permission and question dialogs resolve canonical requests through visible controls',async () => {
    fixture.configureNextPrompt(sessionID,{hold:true,tool:'completed',chunks:2,intervalMs:100});
    await send('QA permission and question flow.');
    const permission=fixture.askPermission(sessionID);
    await ui.click({text:'Allow Once'});
    await ui.waitFor('permission acknowledgement',() => fixture.getState().replies.some((reply) => reply.requestID===permission && reply.reply==='once'));
    // Keep the prompt held until both UI requests have been answered.
    const question=fixture.askQuestion(sessionID,{question:'Choose the required task display order.',options:['Keep creation order','Sort by priority']});
    await ui.click({selector:'[role="radio"]',text:'Keep creation order',exact:false});
    await screenshot('fixture-question-selected');
    await ui.click({text:'Submit'});
    await ui.waitFor('question acknowledgement',() => fixture.getState().replies.some((reply) => reply.requestID===question));
    fixture.releasePrompt(sessionID);
    await idle(sessionID);
    const assistant=await latestAssistant(sessionID);
    assert.equal(assistant.parts.find((part) => part.type==='tool')?.state.status,'completed');
    const selector=visibleRow(assistant.info.id);
    const text=await evaluate(cdp,`document.querySelector(${JSON.stringify(selector)})?.innerText || ''`);
    assert.match(text,/Ran 1 command|fixture tests|npm test|Bash|bash/);
    if(await evaluate(cdp,`Boolean(document.querySelector(${JSON.stringify(selector + ' button[aria-expanded="false"]')}))`)) {
      await ui.click({selector:selector + ' button[aria-expanded="false"]'});
    }
    if(!await evaluate(cdp,`document.querySelector(${JSON.stringify(selector)})?.innerText.includes('Fixture tests passed.')`)) {
      const toolHeader=selector + ' [role="button"]';
      await ui.waitExpression('focusable tool disclosure',`(() => {const e=[...document.querySelectorAll(${JSON.stringify(toolHeader)})].find(e=>e.innerText.includes('npm test'));if(!e)return false;e.focus();return document.activeElement===e;})()`);
      await ui.key('Enter',{code:'Enter',windowsVirtualKeyCode:13});
    }
    await ui.waitVisibleText('Fixture tests passed.',selector);
    await screenshot('fixture-tool-completed');
  });

  await check('rejected prompts roll back and allow a new accepted send',async () => {
    const before=(await rows(sessionID)).filter((row) => row.info.role==='user').length;
    fixture.configureNextPrompt(sessionID,{rejectStatus:400});
    await ui.send('QA intentionally rejected prompt.');
    await ui.waitFor('configured rejection observed',() => fixture.getState().rejectedPrompts.some((item) => item.sessionID===sessionID && item.status===400));
    evidence.expectedFailures.push({kind:'prompt-rejection',sessionID,httpStatus:400,message:'Configured QA prompt rejection'});
    await ui.waitExpression('rejected optimistic row removed',"![...document.querySelectorAll('[data-message-id]')].some(e=>e.innerText?.includes('QA intentionally rejected prompt.'))");
    assert.equal((await rows(sessionID)).filter((row) => row.info.role==='user').length,before);
    let previousToast;
    await ui.waitFor('rejection toast fully visible and settled',async () => {
      const toast=await evaluate(cdp,`(() => {
        const e=[...document.querySelectorAll('[data-sonner-toast]')].find(e=>e.innerText.includes('Failed to send message'));
        if(!e)return null;const r=e.getBoundingClientRect();const s=getComputedStyle(e);
        if(r.width<=0||r.height<=0||r.left<0||r.top<0||r.right>innerWidth||r.bottom>innerHeight||Number(s.opacity)<0.99)return null;
        if(e.getAnimations({subtree:true}).some(a=>a.playState==='running'||a.playState==='pending'))return null;
        return {left:r.left,top:r.top,width:r.width,height:r.height};
      })()`);
      const settled=toast&&previousToast&&Object.keys(toast).every(key=>Math.abs(toast[key]-previousToast[key])<0.5);
      previousToast=toast;return settled;
    });
    await screenshot('fixture-rejected-send');
    const recovered=await send('QA successful send after rejection.',{keyboard:true});await idle(sessionID);
    await ui.reload();
    await ui.waitExpression('recovered canonical turn after reload',`Boolean(document.querySelector(${JSON.stringify(visibleRow(recovered.messageID))}))`);
  });

  await check('stream reconnect and cancellation do not duplicate the canonical turn',async () => {
    fixture.configureNextPrompt(sessionID,{chunks:1000,intervalMs:100});
    const sent=await send('QA reconnect then cancel this stream.');
    const assistant=await latestAssistant(sessionID);const selector=visibleRow(assistant.info.id);
    await ui.waitExpression('streamed text before reconnect',`document.querySelector(${JSON.stringify(selector)})?.innerText.includes('QA response chunk 1.')`);
    fixture.disconnectEvents();
    await ui.waitExpression('streamed text after reconnect',`document.querySelector(${JSON.stringify(selector)})?.innerText.includes('QA response chunk 8.')`,30000);
    await ui.click({label:'Stop Generating'});await idle(sessionID);
    const saved=await latestAssistant(sessionID);const finalText=saved.parts.find((part) => part.type==='text').text;
    await ui.reload();
    await ui.waitExpression('restored cancelled response text',`document.querySelector(${JSON.stringify(selector)})?.innerText.includes(${JSON.stringify(finalText.trim())})`);
    assert.equal(await evaluate(cdp,`document.querySelectorAll(${JSON.stringify(visibleRow(sent.messageID))}).length`),1);
    assert.equal((await rows(sessionID)).filter((row) => row.info.id===sent.messageID).length,1);
    await screenshot('fixture-reconnected-cancelled');
  });

  await check('session switching and background streams preserve the composer draft',async () => {
    const draft='Unsent draft must survive switching and background streaming.';
    await ui.type(draft);
    fixture.startScenario('four-stream');await pause(400);
    assert.equal(await evaluate(cdp,"document.querySelector('textarea').value"),draft);
    fixture.stopScenario();
    await selectSession(PERF_PARENT_SESSION_ID);
    await ui.waitExpression('history opened',"document.body.innerText.includes('History response')");
    await selectSession(sessionID);
    await ui.waitExpression('session draft restored',`document.querySelector('textarea')?.value===${JSON.stringify(draft)}`);
    await ui.type('');
  });

  evidence.failureRecovery = await runQaFixtureFailureRecovery({ cell, fixture, cdp, ui, api, check, screenshot,
    sessionID, directory: projectFixture.fixtureRoot, send, idle, latestAssistant });

  await check('loading older messages preserves the visible history anchor',async () => {
    await selectSession(PERF_PARENT_SESSION_ID);
    const initialRequests=fixture.getState().olderMessageRequestCounts[PERF_PARENT_SESSION_ID] ?? 0;
    evidence.historyAnchors=[];
    for(let page=0;page<12;page++) {
      await ui.waitExpression('older messages control',"[...document.querySelectorAll('button')].some(e=>e.innerText.trim()==='LOAD OLDER MESSAGES')");
      const wheel=await evaluate(cdp,"(() => {const e=document.querySelector('[data-scrollbar=\"chat\"]');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,deltaY:-e.scrollHeight,deltaX:0};})()");
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',...wheel});
      await ui.waitExpression('user scrolled to older-history edge',"document.querySelector('[data-scrollbar=\"chat\"]').scrollTop<=1");
      await ui.waitVisibleText('Load Older Messages');
      const anchor=await evaluate(cdp,`(() => {const scroller=document.querySelector('[data-scrollbar="chat"]');const bounds=scroller.getBoundingClientRect();const row=[...scroller.querySelectorAll('[data-message-id]')].find(e=>e.getBoundingClientRect().top>=bounds.top && e.getBoundingClientRect().top<bounds.bottom);if(!row)return null;return{id:row.dataset.messageId,top:row.getBoundingClientRect().top-bounds.top,height:scroller.scrollHeight,virtualized:Boolean(scroller.querySelector('[data-turn-entry][data-index]'))};})()`);
      assert.ok(anchor,'A visible existing row must be available to measure anchoring');
      await ui.click({text:'LOAD OLDER MESSAGES'});
      await ui.waitExpression('history growth committed',`document.querySelector('[data-scrollbar="chat"]').scrollHeight>${anchor.height}`);
      const delta=await evaluate(cdp,`(() => {const scroller=document.querySelector('[data-scrollbar="chat"]');const row=scroller.querySelector(${JSON.stringify(visibleRow(anchor.id))});return row ? row.getBoundingClientRect().top-scroller.getBoundingClientRect().top-${anchor.top} : null;})()`);
      assert.ok(delta !== null && Math.abs(delta)<=2,`History anchor moved by ${delta} pixels`);
      const virtualized=await evaluate(cdp,"Boolean(document.querySelector('[data-scrollbar=\"chat\"] [data-turn-entry][data-index]'))");
      evidence.historyAnchors.push({messageID:anchor.id,shiftPx:delta,virtualizedBefore:anchor.virtualized,virtualizedAfter:virtualized});
      if(evidence.historyAnchors.some(item=>!item.virtualizedBefore&&item.virtualizedAfter)
        && (fixture.getState().olderMessageRequestCounts[PERF_PARENT_SESSION_ID] ?? 0)>initialRequests) break;
    }
    assert.ok((fixture.getState().olderMessageRequestCounts[PERF_PARENT_SESSION_ID] ?? 0)>initialRequests,'Older-history acceptance must include an actual paginated request');
    assert.ok(evidence.historyAnchors.some(item=>!item.virtualizedBefore&&item.virtualizedAfter),'History acceptance must cross the actual rendered virtualization threshold');
    await screenshot('fixture-history-expanded');
    await selectSession(sessionID);
  });

  evidence.compactionSelectionRestoration={source:'synthetic fixture messages; native compaction lifecycle is not exercised',cases:[]};
  for(const variant of [null,'high']) {
    const label=variant === null ? 'Default' : 'High';
    await check(`fixture compaction records preserve ${label} thinking after reload`,async () => {
      await setVariant(variant);
      fixture.configureNextPrompt(sessionID,{chunks:1,intervalMs:10});
      const before=await send(`QA retain ${label} thinking through synthetic compaction records.`);await idle(sessionID);
      const realUser=(await rows(sessionID)).find(row=>row.info.id===before.messageID);
      assert.equal(realUser.info.model.variant,variant ?? '', 'The prior real user must carry the native model.variant shape');
      const boundary=fixture.appendCompactionBoundary(sessionID);
      await ui.waitFor('variant-less compaction fixture stored',async () => {
        const current=await rows(sessionID);const compact=current.find(row=>row.info.id===boundary.userMessageID);
        return compact&&compact.parts.some(part=>part.type==='compaction')
          && !Object.hasOwn(compact.info,'variant')&&!Object.hasOwn(compact.info.model,'variant')
          && current.some(row=>row.info.id===boundary.summaryMessageID&&row.info.summary===true);
      });
      await ui.reload();
      await ui.waitExpression('same session restored after compaction fixture',`new URL(location.href).searchParams.get('session')===${JSON.stringify(sessionID)}`);
      await ui.waitExpression(`${label} thinking restored from the previous real user`,`[...document.querySelectorAll('.model-controls__variant-trigger')].some(e=>e.innerText.trim()===${JSON.stringify(label)})`);
      fixture.configureNextPrompt(sessionID,{chunks:1,intervalMs:10});
      const after=await send(`QA continue with retained ${label} thinking.`);await idle(sessionID);
      assert.equal(after.variant,variant ?? '', 'The first actual send after reload changed the selected thinking value');
      assert.equal(after.model.providerID,before.model.providerID);assert.equal(after.model.modelID,before.model.modelID);assert.equal(after.agent,before.agent);
      evidence.compactionSelectionRestoration.cases.push({variant,...boundary,continuedUserMessageID:after.messageID,observedVariant:after.variant});
      await screenshot(`fixture-compaction-${label.toLowerCase()}-restored`);
    });
  }
  evidence.planApproval=[];
  for(const virtualized of [false,true]) {
  const mode=virtualized?'virtualized':'mounted';
  await check(`${mode} offscreen saved Plan approval survives repeated fixture compaction and reload`,async () => {
    await setVariant('high');
    await ui.type('');
    await ui.key('Tab',{code:'Tab',modifiers:8,windowsVirtualKeyCode:9});
    await ui.click({selector:'button:has(.model-controls__agent-label)'});
    await ui.waitExpression('Plan mode enabled for the source request',"[...document.querySelectorAll('[aria-pressed]')].some(e=>e.innerText?.trim().startsWith('Plan')&&e.getAttribute('aria-pressed')==='true')");
    await ui.key('Escape',{code:'Escape',windowsVirtualKeyCode:27});
    const planTitle=`QA retained ${mode} approval plan`;
    const planText=`<!--plan-->\n# ${planTitle}\n\n## Context\n\nPreserve the selected source plan and High thinking after repeated compaction records.\n\n## Implementation\n\n1. Keep the task creation order.\n2. Preserve the user note.\n3. Verify the approved source before implementation.`;
    fixture.configureNextPrompt(sessionID,{responseText:planText,chunks:1,intervalMs:10});
    const requested=await send('QA prepare a saved plan for approval after compaction.');await idle(sessionID);
    const initialRows=await rows(sessionID);const source=initialRows.find(row=>row.info.role==='assistant'&&row.info.parentID===requested.messageID);
    const requestedUser=initialRows.find(row=>row.info.id===requested.messageID);
    assert.ok(requestedUser.parts.some(part=>part.type==='text'&&part.synthetic===true&&part.text.trim().startsWith('User has requested to enter plan mode')),
      'The source plan must follow an actual Plan-mode composer submission');
    assert.ok(source?.info.time.completed);assert.equal(source.parts.find(part=>part.type==='text').text,planText);
    const selector=`[data-plan-source-message-id=${JSON.stringify(source.info.id)}]`;
    await ui.waitExpression('saved source Plan card ready',`[...document.querySelectorAll(${JSON.stringify(selector + ' button')})].some(e=>e.innerText.trim()==='Implement Plan'&&!e.disabled)`);
    const session=await api(`/api/session/${sessionID}?directory=${encodeURIComponent(projectFixture.fixtureRoot)}`);
    const query=new URLSearchParams({directory:projectFixture.fixtureRoot,sessionCreated:String(session.time.created),sessionSlug:session.slug});
    const saved=await api(`/api/session/${sessionID}/plan-revisions/${source.info.id}?${query}`);
    assert.ok(saved.content.includes(planTitle)&&saved.content.includes('Preserve the user note.'));
    // A normal status turn keeps the source plan actionable while giving later
    // summaries their own visible transcript group. Plan continuations alone
    // are correctly suppressed by the production plan trace.
    await ui.type('');await ui.key('Tab',{code:'Tab',modifiers:8,windowsVirtualKeyCode:9});
    const fillerTurns=virtualized?84:1;
    for(let index=0;index<fillerTurns;index++) {
      fixture.configureNextPrompt(sessionID,{responseText:`QA status ${index+1}: approval is still pending.`,chunks:1,intervalMs:10});
      await send(`QA status ${index+1} for the ${mode} approval fixture; keep the saved plan unchanged.`);await idle(sessionID);
    }
    const boundaries=[];
    for(let index=1;index<=2;index++) {
      const summaryText=`Fixture compaction summary ${index}: the saved plan awaits explicit approval.\n\n`
        +Array.from({length:12},(_,paragraph)=>`Retained context ${paragraph+1}: task creation order, the user note, the exact plan source and High thinking remain unchanged.`).join('\n\n');
      boundaries.push(fixture.appendCompactionBoundary(sessionID,{summaryText}));
    }
    await ui.reload();
    if(virtualized) {
      // The reload starts with a light page. Load older records explicitly so
      // absent DOM below proves virtualization, not absent canonical data.
      for(let page=0;page<8;page++) {
        if(!await evaluate(cdp,"[...document.querySelectorAll('button')].some(e=>e.innerText.trim()==='LOAD OLDER MESSAGES')"))break;
        const top=await evaluate(cdp,"(() => {const e=document.querySelector('[data-scrollbar=\"chat\"]');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,deltaY:-e.scrollHeight,deltaX:0,height:e.scrollHeight};})()");
        const {height,...event}=top;await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',...event});
        await ui.waitExpression('older approval history edge',"document.querySelector('[data-scrollbar=\"chat\"]').scrollTop<=1");
        await ui.click({text:'LOAD OLDER MESSAGES'});
        // Already fetched records can be outside the local presentation page.
        // Each click must commit history growth; only actual HTTP pagination
        // increments the fixture's independent older-request counter.
        await ui.waitExpression('older approval history committed',`document.querySelector('[data-scrollbar="chat"]').scrollHeight>${height}`);
      }
      assert.equal(await evaluate(cdp,"[...document.querySelectorAll('button')].some(e=>e.innerText.trim()==='LOAD OLDER MESSAGES')"),false,
        'Virtualized approval requires all source records loaded');
      await ui.waitExpression('actual approval history virtualization',"Boolean(document.querySelector('[data-scrollbar=\"chat\"] [data-turn-entry][data-index]'))");
    } else {
      await ui.waitExpression('same saved Plan card restored',`[...document.querySelectorAll(${JSON.stringify(selector + ' button')})].some(e=>e.innerText.trim()==='Implement Plan'&&!e.disabled)`);
    }
    const restored=await api(`/api/session/${sessionID}/plan-revisions/${source.info.id}?${query}`);
    assert.equal(restored.path,saved.path);assert.equal(restored.content,saved.content);
    await ui.type('');await ui.key('Tab',{code:'Tab',modifiers:8,windowsVirtualKeyCode:9});
    await ui.click({selector:'button:has(.model-controls__agent-label)'});
    await ui.waitExpression('Plan mode enabled immediately before approval',"[...document.querySelectorAll('[aria-pressed]')].some(e=>e.innerText?.trim().startsWith('Plan')&&e.getAttribute('aria-pressed')==='true')");
    await ui.key('Escape',{code:'Escape',windowsVirtualKeyCode:27});
    const wheel=await evaluate(cdp,"(() => {const e=document.querySelector('[data-scrollbar=\"chat\"]');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,deltaY:e.scrollHeight,deltaX:0};})()");
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',...wheel});
    await ui.waitExpression('post-compaction transcript bottom',"(() => {const e=document.querySelector('[data-scrollbar=\"chat\"]');return e.scrollHeight-e.scrollTop-e.clientHeight<=2;})()");
    const before=await evaluate(cdp,`(() => {const e=[...document.querySelectorAll(${JSON.stringify(selector + ' button')})].find(e=>e.innerText.trim()==='Implement Plan');const s=document.querySelector('[data-scrollbar="chat"]');if(!e||!s)return null;const r=e.getBoundingClientRect(),v=s.getBoundingClientRect();return{centerY:r.y+r.height/2,viewportTop:v.top,viewportBottom:v.bottom,scrollTop:s.scrollTop};})()`);
    if(virtualized) assert.equal(before,null,'The older Plan card must begin unmounted outside the virtualized window');
    else assert.ok(before&&before.centerY<before.viewportTop,'The real Plan approval must begin mounted above the visible transcript');
    await screenshot(`fixture-plan-${mode}-approval-offscreen`);
    await ui.reveal(selector + ' button','Implement Plan',{scrollContainer:'[data-scrollbar="chat"]',direction:'up'});
    await screenshot(`fixture-plan-${mode}-approval-revealed`);
    fixture.configureNextPrompt(sessionID,{chunks:1,intervalMs:10});
    const previous=fixture.getState().receivedPrompts.length;
    await ui.click({selector:selector + ' button',text:'Implement Plan'});
    const accepted=await ui.waitFor('actual Plan-card implementation submitted',()=>fixture.getState().receivedPrompts[previous]);
    await idle(sessionID);
    const implementation=(await rows(sessionID)).find(row=>row.info.id===accepted.messageID);
    const prefix='[openchamber-plan-action:v1] ';
    const markers=implementation.parts.filter(part=>part.type==='text'&&part.synthetic===true&&part.text.startsWith(prefix));
    assert.equal(markers.length,1);
    const marker=JSON.parse(markers[0].text.slice(prefix.length));
    assert.deepEqual(marker,{action:'implement',sourceSessionId:sessionID,sourceMessageId:source.info.id,planIndex:0});
    assert.ok(implementation.parts.some(part=>part.type==='text'&&part.synthetic===true&&part.text.includes(saved.path)),
      'Implementation instructions must refer to the authoritative saved plan path');
    assert.equal(implementation.parts.some(part=>part.type==='text'&&part.synthetic===true&&part.text.trim().startsWith('User has requested to enter plan mode')),false);
    assert.equal(accepted.variant,'high');assert.equal(accepted.agent,requested.agent);assert.equal(implementation.info.model.variant,'high');
    await ui.click({selector:'button:has(.model-controls__agent-label)'});
    await ui.waitExpression('Plan mode disabled after approval',"[...document.querySelectorAll('[aria-pressed]')].some(e=>e.innerText?.trim().startsWith('Plan')&&e.getAttribute('aria-pressed')==='false')");
    await ui.key('Escape',{code:'Escape',windowsVirtualKeyCode:27});
    await ui.waitExpression('approval agent menu fully closed',"![...document.querySelectorAll('[role=\"menu\"]')].some(e=>e.getBoundingClientRect().width>0)");
    evidence.planApproval.push({source:'actual Plan-card approval after synthetic stored compaction records; native lifecycle and managed scheduler not simulated',mode,fillerTurns,
      sourceMessageID:source.info.id,requestedUserMessageID:requested.messageID,boundaries,offscreenBeforeReveal:before,
      implementationUserMessageID:accepted.messageID,marker,variant:accepted.variant,planMode:false,savedContentPreserved:true});
    await screenshot(`fixture-plan-${mode}-approved`);
  });
  }
  await check('superseded Plan stays disabled and fresh current-plan approval uses its new source',async () => {
    await setVariant('high');await setPlanMode(true);
    const originalPlan='# QA current approval plan\n\n## Context\n\nPreserve task creation order and the existing user note.\n\n## Implementation\n\nAdd the labeled Priority filter and persisted low, normal and high priorities.\n';
    const projectPlan=originalPlan+'\n## Verification\n\n'+Array.from({length:12},(_,index)=>`${index+1}. Verify the existing task and persistence contracts without changing creation order or removing original tests.`).join('\n')+'\n';
    await mkdir(path.join(projectFixture.fixtureRoot,'.opencode/plans'),{recursive:true});
    await writeFile(path.join(projectFixture.fixtureRoot,'.opencode/plans/qa-current.md'),projectPlan);
    const expectedProjectPlan=await captureQaCompactionProjectPlan(projectFixture);
    fixture.configureNextPrompt(sessionID,{responseText:'<!--plan-->\n'+originalPlan,chunks:1,intervalMs:10});
    const requested=await send('QA present the current saved plan and await an operational review.');await idle(sessionID);
    const session=await api(`/api/session/${sessionID}?directory=${encodeURIComponent(projectFixture.fixtureRoot)}`);
    const query=new URLSearchParams({directory:projectFixture.fixtureRoot,sessionCreated:String(session.time.created),sessionSlug:session.slug});
    const captureSavedPlan=async name => {
      const source=(await rows(sessionID)).toReversed().find(row=>row.info.role==='assistant'&&row.info.time.completed
        &&row.parts.some(part=>part.type==='text'&&part.text?.startsWith('<!--plan-->')));
      assert.ok(source,'The fixture has no canonical Plan source');
      const selector=`[data-plan-source-message-id=${JSON.stringify(source.info.id)}] button`;
      await ui.waitExpression('current source Plan card actionable',`[...document.querySelectorAll(${JSON.stringify(selector)})].some(e=>e.innerText.trim()==='Implement Plan'&&!e.disabled)`);
      const saved=await api(`/api/session/${sessionID}/plan-revisions/${source.info.id}?${query}`);
      const file=path.join(projectFixture.evidenceDirectory,`${name}.md`);await writeFile(file,saved.content);
      return{path:file,sha256:createHash('sha256').update(saved.content).digest('hex'),sourceMessageID:source.info.id,canonicalPath:saved.path};
    };
    const previousPlan=await captureSavedPlan('fixture-previous-ui-plan');
    fixture.configureNextPrompt(sessionID,{responseText:'The operational review is ready. Keep the saved plan unchanged and await approval.',chunks:1,intervalMs:10});
    const acknowledgment=await send('QA keep the current plan unchanged and acknowledge readiness without returning a new plan.');await idle(sessionID);
    assertQaSubmittedPlanMode((await rows(sessionID)).find(row=>row.info.id===acknowledgment.messageID),true);
    const boundaries=[fixture.appendCompactionBoundary(sessionID),fixture.appendCompactionBoundary(sessionID)];
    await ui.reload();await expectPlanMode(true);
    const previousSelector=`[data-plan-source-message-id=${JSON.stringify(previousPlan.sourceMessageID)}]`;
    await ui.waitExpression('new human Plan request supersedes the old card',`(() => {const e=[...document.querySelectorAll(${JSON.stringify(previousSelector+' button')})].find(e=>e.innerText.trim()==='Implement Plan');return e?.disabled&&e.title==='Superseded by a newer plan.';})()`);
    await ui.reveal(previousSelector+' button','Implement Plan',{scrollContainer:'[data-scrollbar="chat"]',direction:'up',allowDisabled:true,fullyVisible:true});
    const previousCardVisibility=await ui.waitExpression('exact superseded Plan approval remains disabled and visible',`(() => {
      const e=[...document.querySelectorAll(${JSON.stringify(previousSelector+' button')})].find(e=>e.innerText.trim()==='Implement Plan');
      if(!e?.disabled||e.title!=='Superseded by a newer plan.')return false;
      const r=e.getBoundingClientRect();const center={x:r.x+r.width/2,y:r.y+r.height/2};
      const s=document.querySelector('[data-scrollbar="chat"]')?.getBoundingClientRect();if(!s)return false;
      const clip={top:Math.max(0,s.top),bottom:Math.min(innerHeight,s.bottom),left:Math.max(0,s.left),right:Math.min(innerWidth,s.right)};
      if(r.width<=0||r.height<=0||r.top<clip.top||r.bottom>clip.bottom||r.left<clip.left||r.right>clip.right)return false;
      const hit=document.elementFromPoint(center.x,center.y);
      const centerHitOwned=Boolean(hit&&(e.contains(hit)||(getComputedStyle(e).pointerEvents==='none'&&hit===e.parentElement)));
      if(!centerHitOwned)return false;
      return {disabled:true,title:e.title,rect:{x:r.x,y:r.y,width:r.width,height:r.height},clip,centerHitOwned,
        hitTarget:e.contains(hit)?'button':'immediate-footer-parent'};
    })()`);
    await screenshot('fixture-superseded-plan-disabled');
    const prepared=await prepareQaCompactionApproval({projectFixture,priorSavedPlan:previousPlan,expectedProjectPlan,messages:()=>rows(sessionID),captureSavedPlan,
      evidenceName:'fixture-fresh-current-plan',sendTurn:async text=>{
        fixture.configureNextPrompt(sessionID,{responseText:'<!--plan-->\n'+projectPlan,chunks:1,intervalMs:10});
        await send(text);await idle(sessionID);return rows(sessionID);
      }});
    const selector=`[data-plan-source-message-id=${JSON.stringify(prepared.savedPlan.sourceMessageID)}] button`;
    await ui.reveal(selector,'Implement Plan',{scrollContainer:'[data-scrollbar="chat"]',direction:'up'});
    await screenshot('fixture-fresh-current-plan-actionable');
    fixture.configureNextPrompt(sessionID,{chunks:1,intervalMs:10});
    const beforeIds=new Set((await rows(sessionID)).map(row=>row.info.id));
    const previous=fixture.getState().receivedPrompts.length;
    await ui.click({selector,text:'Implement Plan'});
    await ui.waitFor('fresh source implementation submitted',()=>fixture.getState().receivedPrompts[previous]);await idle(sessionID);
    const user=findQaPlanApprovalUser(await rows(sessionID),beforeIds,{sessionID,sourceMessageID:prepared.savedPlan.sourceMessageID,
      cell:{...cell,variant:'high'},nativeAgent:requested.agent});
    assert.ok(user);await expectPlanMode(false);
    evidence.freshPlanApproval={...prepared.evidence,boundaries,previousCardDisabledReason:'Superseded by a newer plan.',previousCardVisibility,
      implementationUserMessageID:user.info.id,source:'actual UI policy and stored fixture records; no native compaction claim'};
    await screenshot('fixture-fresh-current-plan-approved');
  });

  evidence.planSelectionRestoration=[];
  for(const expected of [true,false]) {
    await check(`canonical Plan ${expected?'on':'off'} survives ordinary, manual and automatic-continuation reloads`,async () => {
      await setVariant('high');await setPlanMode(expected);
      fixture.configureNextPrompt(sessionID,{chunks:1,intervalMs:10});
      const seed=await send(`QA preserve Plan ${expected?'on':'off'} as the current user preference.`);await idle(sessionID);
      assertQaSubmittedPlanMode((await rows(sessionID)).find(row=>row.info.id===seed.messageID),expected);
      for(const kind of ['ordinary','manual','automatic-continuation']) {
        let boundary;
        if(kind!=='ordinary') boundary=fixture.appendCompactionBoundary(sessionID,{autoContinue:kind==='automatic-continuation'});
        if(boundary?.continuationUserMessageID) {
          const continuation=(await rows(sessionID)).find(row=>row.info.id===boundary.continuationUserMessageID);
          assert.ok(continuation.parts.every(part=>part.synthetic===true));
          assert.equal(continuation.parts[0].metadata.compaction_continue,true);
          assert.equal(continuation.info.model.variant,'high');
        }
        await ui.reload();await expectPlanMode(expected,`fixture-plan-${expected?'on':'off'}-${kind}-restored`);
        fixture.configureNextPrompt(sessionID,{chunks:1,intervalMs:10});
        const accepted=await send(`QA verify the retained Plan preference after ${kind} reload.`);await idle(sessionID);
        const user=(await rows(sessionID)).find(row=>row.info.id===accepted.messageID);
        assertQaSubmittedPlanMode(user,expected);assert.equal(user.info.model.variant,'high');
        evidence.planSelectionRestoration.push({planMode:expected,kind,boundary,userMessageID:user.info.id,
          source:'actual UI selection and submission after stored fixture records; no native lifecycle claim'});
      }
    });
  }
  await setVariant(null);

  if(cell.scenarioId==='mobile') {
    fixture.configureNextPrompt(sessionID,{reasoning:'text',reasoningText:'Check narrow viewports, touch targets and the reachable composer.',hold:true});
    await send('QA mobile busy transcript.');
    const assistant=await latestAssistant(sessionID);
    const reasoningSelector=visibleRow(assistant.info.id) + ' [data-reasoning-group] button';
    await ui.waitExpression('mobile reasoning trigger',`Boolean(document.querySelector(${JSON.stringify(reasoningSelector)}))`);
    await evaluate(cdp,`document.querySelector(${JSON.stringify(reasoningSelector)}).focus()`);
    await ui.key('Enter',{code:'Enter',windowsVirtualKeyCode:13});
    await ui.waitExpression('mobile reasoning disclosure layout opened',`(() => {const e=document.querySelector(${JSON.stringify(visibleRow(assistant.info.id) + ' [data-reasoning-disclosure-content]')});return e && e.getBoundingClientRect().height>0 && e.getBoundingClientRect().height>=e.scrollHeight-1;})()`);
    await ui.waitVisibleText('Check narrow viewports, touch targets',visibleRow(assistant.info.id));
    await ui.type('Queued mobile follow-up remains reachable.');
    await ui.key('Enter',{code:'Enter',windowsVirtualKeyCode:13});
    await ui.waitExpression('mobile queue visible',"Boolean(document.querySelector('button[aria-label=\"Remove from Queue\"]'))");
    try {
      for(const theme of ['light','dark']) {
        await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
        for(const [width,height] of [[390,844],[844,390],[768,1024]]) {
          await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
          await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true});await pause(500);
          await check(`fixture mobile ${theme} ${width}x${height}`,async () => {
            const bounds=await evaluate(cdp,"(()=>{const r=document.querySelector('textarea').getBoundingClientRect();return{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,composer:{x:r.x,y:r.y,width:r.width,height:r.height}}})()");
            assert.equal(await evaluate(cdp,"document.documentElement.classList.contains('dark')"),theme==='dark','The requested system theme must actually be rendered');
            assert.ok(bounds.scrollWidth<=width+1 && bounds.composer.width>0 && bounds.composer.x>=0 && bounds.composer.x+bounds.composer.width<=width+1
              && bounds.composer.y>=0 && bounds.composer.y+bounds.composer.height<=height+1,'Mobile composer overflow');
            assert.equal(await evaluate(cdp,`document.querySelector(${JSON.stringify(reasoningSelector)})?.getAttribute('aria-expanded')`),'true','Viewport changes must retain the opened reasoning disclosure');
            if(width<800) {
              await ui.click({label:'Open Sessions',touch:true});
              await ui.waitExpression('touch drawer fully open',"(() => {const e=document.querySelector('aside[aria-hidden=\"false\"]');if(!e)return false;const r=e.getBoundingClientRect();return Math.abs(r.left)<=1&&r.width>0&&r.right<=innerWidth+1;})()");
              await screenshot(`fixture-${theme}-${width}x${height}-drawer`);
              await ui.click({label:'Close Sessions',touch:true});
              await ui.waitExpression('touch drawer fully closed',"[...document.querySelectorAll('aside[aria-hidden=\"true\"]')].every(e=>{const r=e.getBoundingClientRect();return r.right<=1||r.left>=innerWidth-1})");
            }
            await screenshot(`fixture-${theme}-${width}x${height}`);
          });
        }
      }
    } finally {
      await cdp.send('Emulation.clearDeviceMetricsOverride');await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});
      if(await evaluate(cdp,"Boolean(document.querySelector('button[aria-label=\"Remove from Queue\"]'))")) await ui.click({label:'Remove from Queue'});
      await ui.click({label:'Stop Generating'});await idle(sessionID);
    }
    evidence.mobileRich={};
    await runQaFixtureMobileCoverage({cell,fixture,projectFixture,cdp,ui,api,check,screenshot,
      send,idle,latestAssistant,setPlanMode,selectSession,outputEvidence:evidence.mobileRich});
    evidence.sessionIDs.push(evidence.mobileRich.sessionID,...evidence.mobileRich.managedTasks.records.map(record=>record.child.sessionID));
  }
  if(cell.scenarioId==='core-journey') {
    await check('manual compaction keyboard submission survives both queue modes and activity transitions',async () => {
      await selectSession(PERF_PARENT_SESSION_ID);
      evidence.manualSubmission = await runQaManualSubmissionFixtureProof({cell,fixture,projectFixture,cdp,ui,runDeadline});
      await screenshot('fixture-manual-submission-proof');
      await selectSession(sessionID);
    });
  }
  evidence.transportState=fixture.getState();
  return evidence;
}

// Uses actual ChatInput against the fixture's existing unsupported summarize
// route. A 404 proves command routing only; no native boundary is synthesized.
export async function runQaManualSubmissionFixtureProof({cell,fixture,projectFixture,cdp,ui,runDeadline}) {
  assert.ok(cell?.transport==='fixture' && cell.scenarioId==='core-journey', 'Queue mutation is restricted to the private desktop fixture');
  const evidence={source:'actual-shared-ui-with-fixture-transport',nativeCompactionAcceptance:false,attempts:[]};
  const persist=()=>writeFile(path.join(projectFixture.evidenceDirectory,'manual-submission-fixture.json'),JSON.stringify(evidence,null,2),{mode:0o600});
  const original=await readQaManualCompactionQueueMode({cdp,ui});
  evidence.originalQueueMode=original;
  const setFixtureQueueMode=async enabled=>{
    await ui.click({label:'Settings'});
    try {
      await ui.click({selector:'[data-settings-view] button',text:'Appearance'});
      const current=await ui.waitExpression('fixture queue preference',QA_QUEUE_MODE_STATE);
      if(current.enabled!==enabled) await ui.click({selector:`[role="button"][aria-pressed]:has(${QA_QUEUE_MODE_CONTROL})`});
      return await ui.waitExpression('fixture queue preference applied',`(() => {const state=${QA_QUEUE_MODE_STATE};return state?.enabled===${enabled}?state:null;})()`);
    } finally {
      await ui.click({selector:'[data-settings-view] button',label:'Back'});
      await ui.waitExpression('fixture chat restored',`!document.querySelector('[data-settings-view]') && Boolean(document.querySelector(${JSON.stringify(QA_COMPACTION_COMPOSER)}))`);
    }
  };
  const waitActivity=busy=>ui.waitExpression(`fixture composer ${busy?'Stop':'Send'} state`,
    `new URL(location.href).searchParams.get('session')===${JSON.stringify(PERF_PARENT_SESSION_ID)} && Boolean(document.querySelector('button[aria-label="${busy?'Stop Generating':'Send Message'}"]'))`);
  try {
    for(const enabled of [true,false]) {
      const queueModeObservation=await setFixtureQueueMode(enabled);
      for(const transition of ['idle-to-busy','busy-to-idle']) {
        const startsBusy=transition==='busy-to-idle';
        if(startsBusy) fixture.startScenario('one-stream'); else fixture.stopScenario();
        await waitActivity(startsBusy);
        const before=fixture.getState();
        const attempt={transition,queueModeObservation,submission:{},otherSessionMutations:[]};
        evidence.attempts.push(attempt);
        const unsubscribe=cdp.on('Network.requestWillBeSent',event=>{
          if(event.request?.method!=='POST')return;
          let url;try{url=new URL(event.request.url);}catch{return;}
          const prefix=`/api/session/${PERF_PARENT_SESSION_ID}/`;
          if(url.origin!==original.origin || !url.pathname.startsWith(prefix))return;
          const action=url.pathname.slice(prefix.length);
          if(['abort','prompt_async','message','command','shell'].includes(action)) {
            if(attempt.otherSessionMutations.length<8)attempt.otherSessionMutations.push({action,observedAt:Date.now()});
            attempt.otherSessionMutationCount=(attempt.otherSessionMutationCount??0)+1;
          }
        });
        try {
          await assert.rejects(withQaManualCompactionSubmission({cdp,ui,origin:original.origin,sessionID:PERF_PARENT_SESSION_ID,
            queueModeEnabled:queueModeObservation.enabled,deadline:runDeadline,receipt:attempt.submission,persist,
            beforeKey:async()=>{
              if(startsBusy)fixture.stopScenario();else fixture.startScenario('one-stream');
              await waitActivity(!startsBusy);
              attempt.activityTransitionObservedAt=Date.now();
            }},observer=>observer.waitForAcknowledgement()),error=>{
            assert.match(error.message,/Manual compaction submission failed/);
            assert.equal(attempt.submission.failure,'summarize-http-rejected');
            assert.equal(attempt.submission.requests[0]?.response?.status,404);
            return true;
          });
          await ui.waitExpression('rejected compact command consumed without queue entry',
            `document.querySelector(${JSON.stringify(QA_COMPACTION_COMPOSER)})?.value==='' && !document.querySelector('button[aria-label="Remove from Queue"]')`);
          fixture.stopScenario();
          await waitActivity(false);
          const after=fixture.getState();
          assert.equal(attempt.submission.matchingRequestCount,1);
          assert.equal(attempt.otherSessionMutationCount??0,0,'Manual compact must not abort or submit an ordinary prompt');
          assert.equal(after.receivedPrompts.length,before.receivedPrompts.length,'Compact was submitted as an ordinary prompt');
          assert.equal(after.abortedPrompts,before.abortedPrompts,'Compact aborted an active prompt');
          const summarizeRoutes=after.unknownRoutes.slice(before.unknownRoutes.length).filter(route=>route.method==='POST'
            && route.path===`/session/${PERF_PARENT_SESSION_ID}/summarize`);
          assert.equal(summarizeRoutes.length,1,'Fixture did not receive the exact summarize route once');
          attempt.outcome='passed-command-routing-with-expected-404';
        } finally { unsubscribe(); await persist(); }
      }
    }
    evidence.outcome='passed';
    return evidence;
  } catch(error) {
    evidence.outcome='failed';evidence.failure='manual-submission-fixture-assertion-failed';throw error;
  } finally {
    fixture.stopScenario();
    try { await setFixtureQueueMode(original.enabled);evidence.queueModeRestored=true; }
    finally { await persist(); }
  }
}
