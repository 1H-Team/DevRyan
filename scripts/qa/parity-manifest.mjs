// Parity manifest: a deterministic, secret-free snapshot of the effective agent
// runtime catalog (agents, commands, config, MCP, tools, skills, DevRyan health,
// Slim) captured from a running isolated DevRyan host through its proxied
// OpenCode API. The same capture on a candidate runtime is diffed against the
// recorded baseline (`--diff`), so an upgrade reports every catalog change.
//
// Only GET routes are called. Prompt, template, skill and tool-description
// bodies are never stored: they are path-normalized and hashed. Config is
// reduced through an allowlist, so provider options, MCP URLs/headers/env and
// OAuth objects never reach the manifest. Request headers are never persisted.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openCodeBaseVersion } from '../../packages/web/server/lib/opencode/opencode-update-runtime.js';
import { resolveQaTargetOpenCodeVersion } from '../../packages/web/server/lib/opencode/version-policy.js';

export const PARITY_SCHEMA_VERSION = 1;
export const SLIM_PACKAGE_NAME = 'oh-my-opencode-slim';
export const SLIM_WRAPPER_FILE = 'devryan-oh-my-opencode-slim.mjs';
const DEFAULT_TIMEOUT_MS = 30_000;

// Slim 2.2.25 behaviours DevRyan relies on. A future runtime must reproduce each
// one or the upgrade must drop it explicitly. Commands and tools are confirmed
// from the live lists; the rest cannot be observed from catalog routes.
export const SLIM_BEHAVIOURS = Object.freeze([
  ...['interview', 'deepwork', 'reflect', 'loop'].map(name => ({ id: `command.${name}`, kind: 'command', name, summary: `/${name} command` })),
  // Slim's task_* tools are dead weight under DevRyan: Orchestrator's `task` is
  // denied and managed roles use devryan_task; only Orchestrator may call them
  // in Slim's own code. wait_for_user is likewise unused by DevRyan's roles.
  ...['task_cancel', 'task_message', 'task_reply', 'task_result', 'task_revive', 'task_status', 'wait_for_user']
    .map(name => ({ id: `tool.${name}`, kind: 'tool', name, summary: `${name} direct tool`, devryan: 'unused' })),
  // Librarian uses webfetch and Explorer ast_grep_search; ast_grep_replace is
  // advertised but no packaged role prompt names it.
  { id: 'tool.webfetch', kind: 'tool', name: 'webfetch', summary: 'webfetch direct tool (Slim replaces the built-in by name)' },
  { id: 'tool.ast_grep_search', kind: 'tool', name: 'ast_grep_search', summary: 'ast_grep_search direct tool' },
  { id: 'tool.ast_grep_replace', kind: 'tool', name: 'ast_grep_replace', summary: 'ast_grep_replace direct tool', devryan: 'unused' },
  { id: 'hook.apply-patch-rescue', kind: 'hook', name: 'apply_patch rescue', summary: 'tool hook repairing rejected apply_patch input' },
  { id: 'hook.path-rescue', kind: 'hook', name: 'path rescue', summary: 'tool hook resolving mistyped or relative paths' },
  { id: 'hook.search-guard', kind: 'hook', name: 'search guard', summary: 'tool hook bounding search/grep calls' },
  { id: 'hook.loop-guard', kind: 'hook', name: 'loop guard', summary: 'tool hook stopping repeated identical calls' },
  { id: 'hook.json-recovery', kind: 'hook', name: 'JSON recovery', summary: 'tool hook recovering malformed JSON tool arguments' },
  { id: 'behaviour.phase-reminders', kind: 'behaviour', name: 'phase reminders / background job board', summary: 'orchestrator phase reminders and background job board', devryan: 'stripped-by-wrapper' },
  { id: 'behaviour.display-name-rewrite', kind: 'behaviour', name: 'display-name rewrite', summary: 'agent display-name rewrite' },
  { id: 'behaviour.image-routing', kind: 'behaviour', name: 'image routing', summary: 'image attachments routed to a vision-capable agent' },
  { id: 'behaviour.skill-list-filtering', kind: 'behaviour', name: 'skill-list filtering', summary: 'per-agent skill list filtering' },
  { id: 'behaviour.permission-bridge', kind: 'behaviour', name: 'permission bridge', summary: 'permission bridge applied on session.created (Slim V2 setup only; absent on the 1.x wrapper)', devryan: 'absent-on-v1' },
  { id: 'behaviour.orchestrator-wake-prompts', kind: 'behaviour', name: 'orchestrator wake prompts', summary: 'orchestrator wake prompts', devryan: 'hidden-by-wrapper' },
  { id: 'behaviour.retry-fallback', kind: 'behaviour', name: 'retry/fallback', summary: 'model retry/fallback', devryan: 'disabled-by-overlay' },
]);

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPrimitive = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const stringOrNull = value => typeof value === 'string' && value ? value : null;
const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const byKey = key => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
const sortedStrings = values => [...new Set(values.filter(value => typeof value === 'string'))].sort();

export const sha256 = text => createHash('sha256').update(text).digest('hex');

// Deep copy with object keys sorted; array order is preserved (callers sort
// set-like arrays and keep order-significant ones such as permission rules).
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

export const stableStringify = value => JSON.stringify(canonicalize(value) ?? null);

// Credentials embedded in URLs or common secret query parameters.
export function redactCredentials(text) {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1<redacted>@')
    .replace(/([?&](?:token|access_token|refresh_token|key|api[_-]?key|apikey|auth|secret|sig|signature|password|code)=)[^&#\s"']+/gi, '$1<redacted>');
}

// Per-run roots (the fixture directory, the private QA home, the user's home)
// are replaced with stable placeholders so two captures diff on content only.
export function createPathNormalizer({ directory, qaHome, userHome = os.homedir() } = {}) {
  const roots = [];
  const addRoot = (root, token) => {
    if (typeof root !== 'string' || !path.isAbsolute(root)) return;
    const variants = new Set([path.resolve(root)]);
    try { variants.add(realpathSync(root)); } catch { /* the root may not exist locally */ }
    for (const variant of variants) if (variant !== path.sep) roots.push([variant, token]);
  };
  addRoot(directory, '<directory>');
  addRoot(qaHome, '<qa-home>');
  addRoot(userHome, '<home>');
  roots.sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    if (typeof text !== 'string') return text;
    let result = text;
    for (const [root, token] of roots) result = result.split(root).join(token);
    return redactCredentials(result);
  };
}

const normalizeDeep = (value, normalize) => {
  if (typeof value === 'string') return normalize(value);
  if (Array.isArray(value)) return value.map(item => normalizeDeep(item, normalize));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [normalize(key), normalizeDeep(item, normalize)]));
  return value;
};

const hashText = (text, normalize) => {
  if (typeof text !== 'string') return null;
  const normalized = normalize(text);
  return { length: normalized.length, sha256: sha256(normalized) };
};

export function summarizeHealth(health) {
  const version = stringOrNull(health?.openCodeVersion);
  const base = version ? openCodeBaseVersion(version) : null;
  return canonicalize({
    status: stringOrNull(health?.status),
    isOpenCodeReady: health?.isOpenCodeReady === true,
    openCodeRunning: health?.openCodeRunning === true,
    openCodeSecureConnection: typeof health?.openCodeSecureConnection === 'boolean' ? health.openCodeSecureConnection : null,
    openCodeAuthSource: stringOrNull(health?.openCodeAuthSource),
    openCodeApiPrefix: typeof health?.openCodeApiPrefix === 'string' ? health.openCodeApiPrefix : null,
    executionRuntime: isPlainObject(health?.executionRuntime)
      ? { state: stringOrNull(health.executionRuntime.state), code: stringOrNull(health.executionRuntime.code) }
      : null,
    opencodeBinarySource: stringOrNull(health?.opencodeBinarySource),
    opencodeLaunchWrapperType: stringOrNull(health?.opencodeLaunchWrapperType),
    opencodeViaWsl: health?.opencodeViaWsl === true,
    planModeExperimentalEnabled: typeof health?.planModeExperimentalEnabled === 'boolean' ? health.planModeExperimentalEnabled : null,
    multiUserControlPlaneState: stringOrNull(health?.multiUserControlPlane?.state),
  });
}

export function summarizeAgents(list, normalize) {
  if (!Array.isArray(list)) throw new Error('agent list is not an array');
  return list.filter(agent => typeof agent?.name === 'string').map(agent => canonicalize({
    name: agent.name,
    mode: stringOrNull(agent.mode),
    builtIn: agent.native === true,
    hidden: agent.hidden === true,
    model: isPlainObject(agent.model) ? { providerID: stringOrNull(agent.model.providerID), modelID: stringOrNull(agent.model.modelID) } : null,
    variant: stringOrNull(agent.variant),
    description: hashText(agent.description, normalize),
    prompt: hashText(agent.prompt, normalize),
    temperature: numberOrNull(agent.temperature),
    topP: numberOrNull(agent.topP),
    steps: numberOrNull(agent.steps),
    optionKeys: isPlainObject(agent.options) ? Object.keys(agent.options).sort() : [],
    // Rule order is significant (the last matching rule wins), so it is kept.
    permission: Array.isArray(agent.permission)
      ? agent.permission.filter(isPlainObject).map(rule => ({
        permission: normalize(String(rule.permission ?? '')),
        pattern: normalize(String(rule.pattern ?? '')),
        action: stringOrNull(rule.action),
      }))
      : null,
    // 1.18.x agents carry permission rules only; a legacy tools map is kept if a runtime returns one.
    tools: isPlainObject(agent.tools)
      ? Object.fromEntries(Object.entries(agent.tools).filter(([, enabled]) => typeof enabled === 'boolean'))
      : null,
  })).sort(byKey('name'));
}

export function summarizeCommands(list, normalize) {
  if (!Array.isArray(list)) throw new Error('command list is not an array');
  return list.filter(command => typeof command?.name === 'string').map(command => canonicalize({
    name: command.name,
    description: typeof command.description === 'string' ? normalize(command.description) : null,
    agent: stringOrNull(command.agent),
    model: stringOrNull(command.model),
    source: stringOrNull(command.source),
    subtask: typeof command.subtask === 'boolean' ? command.subtask : null,
    hints: Array.isArray(command.hints) ? command.hints.filter(hint => typeof hint === 'string') : [],
    template: hashText(command.template, normalize),
  })).sort(byKey('name'));
}

const presence = (value) => {
  if (value === undefined || value === null) return { state: 'absent' };
  if (value === false) return { state: 'disabled' };
  if (value === true) return { state: 'enabled' };
  if (isPlainObject(value)) return { state: 'configured', ids: Object.keys(value).sort() };
  return { state: 'unknown' };
};

const primitiveEntries = value => isPlainObject(value)
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => isPrimitive(item)))
  : null;

// Allowlist only: provider options, MCP commands/URLs/headers/environment and
// OAuth objects are never read into the manifest.
export function summarizeConfig(config, normalize) {
  if (!isPlainObject(config)) throw new Error('config is not an object');
  const pluginName = entry => typeof entry === 'string' ? entry : Array.isArray(entry) && typeof entry[0] === 'string' ? entry[0] : null;
  const mcp = isPlainObject(config.mcp)
    ? Object.entries(config.mcp).map(([id, entry]) => ({
      id: normalize(id),
      type: entry?.type === 'local' || entry?.type === 'remote' ? entry.type : null,
      enabled: typeof entry?.enabled === 'boolean' ? entry.enabled : null,
    })).sort(byKey('id'))
    : [];
  const providers = isPlainObject(config.provider)
    ? Object.entries(config.provider).map(([id, entry]) => ({
      id,
      models: isPlainObject(entry?.models) ? Object.keys(entry.models).sort() : [],
    })).sort(byKey('id'))
    : [];
  return canonicalize({
    defaultAgent: stringOrNull(config.default_agent),
    model: stringOrNull(config.model),
    smallModel: stringOrNull(config.small_model),
    // Plugin load order decides hook order, so it is kept.
    plugins: Array.isArray(config.plugin) ? config.plugin.map(pluginName).filter(Boolean).map(normalize) : [],
    instructions: Array.isArray(config.instructions) ? config.instructions.filter(item => typeof item === 'string').map(normalize) : [],
    skills: {
      paths: Array.isArray(config.skills?.paths) ? config.skills.paths.filter(item => typeof item === 'string').map(normalize) : [],
      urls: Array.isArray(config.skills?.urls) ? config.skills.urls.filter(item => typeof item === 'string').map(normalize) : [],
    },
    permission: config.permission === undefined ? null : normalizeDeep(config.permission, normalize),
    tools: isPlainObject(config.tools) ? Object.fromEntries(Object.entries(config.tools).filter(([, enabled]) => typeof enabled === 'boolean')) : null,
    agentKeys: isPlainObject(config.agent) ? Object.keys(config.agent).sort() : [],
    mcp,
    providers,
    experimentalKeys: isPlainObject(config.experimental) ? Object.keys(config.experimental).sort() : [],
    compaction: primitiveEntries(config.compaction),
    lsp: presence(config.lsp),
    formatter: presence(config.formatter),
  });
}

export function summarizeMcpStatus(status) {
  if (!isPlainObject(status)) throw new Error('mcp status is not an object');
  // Failure text can quote server URLs, so only its presence is recorded.
  return Object.entries(status).map(([id, entry]) => ({
    id,
    status: stringOrNull(entry?.status),
    hasError: typeof entry?.error === 'string' && entry.error.length > 0,
  })).sort(byKey('id'));
}

export function summarizeToolIds(list) {
  if (!Array.isArray(list)) throw new Error('tool id list is not an array');
  return sortedStrings(list);
}

export function summarizeToolDefinitions(list, normalize) {
  if (!Array.isArray(list)) throw new Error('tool list is not an array');
  return list.filter(tool => typeof tool?.id === 'string').map(tool => canonicalize({
    id: tool.id,
    description: hashText(tool.description, normalize),
    parametersSha256: sha256(normalize(stableStringify(tool.parameters ?? null))),
  })).sort(byKey('id'));
}

export function summarizeSkills(list, normalize) {
  if (!Array.isArray(list)) throw new Error('skill list is not an array');
  return list.filter(skill => typeof skill?.name === 'string').map((skill) => {
    const location = typeof skill.location === 'string' ? skill.location : null;
    return canonicalize({
      name: skill.name,
      location: location ? normalize(location) : null,
      // <root>/<skill>/SKILL.md: the discovery root the skill came from.
      sourceRoot: location ? normalize(path.dirname(path.dirname(location))) : null,
      description: hashText(skill.description, normalize),
      content: hashText(skill.content, normalize),
    });
  }).sort(byKey('name'));
}

export function summarizeDevRyanSkills(payload) {
  const list = Array.isArray(payload?.skills) ? payload.skills : null;
  if (!list) throw new Error('DevRyan skill payload has no skills array');
  return list.filter(skill => typeof skill?.name === 'string').map(skill => ({
    name: skill.name,
    scope: stringOrNull(skill.scope),
    source: stringOrNull(skill.source),
  })).sort(byKey('name'));
}

export function summarizeSlimStatus(status) {
  if (!isPlainObject(status)) throw new Error('Slim status is not an object');
  return canonicalize({
    ok: status.ok === true,
    installedVersion: stringOrNull(status.installedVersion),
    runtimeEnabled: status.runtimeEnabled === true,
    wrapperConfigured: status.wrapperConfigured === true,
    rawRegistered: status.wrapperStatus?.rawRegistered === true,
    packageDependencyInstalled: status.packageDependencyInstalled === true,
    slimConfigExists: status.slimConfigExists === true,
    backgroundSubagentsEnv: stringOrNull(status.backgroundSubagentsEnv),
    issueCodes: Array.isArray(status.issues) ? sortedStrings(status.issues.map(issue => issue?.code)) : [],
  });
}

// Live lists confirm commands and tool ids; everything else stays `static`.
export function buildSlimChecklist({ commands, toolIds } = {}) {
  const commandNames = Array.isArray(commands) ? new Set(commands.map(command => command.name)) : null;
  const tools = Array.isArray(toolIds) ? new Set(toolIds) : null;
  return SLIM_BEHAVIOURS.map((behaviour) => {
    const source = behaviour.kind === 'command' ? commandNames : behaviour.kind === 'tool' ? tools : undefined;
    const evidence = source === undefined ? 'static' : source === null ? 'unavailable' : behaviour.kind === 'command' ? 'live-command-list' : 'live-tool-ids';
    return canonicalize({
      ...behaviour,
      devryan: behaviour.devryan ?? 'relies',
      evidence,
      observed: source ? source.has(behaviour.name) : null,
    });
  }).sort(byKey('id'));
}

export async function captureSlimStatic({ slimPackage, wrapperPath, readFileImpl = readFile } = {}) {
  if (!slimPackage) return { status: 'skipped', reason: 'no --slim-package or --qa-home given' };
  let manifest;
  try {
    manifest = JSON.parse(await readFileImpl(path.join(slimPackage, 'package.json'), 'utf8'));
  } catch (error) {
    return { status: 'error', reason: `Slim package.json unreadable (${error.code || error.name})` };
  }
  const hashFile = async (file) => {
    try { return sha256(await readFileImpl(file)); } catch { return null; }
  };
  return {
    status: 'captured',
    data: canonicalize({
      packageName: stringOrNull(manifest?.name),
      version: stringOrNull(manifest?.version),
      distIndexSha256: await hashFile(path.join(slimPackage, 'dist', 'index.js')),
      wrapperSha256: wrapperPath ? await hashFile(wrapperPath) : null,
    }),
  };
}

const sectionFailure = (error) => {
  if (error?.httpStatus === 404) return { status: 'skipped', reason: 'route not available on this runtime (HTTP 404)' };
  if (error?.httpStatus) return { status: 'error', reason: `HTTP ${error.httpStatus}` };
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return { status: 'error', reason: 'request timed out' };
  // Only fixed messages from this module or error names: never response bodies.
  return { status: 'error', reason: error?.parityReason || `request failed (${error?.name || 'unknown'})` };
};

export function parseOrigin(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('--origin must be an absolute http(s) URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('--origin must be an absolute http(s) URL');
  if (url.username || url.password) throw new Error('--origin must not carry credentials');
  return { base: url.origin, host: url.host };
}

export function resolveExpectedRuntime({ expectRuntime, env = process.env } = {}) {
  if (expectRuntime === undefined) return resolveQaTargetOpenCodeVersion(env);
  if (typeof expectRuntime !== 'string' || !expectRuntime.trim()) throw new Error('--expect-runtime requires an exact OpenCode version');
  const { version } = resolveQaTargetOpenCodeVersion({ DEVRYAN_QA_OPENCODE_VERSION: String(expectRuntime) });
  return { version, source: '--expect-runtime' };
}

// Tool definitions need a provider/model; prefer explicit flags, then the
// default agent's model, then config.model.
export function selectToolModel({ provider, model, agents, config }) {
  if (provider && model) return { providerID: provider, modelID: model, from: 'flags' };
  const defaultAgentName = stringOrNull(config?.default_agent);
  const agent = Array.isArray(agents) ? agents.find(item => item?.name === defaultAgentName) : null;
  if (agent?.model?.providerID && agent?.model?.modelID) {
    return { providerID: agent.model.providerID, modelID: agent.model.modelID, from: 'default-agent' };
  }
  const configModel = stringOrNull(config?.model);
  const slash = configModel ? configModel.indexOf('/') : -1;
  if (slash > 0 && slash < configModel.length - 1) {
    return { providerID: configModel.slice(0, slash), modelID: configModel.slice(slash + 1), from: 'config.model' };
  }
  return null;
}

export async function captureParityManifest({
  origin,
  directory,
  fetchImpl = globalThis.fetch,
  expectRuntime,
  env = process.env,
  slimPackage,
  qaHome,
  provider,
  model,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => new Date(),
  userHome = os.homedir(),
  readFileImpl = readFile,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('--directory must be an absolute path');
  const { base, host } = parseOrigin(origin);
  const expected = resolveExpectedRuntime({ expectRuntime, env });
  const normalize = createPathNormalizer({ directory, qaHome, userHome });

  const getJson = async (route, { scoped = true, query = {} } = {}) => {
    const url = new URL(route, base);
    if (scoped) url.searchParams.set('directory', directory);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const headers = { accept: 'application/json' };
    if (scoped) headers['x-opencode-directory'] = directory;
    const response = await fetchImpl(url.toString(), { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { httpStatus: response.status });
    try {
      return await response.json();
    } catch {
      throw Object.assign(new Error('invalid JSON'), { parityReason: 'response was not JSON' });
    }
  };

  const health = await getJson('/api/health', { scoped: false });
  if (health?.isOpenCodeReady !== true) throw new Error('DevRyan host reports OpenCode not ready');
  const observed = stringOrNull(health?.openCodeVersion);
  const observedBase = observed ? openCodeBaseVersion(observed) : null;
  if (observedBase !== expected.version) {
    throw new Error(observed
      ? `Observed OpenCode ${JSON.stringify(observed)} does not match expected ${expected.version} (${expected.source})`
      : `Observed OpenCode version is unavailable; expected ${expected.version} (${expected.source})`);
  }

  const raw = {};
  const section = async (name, route, summarize, options) => {
    let body;
    try {
      body = await getJson(route, options);
    } catch (error) {
      return { ...sectionFailure(error), source: `GET ${route}` };
    }
    try {
      const data = summarize(body);
      raw[name] = body;
      return { status: 'captured', source: `GET ${route}`, data };
    } catch {
      return { status: 'error', source: `GET ${route}`, reason: 'unexpected response shape' };
    }
  };

  const sections = {};
  sections.devryan = { status: 'captured', source: 'GET /api/health', data: summarizeHealth(health) };
  sections.agents = await section('agents', '/api/agent', list => summarizeAgents(list, normalize));
  sections.commands = await section('commands', '/api/command', list => summarizeCommands(list, normalize));
  sections.config = await section('config', '/api/config', config => summarizeConfig(config, normalize));
  sections.mcp = await section('mcp', '/api/mcp', summarizeMcpStatus);
  sections.toolIds = await section('toolIds', '/api/experimental/tool/ids', summarizeToolIds);

  const selection = selectToolModel({ provider, model, agents: raw.agents, config: raw.config });
  if (selection) {
    const route = '/api/experimental/tool';
    sections.tools = {
      ...await section('tools', route, list => summarizeToolDefinitions(list, normalize), { query: { provider: selection.providerID, model: selection.modelID } }),
      selection,
    };
  } else {
    sections.tools = { status: 'skipped', source: 'GET /api/experimental/tool', reason: 'no provider/model resolvable; pass --provider and --model' };
  }
  sections.skills = await section('skills', '/api/skill', list => summarizeSkills(list, normalize));
  sections.devryanSkills = await section('devryanSkills', '/api/config/skills', summarizeDevRyanSkills);
  sections.devryanSlim = await section('devryanSlim', '/api/config/slim/status', summarizeSlimStatus, { scoped: false });

  const slimPackagePath = slimPackage || (qaHome ? path.join(qaHome, '.config', 'opencode', 'node_modules', SLIM_PACKAGE_NAME) : null);
  const wrapperPath = qaHome ? path.join(qaHome, '.config', 'opencode', 'plugins', SLIM_WRAPPER_FILE) : null;
  const slimStatic = await captureSlimStatic({ slimPackage: slimPackagePath, wrapperPath, readFileImpl });
  sections.slim = {
    status: 'captured',
    source: 'static package + live command/tool lists',
    data: {
      package: slimStatic,
      checklist: buildSlimChecklist({
        commands: sections.commands.status === 'captured' ? sections.commands.data : null,
        toolIds: sections.toolIds.status === 'captured' ? sections.toolIds.data : null,
      }),
    },
  };

  return canonicalize({
    schemaVersion: PARITY_SCHEMA_VERSION,
    capturedAt: now().toISOString(),
    origin: host,
    directory,
    hashing: 'sha256 over text with per-run roots replaced by <directory>/<qa-home>/<home> and URL credentials redacted',
    runtime: { observed, observedBase, expected: expected.version, source: expected.source },
    sections,
  });
}

const itemKey = item => isPlainObject(item) ? (typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : null) : null;
const keyedArray = (array) => {
  if (!array.length || !array.every(item => itemKey(item) !== null)) return null;
  const map = new Map(array.map(item => [itemKey(item), item]));
  return map.size === array.length ? map : null;
};
const joinPath = (base, key) => base ? `${base}.${key}` : key;

export function diffValues(before, after, at = '', changes = []) {
  if (stableStringify(before) === stableStringify(after)) return changes;
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of sortedStrings([...Object.keys(before), ...Object.keys(after)])) diffValues(before[key], after[key], joinPath(at, key), changes);
    return changes;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.every(isPrimitive) && after.every(isPrimitive)) {
      const beforeSet = new Set(before.map(String));
      const afterSet = new Set(after.map(String));
      const added = sortedStrings([...afterSet].filter(item => !beforeSet.has(item)));
      const removed = sortedStrings([...beforeSet].filter(item => !afterSet.has(item)));
      changes.push(added.length || removed.length ? { path: at, added, removed } : { path: at, reordered: true });
      return changes;
    }
    const beforeMap = keyedArray(before);
    const afterMap = keyedArray(after);
    if (beforeMap && afterMap) {
      for (const key of sortedStrings([...beforeMap.keys(), ...afterMap.keys()])) {
        diffValues(beforeMap.get(key), afterMap.get(key), `${at}[${key}]`, changes);
      }
      return changes;
    }
  }
  changes.push({ path: at, before: before === undefined ? null : canonicalize(before), after: after === undefined ? null : canonicalize(after) });
  return changes;
}

function diffSection(before, after) {
  const result = { added: [], removed: [], changed: [] };
  if (!before || !after) {
    result.status = { before: before?.status ?? 'missing', after: after?.status ?? 'missing' };
    return result;
  }
  if (before.status !== after.status) result.status = { before: before.status, after: after.status };
  if (before.status !== 'captured' || after.status !== 'captured') return result;
  result.changed.push(...diffValues(before.selection ?? null, after.selection ?? null, 'selection'));
  const beforeData = before.data;
  const afterData = after.data;
  const beforeMap = Array.isArray(beforeData) ? keyedArray(beforeData) : null;
  const afterMap = Array.isArray(afterData) ? keyedArray(afterData) : null;
  if (Array.isArray(beforeData) && Array.isArray(afterData) && (beforeMap || !beforeData.length) && (afterMap || !afterData.length)) {
    const b = beforeMap ?? new Map();
    const a = afterMap ?? new Map();
    for (const key of sortedStrings([...b.keys(), ...a.keys()])) {
      if (!b.has(key)) result.added.push(key);
      else if (!a.has(key)) result.removed.push(key);
      else {
        const changes = diffValues(b.get(key), a.get(key));
        if (changes.length) result.changed.push({ key, changes });
      }
    }
    return result;
  }
  if (Array.isArray(beforeData) && Array.isArray(afterData) && beforeData.every(isPrimitive) && afterData.every(isPrimitive)) {
    const [change] = diffValues(beforeData, afterData);
    if (change?.added) { result.added.push(...change.added); result.removed.push(...change.removed); }
    else if (change) result.changed.push(change);
    return result;
  }
  result.changed.push(...diffValues(beforeData, afterData));
  return result;
}

const sectionHasDifference = diff => Boolean(diff.status || diff.added.length || diff.removed.length || diff.changed.length);

const arraySections = new Set(['agents', 'commands', 'mcp', 'toolIds', 'tools', 'skills', 'devryanSkills']);
const manifestSections = ['devryan', 'agents', 'commands', 'config', 'mcp', 'toolIds', 'tools', 'skills', 'devryanSkills', 'devryanSlim', 'slim'];

// Saved evidence has the same contract as a fresh capture. Matching failures
// are incomplete evidence, never proof that two catalogs are equivalent.
export function validateParityManifest(manifest) {
  if (!isPlainObject(manifest) || manifest.schemaVersion !== PARITY_SCHEMA_VERSION) throw new Error('unsupported parity manifest schema');
  if (!isPlainObject(manifest.runtime) || !isPlainObject(manifest.sections)) throw new Error('invalid parity manifest structure');
  const incomplete = [];
  for (const name of manifestSections) {
    const section = manifest.sections[name];
    if (!isPlainObject(section) || !['captured', 'skipped', 'error'].includes(section.status)) throw new Error(`invalid or missing parity section: ${name}`);
    if (section.status !== 'captured') {
      if (typeof section.reason !== 'string' || !section.reason) throw new Error(`invalid parity capture reason: ${name}`);
      incomplete.push(name);
      continue;
    }
    if (!(arraySections.has(name) ? Array.isArray(section.data) : isPlainObject(section.data))) throw new Error(`invalid parity section data: ${name}`);
  }
  if (manifest.sections.slim.status === 'captured') {
    const pkg = manifest.sections.slim.data.package;
    if (!isPlainObject(pkg) || !['captured', 'skipped', 'error'].includes(pkg.status)
      || (pkg.status === 'captured' ? !isPlainObject(pkg.data) : typeof pkg.reason !== 'string')) throw new Error('invalid parity Slim package evidence');
    // Static inspection is optional when no private package path was supplied;
    // a requested package that could not be read is a capture failure.
    if (pkg.status === 'error') incomplete.push('slim.package');
  }
  return { complete: incomplete.length === 0, incomplete };
}

// Runtime identity is expected to change between baseline and candidate, so it
// is reported but never counted; any section difference (including a section
// whose capture status changed) makes the manifests different.
export function diffManifests(baseline, candidate) {
  const baselineEvidence = validateParityManifest(baseline);
  const candidateEvidence = validateParityManifest(candidate);
  const header = {
    baselineRuntime: baseline.runtime ?? null,
    candidateRuntime: candidate.runtime ?? null,
    schemaVersion: { baseline: baseline.schemaVersion ?? null, candidate: candidate.schemaVersion ?? null },
  };
  const sections = {};
  const names = sortedStrings([...Object.keys(baseline.sections ?? {}), ...Object.keys(candidate.sections ?? {})]);
  for (const name of names) {
    const diff = diffSection(baseline.sections?.[name], candidate.sections?.[name]);
    if (sectionHasDifference(diff)) sections[name] = diff;
  }
  const schemaMismatch = header.schemaVersion.baseline !== header.schemaVersion.candidate;
  return canonicalize({ different: schemaMismatch || Object.keys(sections).length > 0,
    complete: baselineEvidence.complete && candidateEvidence.complete,
    evidence: { baseline: baselineEvidence, candidate: candidateEvidence }, header, sections });
}

export const serializeManifest = manifest => `${JSON.stringify(canonicalize(manifest), null, 2)}\n`;

const USAGE = `Usage:
  node scripts/qa/parity-manifest.mjs --origin <http://127.0.0.1:port> --directory <abs path> --out <file.json>
      [--qa-home <private QA home>] [--slim-package <dir>] [--expect-runtime <version>]
      [--provider <id> --model <id>] [--timeout-ms <n>]
  node scripts/qa/parity-manifest.mjs --diff <baseline.json> (--candidate <file.json> | --origin ... --directory ... [--out <file.json>])
Exit: 0 captured / no differences, 1 section capture error or differences, 2 usage or fatal error.`;

const FLAGS = new Set(['origin', 'directory', 'out', 'qa-home', 'slim-package', 'expect-runtime', 'provider', 'model', 'timeout-ms', 'diff', 'candidate']);

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    const name = arg.startsWith('--') ? arg.slice(2) : null;
    if (!name || !FLAGS.has(name)) throw new Error(`Unknown argument ${JSON.stringify(arg)}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    if (options[name] !== undefined) throw new Error(`--${name} given more than once`);
    options[name] = value;
    index += 1;
  }
  if ((options.provider === undefined) !== (options.model === undefined)) throw new Error('--provider and --model must be given together');
  if (options['timeout-ms'] !== undefined && !(Number.parseInt(options['timeout-ms'], 10) > 0)) throw new Error('--timeout-ms must be a positive integer');
  if (options.candidate !== undefined && options.diff === undefined) throw new Error('--candidate requires --diff');
  if (options.candidate !== undefined && options.origin !== undefined) throw new Error('--candidate and --origin are exclusive');
  if (options.diff === undefined || options.candidate === undefined) {
    if (!options.origin || !options.directory) throw new Error('--origin and --directory are required to capture');
    if (options.diff === undefined && !options.out) throw new Error('--out is required to capture');
  }
  return options;
}

const readJson = async (file) => {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    throw new Error(`Cannot read manifest ${file}: ${error.code || error.name}`);
  }
};

export async function main(argv = process.argv.slice(2), { fetchImpl = globalThis.fetch, stdout = process.stdout, stderr = process.stderr, env = process.env, now } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.help) { stdout.write(`${USAGE}\n`); return 0; }
  try {
    let candidate;
    // The baseline is read before anything is written, so `--diff X --out X`
    // can never overwrite the baseline and then compare the candidate to itself.
    const baseline = options.diff ? await readJson(options.diff) : null;
    if (baseline) validateParityManifest(baseline);
    if (options.candidate) {
      candidate = await readJson(options.candidate);
    } else {
      candidate = await captureParityManifest({
        origin: options.origin,
        directory: options.directory,
        fetchImpl,
        env,
        now,
        expectRuntime: options['expect-runtime'],
        qaHome: options['qa-home'] ?? stringOrNull(env.DEVRYAN_QA_HOME) ?? undefined,
        slimPackage: options['slim-package'],
        provider: options.provider,
        model: options.model,
        timeoutMs: options['timeout-ms'] ? Number.parseInt(options['timeout-ms'], 10) : DEFAULT_TIMEOUT_MS,
      });
      if (options.out) {
        await mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
        await writeFile(options.out, serializeManifest(candidate), { mode: 0o600 });
      }
    }
    const evidence = validateParityManifest(candidate);
    for (const name of evidence.incomplete) {
      const entry = name === 'slim.package' ? candidate.sections.slim.data.package : candidate.sections[name];
      stderr.write(`parity-manifest: ${name} capture failed: ${entry.reason}\n`);
    }
    if (!options.diff) {
      if (!options.out) stdout.write(serializeManifest(candidate));
      return evidence.complete ? 0 : 1;
    }
    const diff = diffManifests(baseline, candidate);
    stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
    return diff.different || !diff.complete ? 1 : 0;
  } catch (error) {
    stderr.write(`parity-manifest: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
