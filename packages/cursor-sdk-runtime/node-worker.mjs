import process from 'node:process';
import {
  normalizeCursorSdkAgentDefinitions,
  pinCursorSdkSubagentModels,
} from './agent-definitions.js';
import { configureCursorSdkRipgrep } from './ripgrep-path.js';
import {
  generateCursorSessionTitle,
} from './title-generation.js';
import { normalizeInteractionUpdateToSdkMessage } from './interaction-update-normalize.js';
import { assertCursorSdkNodeCompatibility } from './node-version.js';

const readStdin = async () => {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return JSON.parse(raw);
};

const trimString = (value) => (typeof value === 'string' ? value.trim() : '');

const isPlainObject = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

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

const isMissingCursorAgentError = (error) => /Agent .* not found/i.test(error instanceof Error ? error.message : String(error || ''));

const writeEvent = (event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const writeTiming = (mark, metadata) => {
  writeEvent({
    type: 'timing',
    mark,
    ...(metadata ? { metadata } : {}),
  });
};

const parseSettingSourcesFlag = (raw) => {
  const v = trimString(raw);
  if (!v) return undefined;
  if (v.toLowerCase() === 'none') return [];
  const allowed = new Set(['project', 'user', 'team', 'mdm', 'plugins', 'all']);
  const parsed = v.split(',').map((s) => s.trim()).filter((s) => allowed.has(s));
  return parsed.length ? parsed : undefined;
};

// DevRyan cursor context trim (default OFF) — see OPENCHAMBER_CURSOR_SETTING_SOURCES.
const CURSOR_SETTING_SOURCES = parseSettingSourcesFlag(process.env.OPENCHAMBER_CURSOR_SETTING_SOURCES);

const sdkStatusFromRunStatus = (status) => {
  if (status === 'finished') return 'FINISHED';
  if (status === 'error') return 'ERROR';
  if (status === 'cancelled') return 'CANCELLED';
  return 'RUNNING';
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

const main = async () => {
  assertCursorSdkNodeCompatibility();
  const input = await readStdin();
  const apiKey = trimString(input.apiKey);
  const modelID = trimString(input.modelID) || 'auto';
  const modelSelection = normalizeModelSelection(input.modelSelection, modelID);
  const agents = pinCursorSdkSubagentModels(normalizeCursorSdkAgentDefinitions(input.agents), modelSelection);
  const mcpServers = isPlainObject(input.mcpServers) ? input.mcpServers : null;
  const prompt = trimString(input.type === 'title' ? input.text : input.prompt);
  const images = Array.isArray(input.images)
    ? input.images
      .filter((image) => (
        isPlainObject(image)
        && (
          (trimString(image.data) && trimString(image.mimeType))
          || trimString(image.url)
        )
      ))
      .map((image) => {
        const data = trimString(image.data);
        const mimeType = trimString(image.mimeType);
        if (data && mimeType) return { data, mimeType };
        return { url: trimString(image.url) };
      })
    : [];
  const directory = trimString(input.directory);
  const agentID = trimString(input.agentID);

  if (!apiKey) throw new Error('Cursor SDK API key is not configured.');
  if (!prompt) throw new Error('Cursor prompt is required.');

  const cursorSdk = await import('@cursor/sdk');
  configureCursorSdkRipgrep(cursorSdk, { env: process.env });
  const { Agent } = cursorSdk;
  const model = modelSelection;
  if (input.type === 'title') {
    const title = await generateCursorSessionTitle({
      Agent,
      apiKey,
      text: prompt,
      directory,
    });
    writeEvent({ type: 'title-result', title });
    setTimeout(() => process.exit(0), 25).unref?.();
    return;
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
    ...(agents ? { agents } : {}),
    ...(mcpServers ? { mcpServers } : {}),
  };
  writeTiming('cursor_run_create_started');
  let agent = null;
  let cacheHit = false;
  if (agentID) {
    try {
      agent = await Agent.resume(agentID, agentOptions);
      cacheHit = true;
    } catch (error) {
      if (!isMissingCursorAgentError(error)) {
        throw error;
      }
    }
  }
  if (!agent) {
    agent = await Agent.create({
      name: `DevRyan ${trimString(input.sessionID) || Date.now()}`,
      ...agentOptions,
    });
  }
  writeTiming('cursor_run_created', { cacheHit });

  if (agent?.agentId) {
    writeEvent({ type: 'agent', agentID: agent.agentId });
  }

  const message = images.length > 0 ? { text: prompt, images } : { text: prompt };
  const shouldSkipDuplicateMessage = createCrossSourceMessageDedupe();
  writeTiming('cursor_provider_send_started');
  const run = await agent.send(message, {
    model,
    onDelta: (event) => {
      const sdkMessage = normalizeInteractionUpdateToSdkMessage(event);
      if (!sdkMessage) return;
      if (sdkMessage.type === 'usage') {
        writeEvent({ type: 'usage', tokens: sdkMessage.tokens });
        return;
      }
      writeSdkMessage(sdkMessage, 'delta');
    },
  });
  writeTiming('cursor_provider_send_accepted');
  let doneEmitted = false;
  function writeSdkMessage(sdkMessage, source = 'stream') {
    if (shouldSkipDuplicateMessage(source, sdkMessage)) return;
    writeEvent({ type: 'message', message: sdkMessage });
  }
  const streamIterator = run.stream()[Symbol.asyncIterator]();
  let streamIteratorClosed = false;
  const closeStreamIterator = async () => {
    if (streamIteratorClosed) return;
    streamIteratorClosed = true;
    if (typeof streamIterator.return === 'function') {
      await streamIterator.return();
    }
  };
  const writeDone = (status) => {
    if (doneEmitted) return;
    doneEmitted = true;
    writeEvent({
      type: 'message',
      message: {
        type: 'status',
        agent_id: run.agentId,
        run_id: run.id,
        status: sdkStatusFromRunStatus(status),
      },
    });
    writeEvent({ type: 'done', status });
  };

  const disposeStatusListener = typeof run.onDidChangeStatus === 'function'
    ? run.onDidChangeStatus((status) => {
      writeEvent({
        type: 'message',
        message: {
          type: 'status',
          agent_id: run.agentId,
          run_id: run.id,
          status: sdkStatusFromRunStatus(status),
        },
      });
    })
    : () => {};

  const waitPromise = run.wait()
    .then((result) => {
      const finalText = trimString(result?.result);
      const finalStatus = finalStatusFromSdkStatus(sdkStatusFromRunStatus(result?.status || run.status));
      writeEvent({
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
      setTimeout(() => process.exit(0), 25).unref?.();
    })
    .catch((error) => {
      writeEvent({
        type: 'final-result',
        result: {
          ok: false,
          finalStatus: 'error',
          finalText: '',
          error: error instanceof Error ? error.message : 'Cursor SDK run failed.',
        },
      });
      writeEvent({
        type: 'error',
        error: error instanceof Error ? error.message : 'Cursor SDK run failed.',
      });
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 25).unref?.();
    })
    .finally(() => {
      disposeStatusListener();
    });

  let shuttingDown = false;
  const cancel = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (typeof run.cancel === 'function') {
        await run.cancel();
      }
    } finally {
      process.exit(130);
    }
  };

  process.once('SIGTERM', () => {
    void cancel();
  });
  process.once('SIGINT', () => {
    void cancel();
  });

  for (;;) {
    const next = await streamIterator.next();
    if (next.done) break;
    writeSdkMessage(next.value, 'stream');
  }

  await waitPromise;
  writeDone(run.status);
};

main().catch((error) => {
  writeEvent({
    type: 'error',
    error: error instanceof Error ? error.message : 'Cursor SDK worker failed.',
  });
  process.exitCode = 1;
});
