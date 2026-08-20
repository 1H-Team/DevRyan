import http from 'node:http';

export const PERF_PARENT_SESSION_ID = 'ses_perf_parent';
export const PERF_CHILD_SESSION_IDS = [
  'ses_perf_child_1',
  'ses_perf_child_2',
  'ses_perf_child_3',
];

const ALL_SESSION_IDS = [PERF_PARENT_SESSION_ID, ...PERF_CHILD_SESSION_IDS];
const FIXED_CREATED_AT = 1_700_000_000_000;

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

const assistantMessage = (sessionID, terminal) => ({
  id: `msg_assistant_${sessionID}`,
  sessionID,
  parentID: `msg_user_${sessionID}`,
  role: 'assistant',
  time: {
    created: FIXED_CREATED_AT + 20,
    ...(terminal ? { completed: FIXED_CREATED_AT + 30 } : {}),
  },
  agent: 'build',
  providerID: 'fixture',
  modelID: 'fixture-model',
  mode: 'build',
  path: { cwd: '.', root: '.' },
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

export const createLoopbackOpenCodeFixture = async ({ directory }) => {
  const sessions = ALL_SESSION_IDS.map((id) => (
    createSession(id, directory, id === PERF_PARENT_SESSION_ID ? undefined : PERF_PARENT_SESSION_ID)
  ));
  const sessionByID = new Map(sessions.map((session) => [session.id, session]));
  const statuses = Object.fromEntries(ALL_SESSION_IDS.map((id) => [id, { type: 'idle' }]));
  const texts = new Map(ALL_SESSION_IDS.map((id) => [id, '']));
  const terminals = new Set();
  const chunkIndexes = new Map(ALL_SESSION_IDS.map((id) => [id, 0]));
  const sseClients = new Set();
  const messageRequestCounts = new Map();
  let eventID = 0;
  let streamTimer = null;
  let activeScenario = 'idle';

  const sendEvent = (directoryHint, payload) => {
    eventID += 1;
    const frame = `id: ${eventID}\ndata: ${JSON.stringify({ directory: directoryHint, payload })}\n\n`;
    for (const client of sseClients) {
      client.write(frame);
    }
  };

  const emitStatus = (sessionID, status) => {
    statuses[sessionID] = status;
    sendEvent(directory, {
      type: 'session.status',
      properties: { sessionID, status },
    });
  };

  const resetStream = (sessionID) => {
    texts.set(sessionID, '');
    terminals.delete(sessionID);
    chunkIndexes.set(sessionID, 0);
    sendEvent(directory, {
      type: 'message.updated',
      properties: { info: assistantMessage(sessionID, false) },
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
          properties: { info: assistantMessage(sessionID, true) },
        });
        emitStatus(sessionID, { type: 'idle' });
      }
    }
    activeScenario = 'idle';
  };

  const startScenario = (scenario) => {
    stopScenario({ settle: false });
    activeScenario = scenario;
    const activeSessionIDs = scenario === 'four-stream'
      ? ALL_SESSION_IDS
      : scenario === 'one-stream'
        ? [PERF_PARENT_SESSION_ID]
        : [];

    for (const sessionID of ALL_SESSION_IDS) {
      statuses[sessionID] = { type: 'idle' };
    }
    for (const sessionID of activeSessionIDs) {
      resetStream(sessionID);
      emitStatus(sessionID, { type: 'busy' });
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
      }
    }, 16);
  };

  const getMessages = (sessionID) => {
    const terminal = terminals.has(sessionID);
    return [
      { info: userMessage(sessionID), parts: [userPart(sessionID)] },
      {
        info: assistantMessage(sessionID, terminal),
        parts: [assistantPart(sessionID, texts.get(sessionID) ?? '', terminal)],
      },
    ];
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    if (pathname === '/global/event') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      response.write(': DevRyan performance fixture\n\n');
      sseClients.add(response);
      sendEvent('global', { type: 'server.connected', properties: {} });
      request.on('close', () => sseClients.delete(response));
      return;
    }

    if (pathname === '/global/health') {
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
        all: [{
          id: 'fixture',
          name: 'Fixture',
          models: {
            'fixture-model': {
              id: 'fixture-model',
              name: 'Fixture model',
              limit: { context: 100_000, output: 10_000 },
            },
          },
        }],
        connected: ['fixture'],
        default: { fixture: 'fixture-model' },
      });
      return;
    }
    if (pathname === '/session/status') {
      json(response, 200, statuses);
      return;
    }
    if (pathname === '/session') {
      json(response, 200, sessions);
      return;
    }

    const childrenMatch = /^\/session\/([^/]+)\/children$/.exec(pathname);
    if (childrenMatch) {
      const sessionID = decodeURIComponent(childrenMatch[1]);
      json(response, 200, sessions.filter((session) => session.parentID === sessionID));
      return;
    }

    const messagesMatch = /^\/session\/([^/]+)\/message$/.exec(pathname);
    if (messagesMatch && request.method === 'GET') {
      const sessionID = decodeURIComponent(messagesMatch[1]);
      messageRequestCounts.set(sessionID, (messageRequestCounts.get(sessionID) ?? 0) + 1);
      json(response, 200, getMessages(sessionID));
      return;
    }

    const sessionMatch = /^\/session\/([^/]+)$/.exec(pathname);
    if (sessionMatch) {
      const sessionID = decodeURIComponent(sessionMatch[1]);
      const value = sessionByID.get(sessionID);
      json(response, value ? 200 : 404, value ?? { error: 'session not found' });
      return;
    }

    if (/^\/session\/[^/]+\/(todo|diff)$/.test(pathname)) {
      json(response, 200, []);
      return;
    }
    if (pathname === '/agent' || pathname === '/command' || pathname === '/question' || pathname === '/permission' || pathname === '/lsp') {
      json(response, 200, []);
      return;
    }
    if (pathname === '/mcp') {
      json(response, 200, {});
      return;
    }
    if (pathname === '/vcs') {
      json(response, 200, { branch: 'perf-fixture' });
      return;
    }

    json(response, 200, {});
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
    getState: () => ({
      activeScenario,
      sseClientCount: sseClients.size,
      messageRequestCounts: Object.fromEntries(messageRequestCounts),
      textLengths: Object.fromEntries([...texts].map(([id, text]) => [id, text.length])),
    }),
    close: async () => {
      stopScenario({ settle: false });
      for (const client of sseClients) client.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
};
