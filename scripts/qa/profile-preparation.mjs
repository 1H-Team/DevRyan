import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEVRYAN_MANAGED_PROFILE_PLUGIN_FILES, getDevRyanManagedPluginForFile, getDevRyanManagedPluginForSpec, isDevRyanManagedLegacyPluginSpec } from '../../packages/web/server/lib/opencode/managed-plugins.js';
import { qaPlatformEnvironment } from './launch-environment.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const allowedProviders = ['openai', 'anthropic', 'xai'];
const managedSpecialistProviders = [...allowedProviders, 'opencode'];
const preservedProviders = [...managedSpecialistProviders, 'opencode-go', 'cursor-acp'];
const homeShim = fileURLToPath(new URL('./isolated-home.mjs', import.meta.url));
const providerObserver = fileURLToPath(new URL('./provider-observer.mjs', import.meta.url));

const writePrivateJson = async (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const isInside = (parent, child) => child.startsWith(`${parent}${path.sep}`);
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const canonicalFuturePath = async (target) => {
    try { return await realpath(target); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(target);
        if (parent === target) throw error;
        return path.join(await canonicalFuturePath(parent), path.basename(target));
    }
};

const ensurePrivateTreeLinks = async (directory, ownedRoot, label) => {
    const root = await realpath(ownedRoot);
    const visited = new Set();
    const visit = async (current) => {
        let resolved;
        try { resolved = await realpath(current); }
        catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ELOOP') throw new Error(`QA ${label} contains an unresolved symlink`);
            throw error;
        }
        if (resolved !== root && !isInside(root, resolved)) throw new Error(`QA ${label} contains a symlink outside its private installation`);
        if (visited.has(resolved)) return;
        visited.add(resolved);
        if (!(await lstat(resolved)).isDirectory()) return;
        for (const entry of await readdir(resolved, { withFileTypes: true })) {
            if (entry.isDirectory() || entry.isSymbolicLink()) await visit(path.join(resolved, entry.name));
        }
    };
    await visit(directory);
};

const hashFile = async (file) => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
};

// OpenCode's read/grep/skill tools need ripgrep, which it otherwise downloads
// lazily into XDG_CACHE_HOME/opencode/bin. A private profile has an empty
// cache, and a failed download leaves those tools broken ("ripgrep execution
// failed"), so reuse the user's installed copy when one exists.
export const provisionQaRipgrep = async ({ sourceHome, cacheHome }) => {
    const source = path.join(sourceHome, '.cache/opencode/bin/rg');
    let sha256;
    try { sha256 = await hashFile(source); }
    catch (error) {
        if (error.code === 'ENOENT') return { state: 'not-installed' };
        throw error;
    }
    const targetDirectory = path.join(cacheHome, 'opencode/bin');
    await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    await cp(source, path.join(targetDirectory, 'rg'), { mode: constants.COPYFILE_FICLONE });
    return { state: 'copied', sha256 };
};

export const projectQaAuth = (auth, now = Date.now(), providerIds = allowedProviders, { preserveOrchestration = false } = {}) => {
    if (!Array.isArray(providerIds) || providerIds.some(id => !(preserveOrchestration ? preservedProviders : managedSpecialistProviders).includes(id))) {
        throw new Error('QA credential projection requires explicit supported providers');
    }
    const records = {};
    const evidence = {};
    for (const provider of new Set(providerIds)) {
        const record = auth?.[provider];
        if (record?.type === 'api' && typeof record.key === 'string' && record.key) {
            records[provider] = { type: 'api', key: record.key };
            evidence[provider] = { state: 'available', type: 'api' };
        } else if (record?.type === 'oauth' && typeof record.access === 'string' && record.access && Number.isFinite(record.expires)) {
            if (record.expires <= now + 120_000) {
                evidence[provider] = { state: 'unavailable', reason: 'access_token_expired_or_near_expiry', expires: record.expires };
                continue;
            }
            // OpenCode expects the OAuth shape; empty refresh cannot rotate the
            // user's token. The original refresh credential never leaves its owner.
            records[provider] = { type: 'oauth', access: record.access, refresh: '', expires: record.expires,
                ...(typeof record.accountId === 'string' ? { accountId: record.accountId } : {}) };
            evidence[provider] = { state: 'available', type: 'oauth-access-only', expires: record.expires };
        } else evidence[provider] = { state: 'unavailable', reason: 'no_supported_auth_record' };
    }
    return { records, evidence };
};

export const assertQaSelectedProviderAccess = (providerId, evidence) => {
    if (evidence?.[providerId]?.state !== 'available') {
        throw new Error(`QA ${providerId} access is unavailable or near expiry; renew access through its canonical owner before live QA`);
    }
    if (providerId === 'anthropic' && evidence.anthropic.type !== 'claude-cli-access-only') {
        throw new Error('QA Anthropic requires unexpired access-only Claude credentials; implicit Meridian credential fallback is disabled');
    }
};

// Admission uses the credentials actually copied into this fresh profile.
// Other providers and historical metadata cannot admit the selected provider.
export const assertQaSelectedProviderDuration = (providerId, evidence, timeoutMs, now = Date.now()) => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(now) || now < 0) {
        throw new Error('QA credential admission requires a positive timeout and a valid current timestamp');
    }
    assertQaSelectedProviderAccess(providerId, evidence);
    const credential = evidence[providerId];
    const marginMs = 600_000;
    // API keys have no expiry contract; retain their existing supported access
    // without implying that a credential lifetime has been verified.
    if (credential.type === 'api') {
        return { providerId, checkedAt: now, timeoutMs, marginMs, expiryCheck: 'not-applicable-to-api-key' };
    }
    const expires = credential.expires;
    const requiredUntil = now + timeoutMs + marginMs;
    if (!Number.isSafeInteger(requiredUntil) || !Number.isFinite(expires) || expires < requiredUntil) {
        throw new Error(`QA ${providerId} copied access does not cover its ${timeoutMs}ms timeout plus ${marginMs}ms margin (expires: ${Number.isFinite(expires) ? expires : 'unknown'}, required: ${requiredUntil}); renew access through its canonical owner before live QA`);
    }
    return { providerId, checkedAt: now, expires, timeoutMs, marginMs, requiredUntil, remainingMs: expires - now, expiryCheck: 'passed' };
};

const validateQaAgentAssignments = (assignments, providerId, allowCrossProviderAssignments = false) => {
    if (typeof allowCrossProviderAssignments !== 'boolean') throw new Error('QA cross-provider assignments must be explicitly enabled');
    if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) {
        throw new Error('QA specialist assignments must be an object');
    }
    const specialists = new Set(['oracle', 'council', 'fixer', 'designer', 'explorer', 'librarian']);
    if (allowCrossProviderAssignments) specialists.add('builder');
    for (const [name, selection] of Object.entries(assignments)) {
        if (!specialists.has(name) || !selection || typeof selection !== 'object' || Array.isArray(selection)
            || Object.keys(selection).some(key => !['providerId', 'modelId', 'variant'].includes(key))
            || (!allowCrossProviderAssignments && selection.providerId !== providerId)
            || !(allowCrossProviderAssignments ? managedSpecialistProviders : allowedProviders).includes(selection.providerId)
            || typeof selection.modelId !== 'string' || !selection.modelId.trim() || selection.modelId !== selection.modelId.trim()
            || selection.modelId.includes('/') || (selection.variant !== null
                && (typeof selection.variant !== 'string' || !selection.variant.trim() || selection.variant !== selection.variant.trim()))) {
            throw new Error('QA specialist assignments require a known specialist, an admitted provider, a model ID and explicit null or nonempty effort');
        }
    }
};

export const pinQaAgents = (slim, { providerId, modelId, variant, agentAssignments = {}, allowCrossProviderAssignments = false }) => {
    validateQaAgentAssignments(agentAssignments, providerId, allowCrossProviderAssignments);
    if (Array.isArray(slim.disabled_agents) && Object.keys(agentAssignments).some(name => slim.disabled_agents.includes(name))) {
        throw new Error('QA specialist assignments cannot pin a disabled agent');
    }
    const model = `${providerId}/${modelId}`;
    const agentNames = new Set(['builder', 'orchestrator', 'oracle', 'council', 'fixer', 'designer', 'explorer', 'librarian', ...Object.keys(slim.agents ?? {})]);
    const agents = Object.fromEntries([...agentNames].map((name) => {
        const previous = slim.agents?.[name] ?? {};
        const { variant: _oldVariant, modelRefs: _modelRefs, councillors: _councillors, ...rest } = previous;
        const selection = Object.hasOwn(agentAssignments, name) ? agentAssignments[name] : null;
        const effectiveModel = selection ? `${selection.providerId}/${selection.modelId}` : model;
        const effectiveVariant = selection ? selection.variant : variant;
        return [name, { ...rest, model: effectiveModel, ...(typeof effectiveVariant === 'string' ? { variant: effectiveVariant } : {}) }];
    }));
    return { ...slim, preset: 'qa', presets: { qa: agents }, agents };
};

// This opt-in preserves the model graph and recovery inputs. Parent selection
// is a composer choice; it must not rewrite any saved role or fallback.
export const preserveQaOrchestration = (slim, sidecar) => ({
    slim: structuredClone(slim),
    sidecar: structuredClone(Object.fromEntries(['agentOverrides', 'agentBackupModels'].flatMap(key =>
        Object.hasOwn(sidecar, key) ? [[key, sidecar[key]]] : []))),
});

export const prepareQaPluginHomeWrapper = async (entry) => {
    const original = entry.replace(/\.(m?js)$/, '.qa-original.$1');
    if (original === entry) throw new Error('QA plugin home wrapper requires an ESM JavaScript entrypoint');
    const current = await readFile(entry, 'utf8');
    // A supported source can itself be an owned QA profile. Never overwrite its
    // copied original with a wrapper that would then import itself recursively.
    const wrapperPrefix = `import ${JSON.stringify(homeShim)};\nexport * from ${JSON.stringify(`./${path.basename(original)}`)};\n`;
    if (current.startsWith(wrapperPrefix)) {
        const saved = await readFile(original, 'utf8');
        if (saved.startsWith(wrapperPrefix)) throw new Error('QA plugin original is recursively wrapped');
        return;
    }
    await cp(entry, original);
    const source = await readFile(original, 'utf8');
    const hasDefault = /export\s+default\b|export\s*\{[^}]*\bas\s+default\b/.test(source);
    await writeFile(entry, `import ${JSON.stringify(homeShim)};\nexport * from ${JSON.stringify(`./${path.basename(original)}`)};\n${hasDefault ? `export { default } from ${JSON.stringify(`./${path.basename(original)}`)};\n` : ''}`);
};

// A plugin entry is a spec string or a [spec, options] tuple.
export const qaPluginSpec = (entry) => {
    const raw = Array.isArray(entry) ? entry[0] : entry;
    return typeof raw === 'string' ? raw.trim().replace(/\\/g, '/') : '';
};

// Private package entry wrappers evaluate the same home shim before their
// actual dependencies. The compiled OpenCode executable does not honor
// NODE_OPTIONS preloads, while its own config honors OPENCODE_TEST_HOME.
// Imagegen resolves its data paths from explicit XDG variables. Keep
// imagegen's reviewed executable intact so the ordinary
// provisioning hash check remains valid when the private host boots.
export const wrapQaPackagePluginEntries = async (config, plugins) => {
    const entries = plugins.map(qaPluginSpec).filter((entry) => entry.startsWith('./node_modules/'));
    if (!entries.length) return;
    const installation = await realpath(path.join(config, 'node_modules'));
    for (const plugin of entries) {
        const entry = await realpath(path.join(config, plugin));
        if (!isInside(installation, entry)) throw new Error('QA plugin escaped the copied installation');
        if (isInside(path.join(installation, 'opencode-gpt-imagegen'), entry)) continue;
        await prepareQaPluginHomeWrapper(entry);
    }
};

const mirroredMcpModes = ['off', 'definitions', 'live'];
const mirrorOptionKeys = ['plugins', 'skills', 'mcp'];

// `true` mirrors plugins, skills and inert MCP definitions. An object names
// each part explicitly; omitted parts stay off. Mirroring copies personal
// configuration only, so it requires the user's preserved orchestration.
export const normalizeQaMirrorPersonalSetup = (value, { preserveOrchestration = false } = {}) => {
    if (value === false) return false;
    let normalized;
    if (value === true) normalized = { plugins: true, skills: true, mcp: 'definitions' };
    else if (isRecord(value) && Object.keys(value).every(key => mirrorOptionKeys.includes(key))
        && ['plugins', 'skills'].every(key => value[key] === undefined || typeof value[key] === 'boolean')
        && (value.mcp === undefined || mirroredMcpModes.includes(value.mcp))) {
        normalized = { plugins: value.plugins ?? false, skills: value.skills ?? false, mcp: value.mcp ?? 'off' };
    } else throw new Error("QA personal setup mirroring must be a boolean or { plugins?: boolean, skills?: boolean, mcp?: 'off' | 'definitions' | 'live' }");
    if (preserveOrchestration !== true) throw new Error('QA personal setup mirroring requires preserved orchestration');
    return normalized;
};

const personalCopyFilter = file => {
    const name = path.basename(file);
    return name !== '.DS_Store' && !name.includes('.devryan-slim-backup-');
};

// Provisioning writes the managed plugin files; the legacy Cursor plugin is
// retired by provisioning and must not be restored by a mirror.
const isManagedPluginFileName = name => DEVRYAN_MANAGED_PROFILE_PLUGIN_FILES.includes(name)
    || Boolean(getDevRyanManagedPluginForFile(name)) || name === 'cursor-acp.js';

export const selectQaPersonalPluginDirectoryEntries = names => names.filter(name => personalCopyFilter(name) && !isManagedPluginFileName(name));

const pluginEntryKind = spec => spec.startsWith('./node_modules/') ? 'node-modules'
    : spec.startsWith('./') || spec.startsWith('../') ? 'config-path'
        : spec.startsWith('file:') || path.isAbsolute(spec) ? 'external-path' : 'package';

// A local registration inside the source configuration is rewritten to its
// config-relative spelling so it resolves inside the private copy.
const relocatePluginSpec = (spec, sourceConfig) => {
    let file = null;
    try { file = spec.startsWith('file:') ? fileURLToPath(spec) : path.isAbsolute(spec) ? spec : null; } catch { file = null; }
    if (!file || !isInside(path.resolve(sourceConfig), path.resolve(file))) return spec;
    return `./${path.relative(path.resolve(sourceConfig), path.resolve(file)).split(path.sep).join('/')}`;
};

// Returns the source entries provisioning does not already carry. DevRyan-
// managed and retired specs are provisioning's to own; duplicates are dropped.
// Tuple options are kept in the config entry but never reported in evidence.
// A registration outside the source configuration would keep the private
// runtime reading the owner's real files, so it is refused rather than mirrored.
export const classifyQaPersonalPluginEntries = (entries, { provisioned = [], sourceConfig }) => {
    if (!Array.isArray(entries) || !Array.isArray(provisioned)) throw new Error('QA personal plugin entries must be arrays');
    const seen = new Set(provisioned.map(qaPluginSpec).filter(Boolean));
    const personal = [];
    const managed = [];
    const ordered = [];
    for (const entry of entries) {
        const original = qaPluginSpec(entry);
        if (!original || (Array.isArray(entry) && entry.length > 2)) throw new Error('QA personal plugin entries must be specs or [spec, options] tuples');
        const spec = relocatePluginSpec(original, sourceConfig);
        const managedPlugin = getDevRyanManagedPluginForSpec(spec);
        if (managedPlugin || isDevRyanManagedLegacyPluginSpec(spec)) {
            managed.push(spec);
            if (managedPlugin) ordered.push({ kind: 'managed', spec, plugin: managedPlugin });
            continue;
        }
        if (seen.has(spec)) continue;
        seen.add(spec);
        const kind = pluginEntryKind(spec);
        if (kind === 'external-path') throw new Error(`QA mirrored plugin entry ${spec} points outside the owner's OpenCode configuration and cannot be isolated`);
        const item = { entry: Array.isArray(entry) ? [spec, ...entry.slice(1)] : spec, spec, kind, hasOptions: Array.isArray(entry) && entry.length > 1 };
        personal.push(item);
        ordered.push({ kind: 'personal', spec, item });
    }
    return { personal, managed, ordered };
};

// Plugin load order is part of the owner's effective setup (hooks run in
// registration order), so the mirrored list follows the source order:
// managed entries take their provisioned spelling, personal entries keep
// their place, and provisioned entries the owner never listed come last.
export const orderQaMirroredPlugins = (provisioned, ordered) => {
    const byManaged = new Map();
    for (const entry of provisioned) {
        const plugin = getDevRyanManagedPluginForSpec(qaPluginSpec(entry));
        if (plugin && !byManaged.has(plugin)) byManaged.set(plugin, entry);
    }
    const placed = new Set();
    const merged = [];
    for (const slot of ordered) {
        if (slot.kind === 'personal') { merged.push(slot.item.entry); continue; }
        const entry = byManaged.get(slot.plugin);
        if (entry === undefined || placed.has(entry)) continue;
        placed.add(entry);
        merged.push(entry);
    }
    for (const entry of provisioned) if (!placed.has(entry)) { placed.add(entry); merged.push(entry); }
    return merged;
};

// 'definitions' keeps every server visible to catalogs but disabled, so no
// external connection or OAuth flow starts. Auth state is never copied.
export const buildQaMirroredMcp = (sourceMcp, mode) => {
    if (!mirroredMcpModes.includes(mode)) throw new Error('QA MCP mirroring mode must be off, definitions or live');
    if (sourceMcp !== undefined && !isRecord(sourceMcp)) throw new Error('QA personal MCP configuration must be an object');
    if (mode === 'off') return { config: {}, evidence: [] };
    const config = {};
    const evidence = [];
    for (const [id, definition] of Object.entries(sourceMcp ?? {})) {
        if (!isRecord(definition)) throw new Error('QA personal MCP definitions must be objects');
        const sourceEnabled = definition.enabled !== false;
        config[id] = mode === 'definitions' ? { ...structuredClone(definition), enabled: false } : structuredClone(definition);
        evidence.push({ id, type: typeof definition.type === 'string' ? definition.type : null, sourceEnabled, enabled: mode === 'live' && sourceEnabled });
    }
    return { config, evidence };
};

// Copies a personal tree, following only a symlinked root. Returns the number
// of top-level entries copied, or null when the source root is absent.
const copyPersonalTree = async (source, target) => {
    let root;
    let names;
    try { root = await realpath(source); names = await readdir(root); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await cp(root, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, filter: personalCopyFilter });
    return names.filter(personalCopyFilter).length;
};

export const qaPersonalSkillRoots = Object.freeze(['.config/opencode/skills', '.claude/skills', '.agents/skills']);
const pluginDirectoryNames = ['plugins', 'plugin'];

export const emptyQaMirrorEvidence = requested => ({ requested, plugins: [], pluginDirectories: [], skills: {}, commands: null, mcp: [], configKeys: [] });

// Mirrors the owner's personal plugins, skills, MCP definitions, built-in agent
// overrides and commands into the private profile. Sources are only read.
// `lsp` stays owned by the managed overlay and is never mirrored.
export const mirrorQaPersonalSetup = async ({ options, sourceHome, home, config, sourceConfigs, provisioned }) => {
    const sourceConfig = path.join(sourceHome, '.config/opencode');
    const evidence = emptyQaMirrorEvidence(options);
    const basePlugins = Array.isArray(provisioned.plugin) ? provisioned.plugin : [];
    const copiedTrees = [];
    let plugin = basePlugins;
    if (options.plugins) {
        const entries = sourceConfigs.flatMap((value) => {
            if (value.plugin !== undefined && !Array.isArray(value.plugin)) throw new Error('QA personal plugin entries must be arrays');
            return value.plugin ?? [];
        });
        const { personal, ordered } = classifyQaPersonalPluginEntries(entries, { provisioned: basePlugins, sourceConfig });
        plugin = orderQaMirroredPlugins(basePlugins, ordered);
        evidence.plugins = personal.map(({ spec, kind, hasOptions }) => ({ entry: spec, kind, hasOptions }));
        evidence.pluginOrder = plugin.map(qaPluginSpec);
        if (personal.length) evidence.configKeys.push('plugin');
        for (const directory of pluginDirectoryNames) {
            let dirents;
            try { dirents = await readdir(path.join(sourceConfig, directory), { withFileTypes: true }); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            const selected = new Set(selectQaPersonalPluginDirectoryEntries(dirents.map(item => item.name)));
            for (const item of dirents.filter(candidate => selected.has(candidate.name)).sort((a, b) => a.name.localeCompare(b.name))) {
                await mkdir(path.join(config, directory), { recursive: true, mode: 0o700 });
                await cp(path.join(sourceConfig, directory, item.name), path.join(config, directory, item.name), {
                    recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, filter: personalCopyFilter });
                evidence.pluginDirectories.push({ directory, name: item.name,
                    type: item.isSymbolicLink() ? 'symlink' : item.isDirectory() ? 'directory' : 'file' });
                copiedTrees.push(path.join(config, directory, item.name));
            }
        }
        // Only node_modules and the plugin directories are copied. A local
        // registration elsewhere would silently diverge from the owner's setup.
        for (const { spec, kind } of personal.filter(item => item.kind === 'config-path' || item.kind === 'node-modules')) {
            const entry = path.resolve(config, spec);
            const roots = (kind === 'node-modules' ? ['node_modules'] : pluginDirectoryNames).map(directory => path.resolve(config, directory));
            let present = roots.some(root => isInside(root, entry));
            if (present) {
                try {
                    const resolved = await realpath(entry);
                    const canonicalRoots = await Promise.all(roots.map(canonicalFuturePath));
                    present = canonicalRoots.some(root => isInside(root, resolved));
                }
                catch (error) { if (error.code !== 'ENOENT') throw error; present = false; }
            }
            if (!present) throw new Error(`QA mirrored plugin entry ${spec} is outside the copied plugin directories`);
        }
    }
    if (options.skills) {
        for (const root of qaPersonalSkillRoots) {
            evidence.skills[root] = await copyPersonalTree(path.join(sourceHome, root), path.join(home, root));
            if (evidence.skills[root] !== null) copiedTrees.push(path.join(home, root));
        }
    }
    const mcp = buildQaMirroredMcp(Object.assign({}, ...sourceConfigs.map(value => value.mcp ?? {})), options.mcp);
    evidence.mcp = mcp.evidence;
    if (options.mcp !== 'off' && mcp.evidence.length) evidence.configKeys.push('mcp');
    // Provisioning gives its managed built-in agent entries precedence over the
    // owner's; the mirror applies the same merge the owner's profile received.
    const sourceAgents = sourceConfigs.filter(value => isRecord(value.agent));
    const agent = sourceAgents.length
        ? { ...structuredClone(Object.assign({}, ...sourceAgents.map(value => value.agent))), ...(isRecord(provisioned.agent) ? provisioned.agent : {}) }
        : undefined;
    if (agent) evidence.configKeys.push('agent');
    evidence.commands = await copyPersonalTree(path.join(sourceConfig, 'commands'), path.join(config, 'commands'));
    if (evidence.commands !== null) {
        evidence.configKeys.push('commands');
        copiedTrees.push(path.join(config, 'commands'));
    }
    // Check after all copies so relative aliases between copied trees still
    // work. Never publish registrations while a descendant can reach the owner.
    for (const tree of copiedTrees) await ensurePrivateTreeLinks(tree, home, 'personal setup copy');
    return { plugin, agent, mcp: mcp.config, evidence };
};

// Inherited overrides that relocate Meridian or Claude state. The owned values
// below replace the directories; any other relocation would escape the profile.
const inheritedStatePathKey = key => /^(MERIDIAN|CLAUDE)_(\w+_)?(DIR|PATH|CONFIG|DB|FILE|HOME|INSTANCES)$/.test(key);

// Meridian runs inside the compiled Bun OpenCode host. Bun resolves named
// `homedir` imports from HOME at process start, so the preload shim cannot
// redirect them: Meridian 1.62.x derives oauth-token profile directories
// (CLAUDE_CONFIG_DIR) and its state from homedir(). HOME is therefore owned in
// this launch environment; the shim still never mutates it inside a process.
export const createQaLaunchEnvironment = ({ runtimeRoot, home, opencodeBinary, baseEnvironment = process.env }) => {
    const data = path.join(home, '.config/openchamber');
    const env = qaPlatformEnvironment(baseEnvironment);
    for (const key of Object.keys(env)) if (inheritedStatePathKey(key)) delete env[key];
    Object.assign(env, { DEVRYAN_QA_RUNTIME_ROOT: runtimeRoot, DEVRYAN_QA_HOME: home,
        HOME: home, OPENCODE_TEST_HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'),
        XDG_CACHE_HOME: path.join(home, '.cache'), TMPDIR: path.join(home, 'tmp'),
        // One content-addressed package cache shared by every QA home (was ~115 MB per home).
        BUN_INSTALL_CACHE_DIR: path.join(repositoryRoot, '.cache/shared/bun-install-cache'),
        OPENCHAMBER_DATA_DIR: data, OPENCHAMBER_ELECTRON_USER_DATA_DIR: path.join(runtimeRoot, 'browser-profile'),
        OPENCHAMBER_DIST_DIR: path.join(repositoryRoot, 'packages/web/dist'), OPENCHAMBER_ELECTRON_DEV: '1',
        OPENCODE_BINARY: opencodeBinary, CLAUDE_PROXY_PORT: '0',
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        MERIDIAN_CONFIG_DIR: path.join(home, '.config/meridian'), MERIDIAN_SESSION_DIR: path.join(home, '.cache/meridian'),
        NODE_OPTIONS: `--import=${JSON.stringify(homeShim)}`,
        NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' });
    for (const key of ['OPENCODE_HOST', 'OPENCODE_PORT', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_SKIP_START', 'OPENCHAMBER_SKIP_OPENCODE_START', 'OPENCHAMBER_SERVER_URL', 'ELECTRON_RUN_AS_NODE', 'OH_MY_OPENCODE_SLIM_PRESET', 'MERIDIAN_PROFILES', 'MERIDIAN_DEFAULT_PROFILE', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[key];
    // Native OpenCode loads inline config after global/project/managed config.
    // This test-only observer therefore sees final plugin reasoning controls.
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ plugin: [pathToFileURL(providerObserver).href] });
    return env;
};

// Every location Meridian or Claude derives from this launch environment,
// including the HOME-derived defaults Meridian uses without an override.
export const qaMeridianClaudePaths = (env) => {
    const profileId = env.MERIDIAN_DEFAULT_PROFILE ?? 'qa';
    const paths = { HOME: env.HOME,
        'homedir:.claude': path.join(env.HOME ?? '', '.claude'),
        'homedir:.claude.json': path.join(env.HOME ?? '', '.claude.json'),
        'homedir:meridian-config': path.join(env.HOME ?? '', '.config/meridian'),
        'homedir:meridian-profile': path.join(env.HOME ?? '', '.config/meridian/profiles', profileId),
        'homedir:meridian-cache': path.join(env.HOME ?? '', '.cache/meridian'),
        'MERIDIAN_CONFIG_DIR:profile': path.join(env.MERIDIAN_CONFIG_DIR ?? '', 'profiles', profileId) };
    for (const [key, value] of Object.entries(env)) if (inheritedStatePathKey(key)) paths[key] = value;
    return paths;
};

// `executables` names keys that select a program (e.g. MERIDIAN_CLAUDE_PATH),
// not a state location; they must still be absolute but may live outside.
export const assertQaLaunchEnvironmentOwned = (env, ownedBase, { executables = [] } = {}) => {
    const base = path.resolve(ownedBase);
    for (const [name, value] of Object.entries(qaMeridianClaudePaths(env))) {
        if (executables.includes(name)) {
            if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`QA executable ${name} must be an absolute path`);
            continue;
        }
        const resolved = typeof value === 'string' && path.isAbsolute(value) ? path.resolve(value) : null;
        if (!resolved || (resolved !== base && !isInside(base, resolved))) {
            throw new Error(`QA Meridian/Claude path ${name} must resolve inside the owned QA root`);
        }
    }
};

// Live profile preparation is owned by native-profile-factory/preparation.
// These older data/SDK helpers remain reusable without launching a runtime.
export async function prepareQaProfile() {
    throw Object.assign(new Error('Legacy QA profile preparation is retired; use constructor-owned native preparation'), { code: 'qa_native_diagnostic_unavailable' });
}
