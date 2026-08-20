import { createInterface } from 'node:readline';
import process from 'node:process';
import {
  normalizeCursorSdkAgentDefinitions,
  pinCursorSdkSubagentModels,
} from './agent-definitions.js';
import { configureCursorSdkRipgrep } from './ripgrep-path.js';
import {
  generateCursorSessionTitle,
} from './title-generation.js';
import { createAgentCache } from './agent-cache.js';
import { normalizeInteractionUpdateToSdkMessage } from './interaction-update-normalize.js';
import { assertCursorSdkNodeCompatibility } from './node-version.js';

const trimString = (value) => (typeof value === 'string' ? value.trim() : '');

const isPlainObject = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const parseSettingSourcesFlag = (raw) => {
  const v = trimString(raw);
  if (!v) return undefined;
  if (v.toLowerCase() === 'none') return [];
  const allowed = new Set(['project', 'user', 'team', 'mdm', 'plugins', 'all']);
  const parsed = v.split(',').map((s) => s.trim()).filter((s) => allowed.has(s));
  return parsed.length ? parsed : undefined;
};

// DevRyan cursor context trim (default OFF). Set OPENCHAMBER_CURSOR_SETTING_SOURCES to a
// comma list of cursor setting layers (project,user,team,mdm,plugins,all) or "none" to
// load none, trimming ambient rules/settings context sent to the cursor-agent runtime.
const CURSOR_SETTING_SOURCES = parseSettingSourcesFlag(process.env.OPENCHAMBER_CURSOR_SETTING_SOURCES);

// Upper bound on how long we wait for an SDK run cancel to settle before we
// force the request to finish. Prevents a hung cancel from leaving the host
// stream stuck mid-tool (a cause of the "stop then switch models" freeze).
const CANCEL_TIMEOUT_MS = 4000;
const AGENT_CACHE_MAX_ENTRIES = 16;
const AGENT_CACHE_IDLE_TTL_MS = 30 * 60 * 1000;

const withTimeout = (promise, timeoutMs) => {
  if (!promise || !timeoutMs) return Promise.resolve(promise);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(null); }
    }, timeoutMs);
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } },
    );
  });
};

const sdkStatusFromRunStatus = (status) => {
  if (status === 'finished') return 'FINISHED';
  if (status === 'error') return 'ERROR';
  if (status === 'cancelled') return 'CANCELLED';
  return 'RUNNING';
};

const finalStatusFromSdkStatus = (status) => {
  const normalized = trimString(status).toUpperCase();
  if (normalized === 'FINISHED' || normalized === 'FINISH' || normalized === 'SUCCESS' || normalized === 'STOP' || normalized === 'COMPLETED') return 'success';
  if (normalized === 'ERROR' || normalized === 'FAILED' || normalized === 'FAILURE') return 'error';
  if (normalized === 'CANCELLED' || normalized === 'CANCELED' || normalized === 'EXPIRED') return 'cancelled';
  return null;
};

const getSdkMessageTextFingerprint = (message) => {
  if (!isPlainObject(message)) return '';
  if (message.type === 'assistant') {
    const content = Array.isArray(message.message?.content) ? message.message.content : [];
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
    return text ? `assistant:${text}` : '';
  }
  if (message.type === 'thinking') {
    const text = typeof message.text === 'string' ? message.text : '';
    return text ? `thinking:${text}` : '';
  }
  return '';
};

const createCrossSourceMessageDedupe = (limit = 80) => {
  const recent = [];
  return (source, message) => {
    const fingerprint = getSdkMessageTextFingerprint(message);
    if (!fingerprint) return false;
    const duplicate = recent.some((entry) => (
      entry.fingerprint === fingerprint && entry.source !== source
    ));
    recent.push({ source, fingerprint });
    if (recent.length > limit) {
      recent.splice(0, recent.length - limit);
    }
    return duplicate;
  };
};

const normalizeModelSelectionParams = (params) => {
  if (!Array.isArray(params)) return [];
  const normalized = [];
  for (const param of params) {
    if (!isPlainObject(param)) continue;
    const id = trimString(param.id);
    const value = trimString(param.value);
    if (!id || !value) continue;
    normalized.push({ id, value });
  }
  return normalized;
};

const normalizeModelSelection = (selection, fallbackModelID) => {
  if (!isPlainObject(selection)) {
    return { id: trimString(fallbackModelID) || 'auto' };
  }
  const id = trimString(selection.id) || trimString(fallbackModelID) || 'auto';
  const params = normalizeModelSelectionParams(selection.params);
  return {
    id,
    ...(params.length > 0 ? { params } : {}),
  };
};

const sortObjectKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortObjectKeys(entry)])
  );
};

const stableJson = (value) => {
  try {
    return JSON.stringify(sortObjectKeys(value));
  } catch {
    return JSON.stringify(value);
  }
};

const isMissingCursorAgentError = (error) => /Agent .* not found/i.test(error instanceof Error ? error.message : String(error || ''));

const writeEvent = (event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const writeRequestEvent = (requestID, event) => {
  writeEvent({ requestID, ...event });
};

const agentCache = createAgentCache({
  maxEntries: AGENT_CACHE_MAX_ENTRIES,
  idleTtlMs: AGENT_CACHE_IDLE_TTL_MS,
  onEvict: (agent) => {
    try {
      agent?.close?.();
    } catch {
      // Provider cleanup failure must not retain the cache entry.
    }
  },
});
const activeRuns = new Map();
assertCursorSdkNodeCompatibility();
const cursorSdk = await import('@cursor/sdk');
configureCursorSdkRipgrep(cursorSdk, { env: process.env });
const { Agent } = cursorSdk;

writeEvent({ type: 'ready' });

const getAgentCacheKey = (sessionID, directory, model, agents, mcpServerIdentity) => `${trimString(sessionID)}\u0000${trimString(directory)}\u0000${stableJson({
  model: normalizeModelSelection(model),
  agents: normalizeCursorSdkAgentDefinitions(agents),
  mcpServerIdentity: trimString(mcpServerIdentity),
  settingSources: CURSOR_SETTING_SOURCES ?? null,
})}`;

const getOrCreateAgent = async ({
  apiKey,
  sessionID,
  model,
  directory,
  agentID,
  agents,
  mcpServers,
  mcpServerIdentity,
  active = false,
}) => {
  const normalizedAgents = pinCursorSdkSubagentModels(normalizeCursorSdkAgentDefinitions(agents), model);
  const normalizedMcpServers = isPlainObject(mcpServers) ? mcpServers : null;
  const key = getAgentCacheKey(sessionID, directory, model, normalizedAgents, mcpServerIdentity);
  const cached = agentCache.get(key);
  if (cached) {
    if (active) agentCache.markActive(key);
    return { agent: cached, cacheHit: true, cacheKey: key };
  }

  const local = {
    ...(directory ? { cwd: directory } : {}),
    ...(CURSOR_SETTING_SOURCES ? { settingSources: CURSOR_SETTING_SOURCES } : {}),
  };
  const agentOptions = {
    apiKey,
    model,
    local,
    ...(directory ? { platform: { workspaceRef: directory } } : {}),
    ...(normalizedAgents ? { agents: normalizedAgents } : {}),
    ...(normalizedMcpServers ? { mcpServers: normalizedMcpServers } : {}),
  };
  let agent = null;
  if (agentID) {
    try {
      agent = await Agent.resume(agentID, agentOptions);
    } catch (error) {
      if (!isMissingCursorAgentError(error)) {
        throw error;
      }
    }
  }
  if (!agent) {
    agent = await Agent.create({
      name: `DevRyan ${trimString(sessionID) || Date.now()}`,
      ...agentOptions,
    });
  }
  agent = agentCache.set(key, agent, { sessionID, active });
  return { agent, cacheHit: false, cacheKey: key };
};

const handlePrepare = async (command) => {
  const requestID = trimString(command.requestID);
  const apiKey = trimString(command.apiKey);
  const modelID = trimString(command.modelID) || 'auto';
  const model = normalizeModelSelection(command.modelSelection, modelID);
  const agents = normalizeCursorSdkAgentDefinitions(command.agents);
  const mcpServers = isPlainObject(command.mcpServers) ? command.mcpServers : null;
  const mcpServerIdentity = trimString(command.mcpServerIdentity);
  const directory = trimString(command.directory);
  const sessionID = trimString(command.sessionID);
  const agentID = trimString(command.agentID);

  if (!requestID) return;
  if (!apiKey) throw new Error('Cursor SDK API key is not configured.');

  const writeTiming = (mark, metadata) => {
    writeRequestEvent(requestID, {
      type: 'timing',
      mark,
      ...(metadata ? { metadata } : {}),
    });
  };

  try {
    writeTiming('cursor_agent_prepare_started');
    const prepared = await getOrCreateAgent({
      apiKey,
      sessionID,
      model,
      directory,
      agentID,
      agents,
      mcpServers,
      mcpServerIdentity,
    });
    writeTiming('cursor_agent_prepared', { cacheHit: prepared.cacheHit === true });
    writeRequestEvent(requestID, {
      type: 'prepared',
      agentID: trimString(prepared.agent?.agentId),
      cacheHit: prepared.cacheHit === true,
    });
  } catch (error) {
    writeRequestEvent(requestID, {
      type: 'error',
      error: error instanceof Error ? error.message : 'Cursor SDK worker prepare failed.',
    });
  }
};

const handleTitle = async (command) => {
  const requestID = trimString(command.requestID);
  const apiKey = trimString(command.apiKey);
  const text = trimString(command.text);
  const directory = trimString(command.directory);

  if (!requestID) return;
  if (!apiKey) throw new Error('Cursor SDK API key is not configured.');
  if (!text) {
    writeRequestEvent(requestID, { type: 'title-result', title: null });
    return;
  }

  try {
    const title = await generateCursorSessionTitle({
      Agent,
      apiKey,
      text,
      directory,
    });
    writeRequestEvent(requestID, {
      type: 'title-result',
      title,
    });
  } catch (error) {
    writeRequestEvent(requestID, {
      type: 'error',
      error: error instanceof Error ? error.message : 'Cursor SDK title generation failed.',
    });
  }
};

const handlePrompt = async (command) => {
  const requestID = trimString(command.requestID);
  const apiKey = trimString(command.apiKey);
  const modelID = trimString(command.modelID) || 'auto';
  const model = normalizeModelSelection(command.modelSelection, modelID);
  const agents = normalizeCursorSdkAgentDefinitions(command.agents);
  const mcpServers = isPlainObject(command.mcpServers) ? command.mcpServers : null;
  const mcpServerIdentity = trimString(command.mcpServerIdentity);
  const prompt = trimString(command.prompt);
  const directory = trimString(command.directory);
  const sessionID = trimString(command.sessionID);
  const agentID = trimString(command.agentID);
  const images = Array.isArray(command.images) ? command.images : [];

  if (!requestID) return;
  if (!apiKey) throw new Error('Cursor SDK API key is not configured.');
  if (!prompt) throw new Error('Cursor prompt is required.');

  const state = {
    run: null,
    cancelRequested: false,
    streamIterator: null,
  };
  let activeAgentCacheKey = '';
  activeRuns.set(requestID, state);

  const shouldSkipDuplicateMessage = createCrossSourceMessageDedupe();
  const writeSdkMessage = (sdkMessage, source = 'stream') => {
    if (shouldSkipDuplicateMessage(source, sdkMessage)) return;
    writeRequestEvent(requestID, { type: 'message', message: sdkMessage });
  };

  const writeTiming = (mark, metadata) => {
    writeRequestEvent(requestID, {
      type: 'timing',
      mark,
      ...(metadata ? { metadata } : {}),
    });
  };

  try {
    writeTiming('cursor_run_create_started');
    const prepared = await getOrCreateAgent({
      apiKey,
      sessionID,
      model,
      directory,
      agentID,
      agents,
      mcpServers,
      mcpServerIdentity,
      active: true,
    });
    activeAgentCacheKey = prepared.cacheKey;
    writeTiming('cursor_run_created', { cacheHit: prepared.cacheHit === true });
    const agent = prepared.agent;
    if (agent?.agentId) {
      writeRequestEvent(requestID, { type: 'agent', agentID: agent.agentId });
    }

    let sawSdkDelta = false;
    const message = images.length > 0 ? { text: prompt, images } : { text: prompt };
    writeTiming('cursor_provider_send_started');
    const run = await agent.send(message, {
      model,
      onDelta: (event) => {
        const sdkMessage = normalizeInteractionUpdateToSdkMessage(event);
        if (!sdkMessage) return;
        if (sdkMessage.type === 'usage') {
          writeRequestEvent(requestID, { type: 'usage', tokens: sdkMessage.tokens });
          return;
        }
        if (!sawSdkDelta) {
          sawSdkDelta = true;
          writeTiming('cursor_first_sdk_delta');
        }
        writeSdkMessage(sdkMessage, 'delta');
      },
    });
    state.run = run;
    writeTiming('cursor_provider_send_accepted');
    if (state.cancelRequested && typeof run.cancel === 'function') {
      await run.cancel();
    }

    let doneEmitted = false;
    const writeDone = (status) => {
      if (doneEmitted) return;
      doneEmitted = true;
      writeSdkMessage({
        type: 'status',
        agent_id: run.agentId,
        run_id: run.id,
        status: sdkStatusFromRunStatus(status),
      });
      writeRequestEvent(requestID, { type: 'done', status });
    };

    const closeStreamIterator = async () => {
      if (state.streamIterator && typeof state.streamIterator.return === 'function') {
        await state.streamIterator.return();
      }
    };

    // Let a cancel force a terminal "done" even if the SDK cancel is slow or
    // never settles, so the host stream is never left hanging mid-tool. writeDone
    // is idempotent, so this is safe alongside the natural completion path.
    state.finishCancelled = () => {
      writeDone('cancelled');
      void closeStreamIterator();
    };

    const waitPromise = run.wait()
      .then((result) => {
        const finalText = trimString(result?.result);
        const finalStatus = finalStatusFromSdkStatus(sdkStatusFromRunStatus(result?.status || run.status));
        writeRequestEvent(requestID, {
          type: 'final-result',
          result: {
            ok: true,
            finalStatus,
            finalText,
          },
        });
        if (finalText) {
          writeSdkMessage({
            type: 'assistant',
            agent_id: run.agentId,
            run_id: run.id,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: finalText }],
            },
          }, 'wait');
        }
        writeDone(result?.status || run.status);
        void closeStreamIterator();
      })
      .catch((error) => {
        writeRequestEvent(requestID, {
          type: 'final-result',
          result: {
            ok: false,
            finalStatus: 'error',
            finalText: '',
            error: error instanceof Error ? error.message : 'Cursor SDK run failed.',
          },
        });
        writeRequestEvent(requestID, {
          type: 'error',
          error: error instanceof Error ? error.message : 'Cursor SDK run failed.',
        });
      });

    let sawStreamEvent = false;
    state.streamIterator = run.stream()[Symbol.asyncIterator]();
    for (;;) {
      const next = await state.streamIterator.next();
      if (next.done) break;
      if (!sawStreamEvent) {
        sawStreamEvent = true;
        writeTiming('cursor_first_stream_event');
      }
      writeSdkMessage(next.value, 'stream');
    }

    await waitPromise;
    writeDone(run.status);
  } catch (error) {
    writeRequestEvent(requestID, {
      type: 'final-result',
      result: {
        ok: false,
        finalStatus: 'error',
        finalText: '',
        error: error instanceof Error ? error.message : 'Cursor SDK worker failed.',
      },
    });
    writeRequestEvent(requestID, {
      type: 'error',
      error: error instanceof Error ? error.message : 'Cursor SDK worker failed.',
    });
  } finally {
    if (activeAgentCacheKey) {
      agentCache.markInactive(activeAgentCacheKey);
    }
    activeRuns.delete(requestID);
  }
};

const cancelRun = async (requestID) => {
  const active = activeRuns.get(requestID);
  if (!active) return;
  active.cancelRequested = true;
  if (active.run && typeof active.run.cancel === 'function') {
    // Bound the SDK cancel so a hung cancel cannot keep the request alive.
    await withTimeout(Promise.resolve(active.run.cancel()), CANCEL_TIMEOUT_MS);
  }
  // Always emit a terminal done so the host never waits forever for a stream
  // that stopped producing events after cancellation.
  active.finishCancelled?.();
};

const shutdown = async () => {
  for (const requestID of [...activeRuns.keys()]) {
    await cancelRun(requestID);
  }
  agentCache.clear();
  process.exit(0);
};

process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});

// Warm the worker's Cursor SDK connection + auth at prewarm time so the first
// real prompt pays only the per-session Agent.create, not the cold backend
// connection/auth/TLS setup (~2.8s observed before first token on a cold
// session). Best-effort: any failure here must never affect prompt handling.
const handleWarm = async (command) => {
  const apiKey = trimString(command?.apiKey);
  if (!apiKey) return;
  try {
    if (typeof cursorSdk.Cursor?.me === 'function') {
      await cursorSdk.Cursor.me({ apiKey });
    }
  } catch {
    // ignore — warm is opportunistic
  }
};

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!trimString(line)) continue;
  let command = null;
  try {
    command = JSON.parse(line);
  } catch {
    continue;
  }
  if (command?.type === 'prompt') {
    void handlePrompt(command);
  } else if (command?.type === 'prepare') {
    void handlePrepare(command);
  } else if (command?.type === 'title') {
    void handleTitle(command);
  } else if (command?.type === 'cancel') {
    void cancelRun(trimString(command.requestID));
  } else if (command?.type === 'release-session') {
    agentCache.releaseSession(trimString(command.sessionID));
  } else if (command?.type === 'warm') {
    void handleWarm(command);
  } else if (command?.type === 'shutdown') {
    await shutdown();
  }
}
