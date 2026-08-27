import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { tool } from '@opencode-ai/plugin';

const DEFAULT_PRESET = 'default';
const DEFAULT_COUNCIL_AGENT = 'builder';
const COUNCIL_MODELS_FILE_NAME = 'council.models.json';
const COUNCIL_MODELS_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1_000;
const IDLE_STABLE_RESPONSE_MS = POLL_INTERVAL_MS * 2;
const PRESET_COUNCILLORS = Object.freeze({
  'cursor-composer-2': Object.freeze([{ model: 'cursor-acp/composer-2' }]),
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getManagedBridge = () => {
  const rawUrl = process.env.DEVRYAN_ORCHESTRATION_URL;
  const token = process.env.DEVRYAN_ORCHESTRATION_TOKEN;
  if (!rawUrl && !token) return null;
  if (!rawUrl || !token) throw new Error('Managed council bridge URL and token must be provided together');
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/rpc') {
    throw new Error('Managed council bridge must use the private IPv4 loopback RPC endpoint');
  }
  return { url: url.toString(), token };
};

const callManagedRpc = async (bridge, method, params, signal) => {
  const response = await fetch(bridge.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bridge.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ method, params }),
    signal,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true) {
    const message = typeof body?.error?.message === 'string' && body.error.message.trim()
      ? body.error.message.trim()
      : `Managed council RPC failed (${response.status})`;
    throw new Error(message);
  }
  return body.result;
};

const cloneCouncillors = (councillors) => councillors.map((councillor) => ({ ...councillor }));

const resolveCouncilPreset = (rawPreset) => {
  const name = String(rawPreset || DEFAULT_PRESET).trim() || DEFAULT_PRESET;
  const key = name.toLowerCase();
  const councillors = PRESET_COUNCILLORS[key];
  return {
    name: councillors ? key : name,
    councillors: councillors ? cloneCouncillors(councillors) : null,
  };
};

const normalizeVariant = (variant) => {
  if (typeof variant !== 'string') return undefined;
  const trimmed = variant.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return undefined;
  return trimmed;
};

const formatModelLabel = ({ model, variant }) => {
  const normalizedVariant = normalizeVariant(variant);
  return `${model}${normalizedVariant ? `/${normalizedVariant}` : ''}`;
};

const stringifyErrorValue = (value) => {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const unwrap = (result, label, { allowEmpty = false } = {}) => {
  if (result?.error) {
    const status = result?.response?.status;
    const raw = result.error;
    const message = raw && typeof raw === 'object' && 'message' in raw
      ? stringifyErrorValue(raw.message)
      : stringifyErrorValue(raw);
    throw new Error(`${label} failed${status ? ` (${status})` : ''}: ${message}`);
  }
  if (!allowEmpty && result?.data === undefined) {
    throw new Error(`${label} returned no data`);
  }
  return result?.data;
};

const parseModelRef = (ref) => {
  if (typeof ref !== 'string') return null;
  const trimmed = ref.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash >= trimmed.length - 1) return null;
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
};

const extractFrontmatter = (content) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  return match ? match[1] : '';
};

const cleanYamlScalar = (value) => {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseCouncilFrontmatter = (frontmatter) => {
  const lines = frontmatter.split(/\r?\n/);
  const councillors = [];
  const modelRefs = [];
  let scalarModel = null;
  let scalarVariant = null;
  let block = null;

  for (const line of lines) {
    const modelMatch = /^model:\s*(.+)$/.exec(line);
    if (modelMatch && !line.startsWith(' ')) {
      scalarModel = cleanYamlScalar(modelMatch[1]);
      block = null;
      continue;
    }

    const variantMatch = /^variant:\s*(.+)$/.exec(line);
    if (variantMatch && !line.startsWith(' ')) {
      scalarVariant = cleanYamlScalar(variantMatch[1]);
      block = null;
      continue;
    }

    if (/^modelRefs:\s*$/.test(line)) {
      block = 'modelRefs';
      continue;
    }
    if (/^councillors:\s*$/.test(line)) {
      block = 'councillors';
      continue;
    }
    if (/^\S/.test(line)) {
      block = null;
    }

    if (block === 'modelRefs') {
      const refMatch = /^\s*-\s*(.+)$/.exec(line);
      if (refMatch) modelRefs.push(cleanYamlScalar(refMatch[1]));
      continue;
    }

    if (block === 'councillors') {
      const councillorMatch = /^\s*-\s*model:\s*(.+)$/.exec(line);
      if (councillorMatch) {
        councillors.push({ model: cleanYamlScalar(councillorMatch[1]) });
        continue;
      }
      const councillorVariantMatch = /^\s*variant:\s*(.+)$/.exec(line);
      if (councillorVariantMatch && councillors.length > 0) {
        const variant = normalizeVariant(cleanYamlScalar(councillorVariantMatch[1]));
        if (variant) councillors[councillors.length - 1].variant = variant;
      }
    }
  }

  if (councillors.length > 0) return councillors;
  if (modelRefs.length > 0) {
    const variant = normalizeVariant(scalarVariant);
    return modelRefs.map((model, index) => ({
      model,
      ...(index === 0 && variant ? { variant } : {}),
    }));
  }
  const variant = normalizeVariant(scalarVariant);
  return scalarModel ? [{ model: scalarModel, ...(variant ? { variant } : {}) }] : [];
};

const readCouncilModelsCompanion = async (configDir) => {
  try {
    const content = await fs.readFile(path.join(configDir, 'agents', COUNCIL_MODELS_FILE_NAME), 'utf8');
    const parsed = JSON.parse(content);
    if (parsed?.version !== COUNCIL_MODELS_VERSION || !Array.isArray(parsed.councillors)) {
      return [];
    }
    return parsed.councillors
      .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
      .map((entry) => {
        const model = typeof entry.model === 'string' ? entry.model.trim() : '';
        const variant = normalizeVariant(entry.variant);
        return parseModelRef(model)
          ? { model, ...(variant ? { variant } : {}) }
          : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
};

const readCouncilModelsFromConfig = async () => {
  const configDir = process.env.OPENCODE_CONFIG_DIR;
  if (!configDir) return [];
  const companionModels = await readCouncilModelsCompanion(configDir);
  if (companionModels.length > 0) return companionModels;
  try {
    const content = await fs.readFile(path.join(configDir, 'agents', 'council.md'), 'utf8');
    return parseCouncilFrontmatter(extractFrontmatter(content));
  } catch {
    return [];
  }
};

const listCouncilModels = async (client, directory) => {
  const fromFile = await readCouncilModelsFromConfig();
  if (fromFile.length > 0) return fromFile;

  const agents = unwrap(await client.app.agents({
    query: { directory },
  }), 'app.agents');
  const council = Array.isArray(agents)
    ? agents.find((agent) => agent?.name === 'council')
    : null;
  const model = council?.model?.providerID && council?.model?.modelID
    ? `${council.model.providerID}/${council.model.modelID}`
    : null;
  const variant = normalizeVariant(council?.variant);
  return model ? [{ model, ...(variant ? { variant } : {}) }] : [];
};

const extractAssistantText = (record) => (record?.parts || [])
  .filter((part) => part?.type === 'text' && typeof part.text === 'string')
  .map((part) => part.text)
  .join('\n')
  .trim();

const isTerminalAssistantMessage = (record) => {
  const info = record?.info;
  if (!info || info.role !== 'assistant') return false;
  if (typeof info.finish === 'string' && info.finish.trim()) return true;
  const completed = info.time?.completed;
  return typeof completed === 'number' && Number.isFinite(completed) && completed > 0;
};

const assistantResponseFromMessages = (records) => {
  const assistants = Array.isArray(records)
    ? records.filter((record) => record?.info?.role === 'assistant')
    : [];
  const latest = assistants[assistants.length - 1];
  if (!latest) return { text: '', terminal: false };
  return {
    text: extractAssistantText(latest),
    terminal: isTerminalAssistantMessage(latest),
  };
};

const readAssistantResponse = async (client, sessionID, directory) => {
  const records = unwrap(await client.session.messages({
    path: { id: sessionID },
    query: {
      directory,
      limit: 20,
    },
  }), 'session.messages');
  return assistantResponseFromMessages(records);
};

const waitForAssistantResponse = async (client, sessionID, directory, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let sawIdle = false;
  let idleSince = 0;
  let idleResponseText = '';

  while (Date.now() < deadline) {
    const response = await readAssistantResponse(client, sessionID, directory);
    if (response.text && response.terminal) return response.text;

    const statuses = unwrap(await client.session.status({
      query: { directory },
    }), 'session.status');
    const status = statuses?.[sessionID];
    if (status?.type === 'idle') {
      if (!sawIdle || response.text !== idleResponseText) {
        sawIdle = true;
        idleSince = Date.now();
        idleResponseText = response.text;
      } else if (Date.now() - idleSince >= IDLE_STABLE_RESPONSE_MS) {
        return response.text;
      }
    } else if (status) {
      sawIdle = false;
      idleSince = 0;
      idleResponseText = '';
    }

    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for councillor session`);
};

const buildCouncillorPrompt = (prompt) => [
  'You are one councillor in a multi-model council.',
  'Answer independently and concisely. Do not ask follow-up questions.',
  'State assumptions and uncertainty when needed.',
  '',
  prompt,
].join('\n');

const runCouncillor = async ({ client, context, prompt, councillor, index, timeoutMs }) => {
  const parsed = parseModelRef(councillor.model);
  const variant = normalizeVariant(councillor.variant);
  const modelLabel = formatModelLabel({ model: councillor.model, variant });
  const name = `Councillor ${index + 1} (${modelLabel})`;
  if (!parsed) {
    return { name, status: 'failed', response: `Invalid model ref: ${councillor.model}` };
  }

  const parentID = typeof context.sessionID === 'string' && context.sessionID.trim()
    ? context.sessionID.trim()
    : undefined;

  const session = unwrap(await client.session.create({
    query: { directory: context.directory },
    body: {
      title: `Counsellor ${index + 1}: ${modelLabel}`,
      ...(parentID ? { parentID } : {}),
    },
  }), 'session.create');

  await client.session.promptAsync({
    path: { id: session.id },
    query: { directory: context.directory },
    body: {
      agent: DEFAULT_COUNCIL_AGENT,
      model: parsed,
      ...(variant ? { variant } : {}),
      tools: {
        council_session: false,
        question: false,
      },
      parts: [{
        type: 'text',
        text: buildCouncillorPrompt(prompt),
      }],
    },
  }, { throwOnError: false }).then((result) => unwrap(result, 'session.promptAsync', { allowEmpty: true }));

  const response = await waitForAssistantResponse(client, session.id, context.directory, timeoutMs);
  return {
    name,
    status: response ? 'completed' : 'failed',
    response: response || 'No assistant response was recorded.',
  };
};

const runManagedCouncillor = async ({ bridge, context, prompt, councillor, index, timeoutMs }) => {
  const parsed = parseModelRef(councillor.model);
  const variant = normalizeVariant(councillor.variant);
  const modelLabel = formatModelLabel({ model: councillor.model, variant });
  const name = `Councillor ${index + 1} (${modelLabel})`;
  if (!parsed) {
    return { name, status: 'failed', response: `Invalid model ref: ${councillor.model}` };
  }
  const rootSessionId = typeof context.sessionID === 'string' ? context.sessionID.trim() : '';
  const directory = typeof context.directory === 'string' ? context.directory.trim() : '';
  if (!rootSessionId || !directory) {
    throw new Error('Managed council execution requires session and directory context');
  }
  const idempotencyDigest = crypto.createHash('sha256')
    .update(JSON.stringify({
      messageID: context.messageID || '',
      index,
      model: councillor.model,
      variant: variant || null,
      prompt,
    }))
    .digest('hex');
  const submitted = await callManagedRpc(bridge, 'submit', {
    idempotencyKey: `council:${rootSessionId}:${idempotencyDigest}`,
    rootSessionId,
    parentTaskId: null,
    directory,
    mode: 'orchestrator',
    providerId: parsed.providerID,
    modelId: parsed.modelID,
    agent: DEFAULT_COUNCIL_AGENT,
    variant: variant || null,
    label: `Counsellor ${index + 1}: ${modelLabel}`,
    prompt: buildCouncillorPrompt(prompt),
    deadlineClass: 'council',
    timeoutAt: Date.now() + timeoutMs,
  }, context.abort);
  const taskId = submitted?.task?.taskId;
  if (typeof taskId !== 'string' || !taskId) {
    throw new Error('Managed council submit returned no task ID');
  }
  const settled = await callManagedRpc(bridge, 'wait', {
    taskId,
    rootSessionId,
    directory,
  }, context.abort);
  const task = settled?.task ?? {};
  const envelope = settled?.resultEnvelope ?? {};
  const recoverablePreview = typeof envelope.recoverablePreview === 'string'
    ? envelope.recoverablePreview.trim()
    : (typeof task.recoverablePreview === 'string' ? task.recoverablePreview.trim() : '');
  const failureReason = typeof envelope.failureReason === 'string' && envelope.failureReason.trim()
    ? envelope.failureReason.trim()
    : (typeof task.failureReason === 'string' ? task.failureReason.trim() : '');
  const completed = task.status === 'completed';
  return {
    name,
    status: completed ? 'completed' : 'failed',
    response: [
      recoverablePreview,
      ...(!completed && failureReason ? [`Interrupted: ${failureReason}`] : []),
    ].filter(Boolean).join('\n\n') || 'No assistant response was recorded.',
  };
};

export const CouncilSessionPlugin = async ({ client }) => ({
  tool: {
    council_session: tool({
      description: 'Run the prompt through the configured Council councillor models and return their independent responses for synthesis.',
      args: {
        prompt: tool.schema.string().describe('The full user prompt and context to send to each councillor.'),
        preset: tool.schema.string().optional().describe('Council preset name. Defaults to "default". Use "cursor-composer-2" to force Cursor Composer 2-only councillors.'),
      },
      async execute(args, context) {
        const prompt = String(args.prompt || '').trim();
        if (!prompt) {
          return 'Council session failed: prompt is required.';
        }

        const preset = resolveCouncilPreset(args.preset);
        const councillors = preset.councillors || await listCouncilModels(client, context.directory);
        if (councillors.length === 0) {
          return 'Council session failed: no councillor models are configured for the council agent.';
        }

        const managedBridge = getManagedBridge();

        const settled = await Promise.allSettled(councillors.map((councillor, index) => (
          managedBridge
            ? runManagedCouncillor({
                bridge: managedBridge,
                context,
                prompt,
                councillor,
                index,
                timeoutMs: DEFAULT_TIMEOUT_MS,
              })
            : runCouncillor({
                client,
                context,
                prompt,
                councillor,
                index,
                timeoutMs: DEFAULT_TIMEOUT_MS,
              })
        )));

        const results = settled.map((result, index) => (
          result.status === 'fulfilled'
            ? result.value
            : {
              name: `Councillor ${index + 1} (${councillors[index]?.model || 'unknown'})`,
              status: 'failed',
              response: result.reason instanceof Error ? result.reason.message : String(result.reason),
            }
        ));

        return [
          `Council session preset: ${preset.name}`,
          `Councillors requested: ${councillors.length}`,
          '',
          ...results.flatMap((result) => [
            `### ${result.name}`,
            `Status: ${result.status}`,
            result.response,
            '',
          ]),
        ].join('\n').trim();
      },
    }),
  },
});
