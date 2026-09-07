import http from 'node:http';
import { toManagedTaskEvent, toManagedTaskRemovalEvent, validateManagedTaskRecord } from '../../packages/orchestration-runtime/contract.js';
import { assertManagedTaskResultEnvelopeMatchesTask } from '../../packages/orchestration-runtime/result-envelope.js';

export const PERF_PARENT_SESSION_ID = 'ses_perfparent';
export const PERF_CHILD_SESSION_IDS = [
  'ses_perfchild1',
  'ses_perfchild2',
  'ses_perfchild3',
];

const ALL_SESSION_IDS = [PERF_PARENT_SESSION_ID, ...PERF_CHILD_SESSION_IDS];
const FIXED_CREATED_AT = Date.now();

const streamFixtureChunks = new Map([
  [PERF_PARENT_SESSION_ID, ['Renderer ', 'paint ', 'fixture ', 'parent.\n']],
  [PERF_CHILD_SESSION_IDS[0], ['Child ', 'one ', 'stream ', 'α.\n']],
  [PERF_CHILD_SESSION_IDS[1], ['Child ', 'two ', 'stream ', 'β.\n']],
  [PERF_CHILD_SESSION_IDS[2], ['Child ', 'three ', 'stream ', 'γ.\n']],
]);

const json = (response, status, value) => {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
};

const createSession = (id, directory, parentID) => ({
  id,
  slug: id,
  projectID: 'project_perf',
  directory,
  parentID,
  title: id === PERF_PARENT_SESSION_ID ? 'Performance parent' : `Performance ${id.slice(-7)}`,
  version: '1',
  time: {
    created: FIXED_CREATED_AT,
    updated: FIXED_CREATED_AT + (id === PERF_PARENT_SESSION_ID ? 4 : Number(id.slice(-1))),
  },
});

const userMessage = (sessionID) => ({
  id: `msg_user_${sessionID}`,
  sessionID,
  role: 'user',
  time: { created: FIXED_CREATED_AT + 10 },
  agent: 'build',
  model: { providerID: 'fixture', modelID: 'fixture-model' },
});

const assistantMessage = (sessionID, terminal, createdAt, directory) => ({
  id: `msg_assistant_${sessionID}`,
  sessionID,
  parentID: `msg_user_${sessionID}`,
  role: 'assistant',
  time: {
    created: createdAt + 20,
    ...(terminal ? { completed: createdAt + 30 } : {}),
  },
  agent: 'build',
  providerID: 'fixture',
  modelID: 'fixture-model',
  mode: 'build',
  path: { cwd: directory, root: directory },
  cost: 0,
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  ...(terminal ? { finish: 'stop' } : {}),
});

const userPart = (sessionID) => ({
  id: `part_user_${sessionID}`,
  sessionID,
  messageID: `msg_user_${sessionID}`,
  type: 'text',
  text: 'Run the deterministic renderer performance fixture.',
});

const assistantPart = (sessionID, text, terminal) => ({
  id: `part_text_${sessionID}`,
  sessionID,
  messageID: `msg_assistant_${sessionID}`,
  type: 'text',
  text,
  time: {
    start: FIXED_CREATED_AT + 20,
    ...(terminal ? { end: FIXED_CREATED_AT + 30 } : {}),
  },
});

export const createLoopbackOpenCodeFixture = async ({ directory, agentVariant, thinkingModels }) => {
  if (agentVariant !== undefined && !['low','high'].includes(agentVariant)) throw new Error('Invalid fixture agent variant');
  const sessions = ALL_SESSION_IDS.map((id) => (
    createSession(id, directory, id === PERF_PARENT_SESSION_ID ? undefined : PERF_PARENT_SESSION_ID)
  ));
  const sessionByID = new Map(sessions.map((session) => [session.id, session]));
  const statuses = Object.fromEntries(ALL_SESSION_IDS.map((id) => [id, { type: 'idle' }]));
  const texts = new Map(ALL_SESSION_IDS.map((id) => [id, '']));
  const terminals = new Set(ALL_SESSION_IDS);
  const chunkIndexes = new Map(ALL_SESSION_IDS.map((id) => [id, 0]));
  const sseClients = new Set();
  const sseSubscriptions = new WeakMap();
  const messageRequestCounts = new Map();
  const olderMessageRequestCounts = new Map();
  const messagePageRequests = [];
  const streamStarts = new Map();
  const promptRows = new Map();
  const promptTimers = new Map();
  const receivedPrompts = [];
  const promptBehaviors = new Map();
  let nextCreatedSessionPrompt = null;
  const delayedCanonicalUsers = new Map();
  const canonicalUserDelays = [];
  const historyRows = new Map();
  const historyNamespaces = new Map();
  const permissions = new Map();
  const questions = new Map();
  const todos = new Map();
  const replies = [];
  const rejectedPrompts = [];
  const unknownRoutes = [];
  let nextPrompt = 0;
  let abortedPrompts = 0;
  let eventID = 0;
  let streamTimer = null;
  let activeScenario = 'idle';
  let eventSuppression = null;
  const suppressedEvents = [];
  const suppressionRuns = [];
  let statusRequestCount = 0;
  let sseConnectionCount = 0;

  const sendEvent = (directoryHint, payload) => {
    eventID += 1;
    if (eventSuppression) {
      const rule = eventSuppression;
      const properties = payload.properties ?? {};
      const sessionID = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID;
      const messageID = properties.messageID ?? properties.info?.id ?? properties.part?.messageID;
      if (Date.now() >= rule.expiresAt) {
        rule.endedReason = 'expired'; eventSuppression = null;
      } else if (sessionID === rule.sessionID && rule.types.includes(payload.type)
        && (payload.type === 'session.status' || messageID === rule.messageID)) {
        rule.suppressedCount += 1;
        suppressedEvents.push({ eventID, at: Date.now(), type: payload.type, sessionID, messageID: messageID ?? null,
          partID: properties.partID ?? properties.part?.id ?? null, status: properties.status?.type ?? null });
        if (rule.suppressedCount === rule.maximumEvents) {
          rule.endedReason = 'count-limit'; eventSuppression = null;
        }
        return;
      }
    }
    const frame = `id: ${eventID}\ndata: ${JSON.stringify({ directory: directoryHint, payload })}\n\n`;
    for (const client of sseClients) {
      const subscription=sseSubscriptions.get(client);
      if (subscription?.global) client.write(frame);
      else if ((!subscription?.directory || subscription.directory === directoryHint || directoryHint === 'global')) {
        client.write(`id: ${eventID}\ndata: ${JSON.stringify(payload)}\n\n`);
      }
    }
  };

  const emitStatus = (sessionID, status) => {
    statuses[sessionID] = status;
    sendEvent(directory, {
      type: 'session.status',
      properties: { sessionID, status },
    });
  };

  const requireSession = (sessionID) => {
    if (!sessionByID.has(sessionID)) throw new Error('Unknown fixture session');
  };
  const readInput = async (request, response, { empty = false } = {}) => {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body) > 1024 * 1024) { json(response, 413, { error: 'fixture request too large' }); return null; }
    }
    let input;
    try { input = body || !empty ? JSON.parse(body) : {}; }
    catch { json(response, 400, { error: 'invalid JSON' }); return null; }
    if (!input || typeof input !== 'object' || Array.isArray(input)) { json(response, 400, { error: 'object required' }); return null; }
    return input;
  };
  const validatePromptOptions = (options) => {
    const keys = ['reasoning','reasoningText','reasoningDelayChunks','tool','hold','chunks','intervalMs','rejectStatus','responseText','canonicalUserDelayMs'];
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => !keys.includes(key))) throw new Error('Invalid fixture prompt options');
    const behavior = { reasoning:'none', reasoningText:'Checking the task requirements before answering.', reasoningDelayChunks:3,
      tool:'none', hold:false, chunks:20, intervalMs:100, canonicalUserDelayMs:0, ...options };
    if (!['none','delayed','empty','text'].includes(behavior.reasoning) || !['none','completed','error'].includes(behavior.tool)
      || typeof behavior.hold !== 'boolean' || typeof behavior.reasoningText !== 'string' || behavior.reasoningText.length > 16_384
      || !Number.isSafeInteger(behavior.reasoningDelayChunks) || behavior.reasoningDelayChunks < 0 || behavior.reasoningDelayChunks > 1000
      || !Number.isSafeInteger(behavior.chunks) || behavior.chunks < 1 || behavior.chunks > 1000
      || !Number.isSafeInteger(behavior.intervalMs) || behavior.intervalMs < 10 || behavior.intervalMs > 10_000
      || !Number.isSafeInteger(behavior.canonicalUserDelayMs) || behavior.canonicalUserDelayMs < 0 || behavior.canonicalUserDelayMs > 10_000
      || (behavior.responseText !== undefined && (typeof behavior.responseText !== 'string' || behavior.responseText.length > 16_384))
      || (behavior.rejectStatus !== undefined && ![400,409,429,500].includes(behavior.rejectStatus))) throw new Error('Invalid fixture prompt options');
    return behavior;
  };
  const configureNextPrompt = (sessionID, options) => {
    requireSession(sessionID);
    promptBehaviors.set(sessionID, validatePromptOptions(options));
  };

  const askPermission = (sessionID, { permission = 'bash', patterns = ['npm test'] } = {}) => {
    requireSession(sessionID);
    if (typeof permission !== 'string' || !permission || !Array.isArray(patterns) || !patterns.length || patterns.some((pattern) => typeof pattern !== 'string')) throw new Error('Invalid fixture permission');
    const request = { id:`per_qa${++nextPrompt}`, sessionID, permission, patterns:[...patterns], always:[...patterns], metadata:{} };
    permissions.set(request.id, request);
    sendEvent(directory, {type:'permission.asked',properties:request});
    return request.id;
  };
  const askQuestion = (sessionID, { question = 'Which implementation should be used?', options = ['Keep creation order','Sort by priority'] } = {}) => {
    requireSession(sessionID);
    if (typeof question !== 'string' || !question || !Array.isArray(options) || options.length < 2 || options.some((option) => typeof option !== 'string' || !option)) throw new Error('Invalid fixture question');
    const request = {id:`que_qa${++nextPrompt}`,sessionID,questions:[{header:'Task order',question,options:options.map((label) => ({label,description:label})),multiple:false,custom:true}]};
    questions.set(request.id,request);
    sendEvent(directory,{type:'question.asked',properties:request});
    return request.id;
  };
  const setTodos = (sessionID, items) => {
    requireSession(sessionID);
    if (!Array.isArray(items) || items.length > 100 || items.some((item) => typeof item?.content !== 'string'
      || !['pending','in_progress','completed','cancelled'].includes(item.status) || !['high','medium','low'].includes(item.priority))) throw new Error('Invalid fixture todos');
    todos.set(sessionID,structuredClone(items));
    sendEvent(directory,{type:'todo.updated',properties:{sessionID,todos:items}});
  };

  const seedHistory = (sessionID, { turns, textBytes = 128 } = {}) => {
    requireSession(sessionID);
    if (!Number.isSafeInteger(turns) || turns < 1 || turns > 2000 || !Number.isSafeInteger(textBytes)
      || textBytes < 32 || textBytes > 65_536 || turns * textBytes > 32 * 1024 * 1024) throw new Error('Invalid fixture history size');
    if (promptTimers.has(sessionID) || streamTimer !== null) throw new Error('Seed history before starting a workload');
    if (!historyNamespaces.has(sessionID)) historyNamespaces.set(sessionID, historyNamespaces.size);
    const namespace = historyNamespaces.get(sessionID).toString(16).padStart(8,'0');
    const rows = [];
    for (let index = 0; index < turns; index++) {
      const created = FIXED_CREATED_AT - (turns - index) * 1000;
      // OpenCode message IDs sort by their timestamp prefix. History consumers
      // use that ordering when reconciling a prepended server page. A stable
      // per-session namespace prevents directory-wide part/cache collisions.
      const suffix = namespace + index.toString(16).padStart(6,'0');
      const userID = `msg_${(BigInt(created) << 12n).toString(16).padStart(14,'0')}${suffix}`;
      const assistantID = `msg_${(BigInt(created + 20) << 12n).toString(16).padStart(14,'0')}${suffix}`;
      rows.push({info:{...userMessage(sessionID),id:userID,time:{created}},parts:[{...userPart(sessionID),id:`prt_history_user_${sessionID}_${index}`,messageID:userID,text:`History request ${index + 1}`} ]});
      const prefix = `History response ${index + 1}. `;
      // Number every filler segment. A long repeated character run is treated
      // as a duplicate transport frame by the real UI, shrinking the intended
      // history workload before it reaches the renderer.
      let text = prefix;
      for (let segment = 1; text.length < textBytes; segment++) {
        text += `${String(segment).padStart(5, '0')}: The fixture preserves this numbered detail. `;
      }
      rows.push({info:{...assistantMessage(sessionID,true,created,directory),id:assistantID,parentID:userID},parts:[{
        ...assistantPart(sessionID,text.slice(0,textBytes),true),id:`prt_history_answer_${sessionID}_${index}`,messageID:assistantID,
      }]});
    }
    historyRows.set(sessionID,rows);
    return {sessionID,turns,messages:rows.length};
  };

  const resetStream = (sessionID) => {
    streamStarts.set(sessionID, Date.now());
    texts.set(sessionID, '');
    terminals.delete(sessionID);
    chunkIndexes.set(sessionID, 0);
    sendEvent(directory, {
      type: 'message.updated',
      properties: { info: assistantMessage(sessionID, false, streamStarts.get(sessionID), directory) },
    });
    sendEvent(directory, {
      type: 'message.part.updated',
      properties: { part: assistantPart(sessionID, '', false) },
    });
  };

  const stopScenario = ({ settle = true } = {}) => {
    if (streamTimer !== null) {
      clearInterval(streamTimer);
      streamTimer = null;
    }
    if (settle) {
      for (const sessionID of ALL_SESSION_IDS) {
        if (statuses[sessionID]?.type !== 'busy') continue;
        terminals.add(sessionID);
        sendEvent(directory, {
          type: 'message.part.updated',
          properties: { part: assistantPart(sessionID, texts.get(sessionID) ?? '', true) },
        });
        sendEvent(directory, {
          type: 'message.updated',
          properties: { info: assistantMessage(sessionID, true, streamStarts.get(sessionID), directory) },
        });
        emitStatus(sessionID, { type: 'idle' });
      }
    }
    activeScenario = 'idle';
  };

  const startScenario = (scenario) => {
    if (!['idle','one-stream','four-stream'].includes(scenario)) throw new Error('Invalid fixture streaming scenario');
    stopScenario({ settle: false });
    activeScenario = scenario;
    const activeSessionIDs = (scenario === 'four-stream'
      ? ALL_SESSION_IDS
      : scenario === 'one-stream'
        ? [PERF_PARENT_SESSION_ID]
        : []).filter((id) => sessionByID.has(id));

    for (const sessionID of ALL_SESSION_IDS) {
      if (!sessionByID.has(sessionID)) continue;
      statuses[sessionID] = { type: 'idle' };
    }
    for (const sessionID of activeSessionIDs) {
      emitStatus(sessionID, { type: 'busy' });
      resetStream(sessionID);
    }
    if (activeSessionIDs.length === 0) return;

    streamTimer = setInterval(() => {
      for (const sessionID of activeSessionIDs) {
        const chunks = streamFixtureChunks.get(sessionID) ?? ['fixture'];
        const index = chunkIndexes.get(sessionID) ?? 0;
        const delta = chunks[index % chunks.length];
        chunkIndexes.set(sessionID, index + 1);
        texts.set(sessionID, `${texts.get(sessionID) ?? ''}${delta}`);
        sendEvent(directory, {
          type: 'message.part.delta',
          properties: {
            sessionID,
            messageID: `msg_assistant_${sessionID}`,
            partID: `part_text_${sessionID}`,
            field: 'text',
            delta,
          },
        });
        if (index % 10 === 9) {
          sendEvent(directory, {
            type: 'message.part.updated',
            properties: { part: assistantPart(sessionID, texts.get(sessionID), false) },
          });
        }
      }
    }, 16);
  };

  const getCanonicalMessages = (sessionID) => {
    const terminal = terminals.has(sessionID);
    return [
      ...(historyRows.get(sessionID) ?? []),
      ...(ALL_SESSION_IDS.includes(sessionID) ? [
      { info: userMessage(sessionID), parts: [userPart(sessionID)] },
      ...(streamStarts.has(sessionID) ? [{
        info: assistantMessage(sessionID, terminal, streamStarts.get(sessionID), directory),
        parts: [assistantPart(sessionID, texts.get(sessionID) ?? '', terminal)],
      }] : []),
      ] : []),
      ...(promptRows.get(sessionID) ?? []),
    ];
  };
  const getMessages = (sessionID) => getCanonicalMessages(sessionID).filter(row => !delayedCanonicalUsers.has(row.info.id));

  // Faithful stored-message shape for selection-restoration regressions only.
  // This does not claim a native compaction request, threshold or lifecycle.
  const appendCompactionBoundary = (sessionID, options = {}) => {
    requireSession(sessionID);
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key=>!['summaryText','autoContinue'].includes(key))
      || (options.autoContinue !== undefined && typeof options.autoContinue !== 'boolean')
      || (options.summaryText !== undefined && (typeof options.summaryText !== 'string' || !options.summaryText.trim() || options.summaryText.length > 16_384))) {
      throw new Error('Invalid fixture compaction options');
    }
    if (promptTimers.has(sessionID)) throw new Error('Cannot append a compaction fixture during an active prompt');
    const previous = getMessages(sessionID).filter(row => row.info.role === 'user'
      && !row.parts.some(part => part.type === 'compaction') && row.parts.some(part => part.synthetic !== true)).at(-1);
    if (!previous) throw new Error('A real fixture user turn is required before compaction records');
    const now = Math.max(Date.now(), getMessages(sessionID).at(-1).info.time.created + 1);
    const identity = ++nextPrompt;
    const messageID = (at) => `msg_${((BigInt(at) << 12n) & 0xffffffffffffn).toString(16).padStart(12,'0')}${String(identity).padStart(14,'0')}`;
    const userID = messageID(now); const summaryID = messageID(now + 1);
    const user = { id:userID,sessionID,role:'user',time:{created:now},agent:previous.info.agent,
      model:options.autoContinue ? structuredClone(previous.info.model)
        : {providerID:previous.info.model.providerID,modelID:previous.info.model.modelID} };
    const compaction = {id:`prt_qa_compaction_${identity}`,sessionID,messageID:userID,type:'compaction',auto:options.autoContinue === true};
    const summary = {...assistantMessage(sessionID,true,now,directory),id:summaryID,parentID:userID,summary:true,time:{created:now+1,completed:now+2},
      agent:previous.info.agent,mode:'compaction',providerID:user.model.providerID,modelID:user.model.modelID};
    const text = {...assistantPart(sessionID,options.summaryText ?? 'Fixture compaction summary: retain the previous real user selection.',true),
      id:`prt_qa_summary_${identity}`,messageID:summaryID,time:{start:now+1,end:now+2}};
    const appended = [{info:user,parts:[compaction]},{info:summary,parts:[text]}];
    let continuationUserID;
    if (options.autoContinue) {
      continuationUserID = messageID(now + 3);
      const continuationAssistantID = messageID(now + 4);
      appended.push({info:{...user,id:continuationUserID,time:{created:now+3},model:structuredClone(user.model)},parts:[{
        id:`prt_qa_continuation_${identity}`,sessionID,messageID:continuationUserID,type:'text',synthetic:true,
        metadata:{compaction_continue:true},text:'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.',
        time:{start:now+3,end:now+3},
      }]},{info:{...assistantMessage(sessionID,true,now+4,directory),id:continuationAssistantID,parentID:continuationUserID,time:{created:now+4,completed:now+5},
        agent:user.agent,providerID:user.model.providerID,modelID:user.model.modelID,variant:user.model.variant},parts:[{
        ...assistantPart(sessionID,'Fixture automatic continuation completed; await the next real user request.',true),
        id:`prt_qa_continuation_response_${identity}`,messageID:continuationAssistantID,time:{start:now+4,end:now+5},
      }]});
    }
    const rows = promptRows.get(sessionID) ?? [];
    rows.push(...appended);
    promptRows.set(sessionID,rows);
    for (const row of appended) {
      sendEvent(directory,{type:'message.updated',properties:{info:row.info}});
      for (const part of row.parts) sendEvent(directory,{type:'message.part.updated',properties:{part}});
    }
    return {userMessageID:userID,summaryMessageID:summaryID,previousUserMessageID:previous.info.id,
      ...(continuationUserID ? {continuationUserMessageID:continuationUserID} : {})};
  };

  const handleRequest = async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    const requestedDirectory = url.searchParams.get('directory')
      ?? url.searchParams.get('location[directory]')
      ?? request.headers['x-opencode-directory'];
    // Bootstrapping another directory must not duplicate the same session IDs
    // into a second sync store and steal their event-routing ownership.
    if (requestedDirectory && requestedDirectory !== directory && ['/session','/permission','/question'].some((prefix) => pathname.startsWith(prefix))) {
      const list = ['/session','/permission','/question'].includes(pathname);
      json(response, list || pathname === '/session/status' ? 200 : 404,
        list ? [] : pathname === '/session/status' ? {} : { error: 'entity not found in directory' });
      return;
    }

    if ((pathname === '/global/event' || pathname === '/event') && request.method === 'GET') {
      sseConnectionCount += 1;
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      response.write(': DevRyan performance fixture\n\n');
      sseClients.add(response);
      sseSubscriptions.set(response,{global:pathname === '/global/event',directory:requestedDirectory});
      sendEvent('global', { type: 'server.connected', properties: {} });
      request.on('close', () => sseClients.delete(response));
      return;
    }

    if (pathname === '/global/health' || pathname === '/health') {
      json(response, 200, { healthy: true, version: 'perf-fixture' });
      return;
    }
    if (pathname === '/path') {
      json(response, 200, {
        home: directory,
        state: directory,
        config: directory,
        worktree: directory,
        directory,
      });
      return;
    }
    if (pathname === '/global/config' || pathname === '/config') {
      json(response, 200, { model: 'fixture/fixture-model' });
      return;
    }
    if (pathname === '/project' || pathname === '/project/current') {
      const project = { id: 'project_perf', worktree: directory, vcs: 'git' };
      json(response, 200, pathname === '/project' ? [project] : project);
      return;
    }
    if (pathname === '/provider' || pathname === '/config/providers') {
      json(response, 200, {
        [pathname === '/config/providers' ? 'providers' : 'all']: [{
          id: 'fixture',
          name: 'Fixture',
          models: thinkingModels ?? {
            'fixture-model': {
              id: 'fixture-model',
              name: 'Fixture model',
              limit: { context: 100_000, output: 10_000 },
              reasoning: true,
              variants: { low: { reasoningEffort:'low' }, high: { reasoningEffort:'high' } },
            },
          },
        }],
        connected: ['fixture'],
        default: { fixture: 'fixture-model' },
      });
      return;
    }
    if (pathname === '/session/status') {
      statusRequestCount += 1;
      json(response, 200, statuses);
      return;
    }
    if (pathname === '/session' || (pathname === '/experimental/session' && request.method === 'GET')) {
      if (request.method === 'POST') {
        const input = await readInput(request,response,{empty:true});
        if (!input) return;
        if (input.parentID !== undefined && !sessionByID.has(input.parentID)) { json(response,404,{error:'parent session not found'}); return; }
        const id = `ses_qa${++nextPrompt}`;
        const session = createSession(id, directory, input.parentID);
        session.title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : `QA session ${nextPrompt}`;
        sessions.push(session);
        sessionByID.set(id, session);
        if (nextCreatedSessionPrompt) {
          promptBehaviors.set(id, nextCreatedSessionPrompt);
          nextCreatedSessionPrompt = null;
        }
        statuses[id] = { type: 'idle' };
        sendEvent(directory, { type: 'session.created', properties: { info: session } });
        json(response, 200, session);
        return;
      }
      if (request.method !== 'GET') { json(response,405,{error:'method not allowed'}); return; }
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : sessions.length;
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10_000) { json(response,400,{error:'invalid session limit'}); return; }
      let listed = sessions;
      if (url.searchParams.get('roots') === 'true') listed = listed.filter((session) => !session.parentID);
      if (url.searchParams.has('archived')) listed = listed.filter((session) => Boolean(session.time.archived) === (url.searchParams.get('archived') === 'true'));
      if (url.searchParams.has('search')) listed = listed.filter((session) => session.title.toLowerCase().includes(url.searchParams.get('search').toLowerCase()));
      json(response, 200, listed.slice(0,limit));
      return;
    }

    const promptMatch = /^\/session\/([^/]+)\/prompt_async$/.exec(pathname);
    if (promptMatch && request.method === 'POST') {
      const sessionID = decodeURIComponent(promptMatch[1]);
      if (!sessionByID.has(sessionID)) { json(response, 404, { error: 'session not found' }); return; }
      const input = await readInput(request,response);
      if (!input) return;
      if (!Array.isArray(input.parts) || input.parts.length > 100 || input.parts.some((part) => !part || typeof part.type !== 'string')) { json(response, 400, { error: 'parts required' }); return; }
      if (promptTimers.has(sessionID)) { json(response, 409, { error: 'session busy' }); return; }
      const behavior = promptBehaviors.get(sessionID) ?? {reasoning:'none',tool:'none',hold:false,chunks:20,intervalMs:100};
      promptBehaviors.delete(sessionID);
      if (behavior.rejectStatus !== undefined) {
        rejectedPrompts.push({sessionID,messageID:input.messageID ?? null,status:behavior.rejectStatus});
        json(response,behavior.rejectStatus,{error:'Configured QA prompt rejection'}); return;
      }
      if (input.messageID && getCanonicalMessages(sessionID).some((row) => row.info.id === input.messageID)) {
        rejectedPrompts.push({sessionID,messageID:input.messageID,status:409});
        json(response,409,{error:'Duplicate QA message ID'}); return;
      }
      const now = Date.now();
      const userID = input.messageID || `msg_qa_user_${++nextPrompt}`;
      const assistantID = `msg_qa_assistant_${++nextPrompt}`;
      const user = { ...userMessage(sessionID), id: userID, time: { created: now },
        model:{...(input.model ?? {providerID:'fixture',modelID:'fixture-model'}),...(Object.hasOwn(input,'variant') ? {variant:input.variant} : {})},
        agent: input.agent ?? 'build' };
      const userParts = input.parts.map((part, index) => ({ ...part, id: `prt_qa_${nextPrompt}_${index}`, sessionID, messageID: userID }));
      const assistant = { ...assistantMessage(sessionID, false, now, directory), id: assistantID, parentID: userID,
        agent:user.agent,mode:user.agent,providerID:user.model.providerID,modelID:user.model.modelID };
      const text = { ...assistantPart(sessionID, '', false), id: `prt_qa_answer_${nextPrompt}`, messageID: assistantID };
      const parts = [];
      const reasoning = behavior.reasoning !== 'none' ? {id:`prt_qa_reasoning_${nextPrompt}`,sessionID,messageID:assistantID,type:'reasoning',
        text:behavior.reasoning === 'text' ? behavior.reasoningText : '',time:{start:now}} : null;
      const tool = behavior.tool !== 'none' ? {id:`prt_qa_tool_${nextPrompt}`,sessionID,messageID:assistantID,type:'tool',callID:`call_qa${nextPrompt}`,tool:'bash',
        state:{status:'running',input:{command:'npm test'},title:'Run fixture tests',time:{start:now}}} : null;
      if (reasoning) parts.push(reasoning);
      if (tool) parts.push(tool);
      parts.push(text);
      const rows = promptRows.get(sessionID) ?? [];
      rows.push({ info: user, parts: userParts }, { info: assistant, parts });
      promptRows.set(sessionID, rows);
      receivedPrompts.push({ sessionID, messageID: userID, partTypes: userParts.map((part) => part.type), model:structuredClone(user.model),agent:user.agent,
        ...(Object.hasOwn(input,'variant') ? {variant:input.variant} : {}),
        ...(Object.hasOwn(input,'planMode') ? {planMode:input.planMode} : {}),
        ...(input.tools && typeof input.tools === 'object' ? {tools:structuredClone(input.tools)} : {}) });
      const publishCanonicalUser = () => {
        sendEvent(directory, { type: 'message.updated', properties: { info: user } });
        for (const part of userParts) sendEvent(directory, { type: 'message.part.updated', properties: { part } });
      };
      if (behavior.canonicalUserDelayMs > 0) {
        const observation = { sessionID, messageID: userID, assistantMessageID: assistantID, receivedAt: now,
          delayMs: behavior.canonicalUserDelayMs, releaseDueAt: now + behavior.canonicalUserDelayMs, releasedAt: null,
          model: structuredClone(user.model), agent: user.agent };
        canonicalUserDelays.push(observation);
        const timer = setTimeout(() => {
          delayedCanonicalUsers.delete(userID);
          observation.releasedAt = Date.now();
          publishCanonicalUser();
        }, behavior.canonicalUserDelayMs);
        delayedCanonicalUsers.set(userID, { timer, observation });
      } else publishCanonicalUser();
      sendEvent(directory, { type: 'message.updated', properties: { info: assistant } });
      for (const part of parts) sendEvent(directory, { type: 'message.part.updated', properties: { part } });
      emitStatus(sessionID, { type: 'busy' });
      let chunks = 0;
      const settle = ({aborted = false} = {}) => {
        clearInterval(promptTimers.get(sessionID)?.timer);
        promptTimers.delete(sessionID);
        assistant.finish = 'stop';
        assistant.time.completed = Date.now();
        text.time.end = Date.now();
        if (reasoning) reasoning.time.end = Date.now();
        if (tool) tool.state = aborted || behavior.tool === 'error'
          ? {status:'error',input:tool.state.input,error:aborted ? 'Tool cancelled' : 'Fixture test failure',time:{start:now,end:Date.now()}}
          : {status:'completed',input:tool.state.input,output:'Fixture tests passed.\n',title:'Run fixture tests',metadata:{exit:0},time:{start:now,end:Date.now()}};
        for (const part of parts) sendEvent(directory, { type: 'message.part.updated', properties: { part } });
        sendEvent(directory, { type: 'message.updated', properties: { info: assistant } });
        emitStatus(sessionID, { type: 'idle' });
      };
      const timer = setInterval(() => {
        if (behavior.hold || [...permissions.values(),...questions.values()].some((item) => item.sessionID === sessionID)) return;
        if (reasoning && behavior.reasoning === 'delayed' && !reasoning.text && chunks >= behavior.reasoningDelayChunks) {
          reasoning.text = behavior.reasoningText;
          sendEvent(directory,{type:'message.part.updated',properties:{part:reasoning}});
        }
        const delta = behavior.responseText === undefined ? `QA response chunk ${chunks + 1}. ` : chunks === 0 ? behavior.responseText : '';
        text.text += delta;
        sendEvent(directory, { type: 'message.part.delta', properties: { sessionID, messageID: assistantID, partID: text.id, field: 'text', delta } });
        sendEvent(directory, { type: 'message.part.updated', properties: { part: text } });
        if (++chunks === behavior.chunks) settle();
      }, behavior.intervalMs);
      promptTimers.set(sessionID, { timer, settle, behavior });
      response.writeHead(204); response.end();
      return;
    }
    const abortMatch = /^\/session\/([^/]+)\/abort$/.exec(pathname);
    if (abortMatch && request.method === 'POST') {
      const sessionID = decodeURIComponent(abortMatch[1]);
      if (!sessionByID.has(sessionID)) {json(response,404,{error:'session not found'});return;}
      if (promptTimers.has(sessionID)) abortedPrompts += 1;
      promptTimers.get(sessionID)?.settle({aborted:true});
      for (const [id,item] of permissions) if (item.sessionID === sessionID) {
        permissions.delete(id); sendEvent(directory,{type:'permission.replied',properties:{sessionID,requestID:id,reply:'reject'}});
      }
      for (const [id,item] of questions) if (item.sessionID === sessionID) {
        questions.delete(id); sendEvent(directory,{type:'question.rejected',properties:{sessionID,requestID:id}});
      }
      emitStatus(sessionID, { type: 'idle' });
      json(response, 200, true);
      return;
    }

    const childrenMatch = /^\/session\/([^/]+)\/children$/.exec(pathname);
    if (childrenMatch && request.method === 'GET') {
      const sessionID = decodeURIComponent(childrenMatch[1]);
      if (!sessionByID.has(sessionID)) {json(response,404,{error:'session not found'});return;}
      json(response, 200, sessions.filter((session) => session.parentID === sessionID));
      return;
    }

    const messagesMatch = /^\/session\/([^/]+)\/message$/.exec(pathname);
    if (messagesMatch && request.method === 'GET') {
      const sessionID = decodeURIComponent(messagesMatch[1]);
      if (!sessionByID.has(sessionID)) {json(response,404,{error:'session not found'});return;}
      messageRequestCounts.set(sessionID, (messageRequestCounts.get(sessionID) ?? 0) + 1);
      const all = getMessages(sessionID);
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : all.length;
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10_000) {json(response,400,{error:'invalid message limit'});return;}
      const before = url.searchParams.get('before');
      const end = before ? all.findIndex((row) => row.info.id === before) : all.length;
      if (end < 0) {json(response,400,{error:'invalid message cursor'});return;}
      const start = Math.max(0,end-limit);
      const page = all.slice(start,end);
      if (before) olderMessageRequestCounts.set(sessionID, (olderMessageRequestCounts.get(sessionID) ?? 0) + 1);
      if (messagePageRequests.length < 200) messagePageRequests.push({sessionID,limit,before,returned:page.length,firstMessageID:page[0]?.info.id ?? null,lastMessageID:page.at(-1)?.info.id ?? null});
      if (start > 0 && page.length) response.setHeader('x-next-cursor',page[0].info.id);
      json(response, 200, page);
      return;
    }

    const messageMatch = /^\/session\/([^/]+)\/message\/([^/]+)$/.exec(pathname);
    if (messageMatch && request.method === 'GET') {
      const sessionID = decodeURIComponent(messageMatch[1]);
      const row = sessionByID.has(sessionID) ? getMessages(sessionID).find((item) => item.info.id === decodeURIComponent(messageMatch[2])) : undefined;
      json(response,row ? 200 : 404,row ?? {error:'message not found'}); return;
    }

    const sessionMatch = /^\/session\/([^/]+)$/.exec(pathname);
    if (sessionMatch) {
      const sessionID = decodeURIComponent(sessionMatch[1]);
      const value = sessionByID.get(sessionID);
      if (value && request.method === 'PATCH') {
        const input = await readInput(request,response);
        if (!input) return;
        if (typeof input.title === 'string') value.title=input.title;
        if (input.time && Object.hasOwn(input.time,'archived')) value.time.archived=input.time.archived;
        value.time.updated=Date.now(); sendEvent(directory,{type:'session.updated',properties:{info:value}});
      } else if (value && request.method === 'DELETE') {
        promptTimers.get(sessionID)?.settle({aborted:true});
        sessions.splice(sessions.indexOf(value),1); sessionByID.delete(sessionID);delete statuses[sessionID];
        promptRows.delete(sessionID);historyRows.delete(sessionID);promptBehaviors.delete(sessionID);todos.delete(sessionID);
        texts.delete(sessionID);terminals.delete(sessionID);chunkIndexes.delete(sessionID);streamStarts.delete(sessionID);
        for (const [id,item] of permissions) if(item.sessionID===sessionID) permissions.delete(id);
        for (const [id,item] of questions) if(item.sessionID===sessionID) questions.delete(id);
        sendEvent(directory,{type:'session.deleted',properties:{info:value}}); json(response,200,true);return;
      } else if (value && request.method !== 'GET') {json(response,405,{error:'method not allowed'});return;}
      json(response, value ? 200 : 404, value ?? { error: 'session not found' });
      return;
    }

    const todoMatch = /^\/session\/([^/]+)\/(todo|diff)$/.exec(pathname);
    if (todoMatch && request.method === 'GET') {
      const sessionID = decodeURIComponent(todoMatch[1]);
      if (!sessionByID.has(sessionID)) {json(response,404,{error:'session not found'});return;}
      json(response, 200, todoMatch[2] === 'todo' ? todos.get(sessionID) ?? [] : []);
      return;
    }
    if (pathname === '/agent' && request.method === 'GET') {
      json(response, 200, ['build','builder','orchestrator'].map((name) => ({ name, description: name === 'orchestrator' ? 'QA Orchestrator' : 'QA Builder', mode: 'primary', native: true,
        hidden: name === 'builder', model: { providerID: 'fixture', modelID: 'fixture-model' },
        ...(agentVariant !== undefined ? {variant:agentVariant} : {}) })));
      return;
    }
    if (pathname === '/question' && request.method === 'GET') {json(response,200,[...questions.values()]);return;}
    if (pathname === '/permission' && request.method === 'GET') {json(response,200,[...permissions.values()]);return;}
    const permissionReply = /^\/permission\/([^/]+)\/reply$/.exec(pathname);
    if (permissionReply && request.method === 'POST') {
      const id = decodeURIComponent(permissionReply[1]); const pending = permissions.get(id);
      if (!pending) {json(response,404,{error:'permission not found'});return;}
      const input = await readInput(request,response); if (!input) return;
      if (!['once','always','reject'].includes(input.reply)) {json(response,400,{error:'invalid permission reply'});return;}
      permissions.delete(id);
      const reply = {sessionID:pending.sessionID,requestID:id,reply:input.reply};
      replies.push({type:'permission',...reply}); sendEvent(directory,{type:'permission.replied',properties:reply});
      if (input.reply === 'reject') promptTimers.get(pending.sessionID)?.settle({aborted:true});
      json(response,200,true);return;
    }
    const questionReply = /^\/question\/([^/]+)\/(reply|reject)$/.exec(pathname);
    if (questionReply && request.method === 'POST') {
      const id = decodeURIComponent(questionReply[1]);const pending = questions.get(id);
      if (!pending) {json(response,404,{error:'question not found'});return;}
      let answers;
      if (questionReply[2] === 'reply') {
        const input = await readInput(request,response);if (!input) return;
        answers=input.answers;
        if (!Array.isArray(answers) || answers.length !== pending.questions.length || answers.some((answer) => !Array.isArray(answer) || answer.some((text) => typeof text !== 'string'))) {
          json(response,400,{error:'invalid question answers'});return;
        }
      }
      questions.delete(id);
      const reply = {sessionID:pending.sessionID,requestID:id,...(answers ? {answers} : {})};
      replies.push({type:'question',...reply});sendEvent(directory,{type:answers ? 'question.replied' : 'question.rejected',properties:reply});
      if (!answers) promptTimers.get(pending.sessionID)?.settle({aborted:true});
      json(response,200,true);return;
    }
    if (request.method === 'GET' && ['/command','/lsp','/skill','/file/status'].includes(pathname)) {
      json(response, 200, []);
      return;
    }
    if (request.method === 'GET' && ['/mcp','/provider/auth','/formatter'].includes(pathname)) {
      json(response, 200, {});
      return;
    }
    if (pathname === '/tool/ids' && request.method === 'GET') {json(response,200,['bash','read','edit','write','question']);return;}
    if (pathname === '/vcs') {
      json(response, 200, { branch: 'perf-fixture' });
      return;
    }

    // Unknown capabilities are missing evidence, not empty successful fixtures.
    if (unknownRoutes.length < 100) unknownRoutes.push({method:request.method,path:pathname});
    json(response, 404, {error:'Unsupported fixture route',method:request.method,path:pathname});
  };
  const server = http.createServer((request,response) => {
    void handleRequest(request,response).catch(() => {
      if (!response.headersSent) json(response,400,{error:'Invalid fixture request'});
      else response.destroy();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Loopback OpenCode fixture did not bind a TCP port');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    startScenario,
    stopScenario,
    seedHistory,
    // Bounded canonical replay for recovery UI acceptance; never invokes a provider.
    replayRecoveryVisual: ({ sessionID, rows, taskEvents = [], status = 'idle', agent = null }) => {
      requireSession(sessionID);
      if (promptTimers.has(sessionID) || !Array.isArray(rows) || rows.length > 32
        || !['idle', 'busy'].includes(status)
        || (agent !== null && !['explorer', 'designer'].includes(agent))
        || rows.some(row => row.info?.sessionID !== sessionID || !['user', 'assistant'].includes(row.info.role)
          || !Array.isArray(row.parts) || row.parts.some(part => part.sessionID !== sessionID || part.messageID !== row.info.id))) {
        throw new Error('Invalid recovery visual replay');
      }
      for (const { task, resultEnvelope = null } of taskEvents) {
        validateManagedTaskRecord(task);
        if (task.rootSessionId !== sessionID || task.directory !== directory) throw new Error('Recovery visual task outside fixture root');
        if (resultEnvelope) assertManagedTaskResultEnvelopeMatchesTask(task, resultEnvelope);
      }
      promptRows.set(sessionID, structuredClone(rows));
      for (const row of rows) {
        sendEvent(directory, { type: 'message.updated', properties: { info: row.info } });
        for (const part of row.parts) sendEvent(directory, { type: 'message.part.updated', properties: { part } });
      }
      for (const { task, resultEnvelope = null } of taskEvents) sendEvent(directory, toManagedTaskEvent(task, resultEnvelope));
      if (agent) {
        const session = sessionByID.get(sessionID);
        session.agent = agent;
        sendEvent(directory, { type: 'session.updated', properties: { info: session } });
      }
      emitStatus(sessionID, { type: status });
    },
    appendCompactionBoundary,
    configureNextPrompt,
    configureNextCreatedSessionPrompt: (options) => {
      if (nextCreatedSessionPrompt) throw new Error('A next-created-session fixture prompt is already configured');
      nextCreatedSessionPrompt = validatePromptOptions(options);
    },
    setPromptReasoning: (sessionID, text) => {
      requireSession(sessionID);
      if (typeof text !== 'string' || text.length > 16_384) throw new Error('Invalid fixture reasoning text');
      const part = promptRows.get(sessionID)?.at(-1)?.parts.find((item) => item.type === 'reasoning');
      if (!promptTimers.has(sessionID) || !part) throw new Error('No active fixture reasoning part');
      part.text = text;
      sendEvent(directory,{type:'message.part.updated',properties:{part}});
    },
    releasePrompt: (sessionID) => {requireSession(sessionID);const active=promptTimers.get(sessionID);if(!active) throw new Error('No active fixture prompt');active.behavior.hold=false;},
    askPermission,
    askQuestion,
    setTodos,
    appendManagedTaskVisual: ({ sessionID, messageID, task, resultEnvelope = null }) => {
      requireSession(sessionID);
      validateManagedTaskRecord(task);
      if (resultEnvelope) assertManagedTaskResultEnvelopeMatchesTask(task, resultEnvelope);
      const row = getMessages(sessionID).find(item => item.info.id === messageID && item.info.role === 'assistant');
      const child = sessionByID.get(task.childSessionId);
      const childMessages = child ? getMessages(child.id) : [];
      const childAssistant = childMessages.at(-1);
      if (!row || task.rootSessionId !== sessionID || task.directory !== directory || child?.parentID !== sessionID
        || !task.dispatchCallId || !['running', 'completed'].includes(task.status)
        || (task.status === 'completed') !== Boolean(resultEnvelope)
        || childAssistant?.info.role !== 'assistant'
        || !childMessages.some(item => item.info.role === 'user' && item.info.id === childAssistant.info.parentID)
        || !task.canonicalRefs.some(reference => reference.type === 'session' && reference.id === child.id)
        || !task.canonicalRefs.some(reference => reference.type === 'message' && reference.id === childAssistant.info.id)
        || (task.status === 'running' && (statuses[child.id]?.type !== 'busy' || childAssistant.info.time?.completed))
        || (task.status === 'completed' && (statuses[child.id]?.type !== 'idle' || !childAssistant.info.time?.completed))
        || row.parts.some(part => part.type === 'tool' && part.callID === task.dispatchCallId)) {
        throw new Error('Managed task visual must correlate with an owned canonical root, assistant, child and unique dispatch');
      }
      const event = toManagedTaskEvent(task, resultEnvelope);
      const part = { id: `prt_qa_visual_${task.taskId}`, type: 'tool', sessionID, messageID,
        tool: 'devryan_task', callID: task.dispatchCallId,
        state: { status: 'completed', input: { action: 'start', agent: task.agent, label: task.label },
          output: JSON.stringify({ task: event.properties.task }), title: task.label, metadata: {},
          time: { start: task.createdAt, end: task.startedAt ?? task.createdAt } } };
      row.parts.push(part);
      sendEvent(directory, { type: 'message.part.updated', properties: { part } });
      sendEvent(directory, event);
      return structuredClone({ part, event });
    },
    removeManagedTaskVisual: task => {
      requireSession(task.rootSessionId);
      if (task.directory !== directory) throw new Error('Managed task visual removal must stay in the fixture directory');
      sendEvent(directory, toManagedTaskRemovalEvent(task));
    },
    suppressMessageEvents: ({ sessionID, messageID, types, maximumEvents = 64, durationMs = 30_000 }) => {
      requireSession(sessionID);
      const row = getMessages(sessionID).find(item => item.info.id === messageID && item.info.role === 'assistant');
      const allowed = ['message.updated', 'message.part.updated', 'message.part.delta', 'session.status'];
      if (!row || row.info.time?.completed || !promptTimers.has(sessionID) || eventSuppression
        || !Array.isArray(types) || !types.length || new Set(types).size !== types.length
        || types.some(type => !allowed.includes(type)) || !Number.isSafeInteger(maximumEvents) || maximumEvents < 1 || maximumEvents > 128
        || !Number.isSafeInteger(durationMs) || durationMs < 100 || durationMs > 30_000 || suppressionRuns.length >= 8) {
        throw new Error('Invalid or overlapping bounded fixture event suppression');
      }
      eventSuppression = { sessionID, messageID, types: [...types], maximumEvents, durationMs, startedAt: Date.now(),
        expiresAt: Date.now() + durationMs, suppressedCount: 0, endedReason: null };
      suppressionRuns.push(eventSuppression);
    },
    clearMessageEventSuppression: () => {
      if (eventSuppression) eventSuppression.endedReason = 'explicit-clear';
      eventSuppression = null;
    },
    getState: () => ({
      activeScenario,
      sseClientCount: sseClients.size,
      sseConnectionCount,
      statusRequestCount,
      suppressedEvents: structuredClone(suppressedEvents),
      suppressionRuns: structuredClone(suppressionRuns),
      messageRequestCounts: Object.fromEntries(messageRequestCounts),
      olderMessageRequestCounts: Object.fromEntries(olderMessageRequestCounts),
      messagePageRequests: structuredClone(messagePageRequests),
      textLengths: Object.fromEntries([...texts].map(([id, text]) => [id, text.length])),
      receivedPrompts:structuredClone(receivedPrompts),
      canonicalUserDelays:structuredClone(canonicalUserDelays),
      rejectedPrompts:structuredClone(rejectedPrompts),
      replies:structuredClone(replies),
      unknownRoutes:structuredClone(unknownRoutes),
      permissionCount:permissions.size,
      questionCount:questions.size,
      abortedPrompts,
      activePrompts: promptTimers.size,
    }),
    disconnectEvents: () => { for (const client of sseClients) client.end(); },
    close: async () => {
      stopScenario({ settle: false });
      for (const { timer } of promptTimers.values()) clearInterval(timer);
      promptTimers.clear();
      for (const { timer } of delayedCanonicalUsers.values()) clearTimeout(timer);
      delayedCanonicalUsers.clear();
      for (const client of sseClients) client.end();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
};
