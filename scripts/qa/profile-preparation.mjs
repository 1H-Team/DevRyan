import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { cp, mkdir, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createUserProfileProvisioningRuntime } from '../../packages/web/server/lib/opencode/user-profile-provisioning.js';
import { isRuntimePluginFileName } from '../../packages/web/server/lib/opencode/default-config-assets.js';

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const { parse: parseJsonc } = createRequire(new URL('../../packages/web/package.json', import.meta.url))('jsonc-parser');
const allowedProviders = ['openai', 'anthropic', 'xai'];
const homeShim = fileURLToPath(new URL('./isolated-home.mjs', import.meta.url));
const providerObserver = fileURLToPath(new URL('./provider-observer.mjs', import.meta.url));

const readOptionalJson = async (file) => {
    try { return parseJsonc(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Unable to read a QA source configuration'); }
};
const writePrivateJson = async (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const isInside = (parent, child) => child.startsWith(`${parent}${path.sep}`);

const canonicalFuturePath = async (target) => {
    try { return await realpath(target); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(target);
        if (parent === target) throw error;
        return path.join(await canonicalFuturePath(parent), path.basename(target));
    }
};

const validateOwnedPaths = async (runtimeRoot, workspace, cacheRoot) => {
    const canonicalRepository = await realpath(repositoryRoot);
    const canonicalCache = await canonicalFuturePath(cacheRoot);
    const [canonicalRuntime, canonicalWorkspace] = await Promise.all([canonicalFuturePath(runtimeRoot), realpath(workspace)]);
    if (!isInside(canonicalRepository, canonicalCache) || !isInside(canonicalCache, canonicalRuntime)
        || !isInside(canonicalCache, canonicalWorkspace)) throw new Error('QA paths must resolve inside this repository cache');
    let gitRoot;
    try {
        const { stdout } = await execute('git', ['-C', canonicalWorkspace, 'rev-parse', '--show-toplevel'], { timeout: 5_000, maxBuffer: 64 * 1024 });
        gitRoot = await realpath(stdout.trim());
    } catch { throw new Error('QA workspace must be its own Git repository root'); }
    // A directory nested in DevRyan without its own Git root would inherit the
    // user's project config. Disabling project config also disables AGENTS.md.
    if (gitRoot !== canonicalWorkspace) throw new Error('QA workspace must be its own Git repository root');
};

const hashFile = async (file) => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
};

const installedFingerprints = async (config, plugins, opencodeBinary) => {
    const manifest = await readOptionalJson(path.join(config, 'package.json'));
    const packageNames = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.overrides ?? {}), '@opencode-ai/sdk']);
    const packages = Object.fromEntries(await Promise.all([...packageNames].sort().map(async (name) => {
        const installed = await readOptionalJson(path.join(config, 'node_modules', name, 'package.json'));
        return [name, typeof installed.version === 'string' ? installed.version : null];
    })));
    const pluginEntries = await Promise.all(plugins.map(async (plugin) => {
        const entry = path.resolve(config, plugin);
        const original = entry.replace(/\.(m?js)$/, '.qa-original.$1');
        let originalSha256 = null;
        try { originalSha256 = await hashFile(original); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        return { entry: plugin, sha256: await hashFile(entry), originalSha256 };
    }));
    const packagedRoot = path.join(repositoryRoot, 'packages/web/server/default-config/plugins');
    const packagedEntries = (await readdir(packagedRoot, { withFileTypes: true })).filter((entry) => entry.isFile() && isRuntimePluginFileName(entry.name));
    const packagedPluginSources = await Promise.all(packagedEntries.sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => ({
        entry: path.relative(repositoryRoot, path.join(packagedRoot, entry.name)), sha256: await hashFile(path.join(packagedRoot, entry.name)),
    })));
    return { packages, pluginEntries, packagedPluginSources, binary: { sha256: await hashFile(opencodeBinary) },
        observer: { entry: 'scripts/qa/provider-observer.mjs', sha256: await hashFile(providerObserver), configStage: 'final-inline-config' },
        adapters: { openai: 'devryan-managed-openai-http-oauth', anthropic: 'opencode-with-claude-meridian-claude-sdk', xai: 'native-opencode-xai' },
        source: 'prepared-private-installation; effective request metadata is recorded separately' };
};

export const projectQaAuth = (auth, now = Date.now()) => {
    const records = {};
    const evidence = {};
    for (const provider of allowedProviders) {
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

const validateQaAgentAssignments = (assignments, providerId) => {
    if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) {
        throw new Error('QA specialist assignments must be an object');
    }
    const specialists = new Set(['oracle', 'council', 'fixer', 'designer', 'explorer', 'librarian']);
    for (const [name, selection] of Object.entries(assignments)) {
        if (!specialists.has(name) || !selection || typeof selection !== 'object' || Array.isArray(selection)
            || Object.keys(selection).some(key => !['providerId', 'modelId', 'variant'].includes(key))
            || selection.providerId !== providerId || !allowedProviders.includes(selection.providerId)
            || typeof selection.modelId !== 'string' || !selection.modelId.trim() || selection.modelId !== selection.modelId.trim()
            || selection.modelId.includes('/') || (selection.variant !== null
                && (typeof selection.variant !== 'string' || !selection.variant.trim() || selection.variant !== selection.variant.trim()))) {
            throw new Error('QA specialist assignments require a known specialist, the primary provider, a model ID and explicit null or nonempty effort');
        }
    }
};

export const pinQaAgents = (slim, { providerId, modelId, variant, agentAssignments = {} }) => {
    validateQaAgentAssignments(agentAssignments, providerId);
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

const readClaudeAccess = async (sourceHome) => {
    let credentials;
    try {
        const data = await readFile(path.join(sourceHome, '.claude', '.credentials.json'), 'utf8');
        credentials = JSON.parse(data);
    } catch (error) {
        if (error.code !== 'ENOENT') return null;
        if (process.platform !== 'darwin') return null;
        try {
            const { stdout } = await execute('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-a', os.userInfo().username, '-w'], { timeout: 5_000, maxBuffer: 1024 * 1024 });
            try { credentials = JSON.parse(stdout.trim()); }
            catch { credentials = JSON.parse(Buffer.from(stdout.trim(), 'hex').toString('utf8')); }
        } catch { return null; }
    }
    const oauth = credentials?.claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken || !Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= Date.now() + 120_000) return null;
    return { access: oauth.accessToken, expires: oauth.expiresAt };
};

const ensurePrivateDependencyLinks = async (directory) => {
    const root = await realpath(directory);
    const visit = async (current) => {
        for (const entry of await readdir(current, { withFileTypes: true })) {
            const target = path.join(current, entry.name);
            if (entry.isDirectory()) await visit(target);
            else if (entry.isSymbolicLink()) {
                const resolved = await realpath(target);
                if (!isInside(root, resolved)) throw new Error('QA dependency copy contains a symlink outside its private installation');
            }
        }
    };
    await visit(root);
};

export const prepareQaPluginHomeWrapper = async (entry) => {
    const original = entry.replace(/\.(m?js)$/, '.qa-original.$1');
    if (original === entry) throw new Error('QA plugin home wrapper requires an ESM JavaScript entrypoint');
    await cp(entry, original);
    const source = await readFile(original, 'utf8');
    const hasDefault = /export\s+default\b|export\s*\{[^}]*\bas\s+default\b/.test(source);
    await writeFile(entry, `import ${JSON.stringify(homeShim)};\nexport * from ${JSON.stringify(`./${path.basename(original)}`)};\n${hasDefault ? `export { default } from ${JSON.stringify(`./${path.basename(original)}`)};\n` : ''}`);
};

export async function prepareQaProfile({ runtimeRoot, workspace, providerId, modelId, variant = null, agentAssignments = {},
    sourceHome = os.homedir(), opencodeBinary = path.join(repositoryRoot, '.cache/qa/opencode-1.18.29/package/bin/opencode') }) {
    const cacheRoot = path.join(repositoryRoot, '.cache');
    if (!path.isAbsolute(runtimeRoot) || !isInside(cacheRoot, path.resolve(runtimeRoot))) throw new Error('QA runtime root must be inside this repository cache');
    if (!path.isAbsolute(workspace) || !isInside(cacheRoot, path.resolve(workspace))) throw new Error('QA workspace must be inside this repository cache');
    if (!allowedProviders.includes(providerId) || typeof modelId !== 'string' || !modelId.trim() || modelId.includes('/')) throw new Error('QA model must use OpenAI, Anthropic, or xAI');
    if (variant !== null && (typeof variant !== 'string' || !variant.trim())) throw new Error('QA thinking must be null or a nonempty variant');
    validateQaAgentAssignments(agentAssignments, providerId);
    await validateOwnedPaths(runtimeRoot, workspace, cacheRoot);
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const home = path.join(runtimeRoot, 'home');
    await mkdir(home, { mode: 0o700 });
    await writeFile(path.join(home, '.devryan-qa-home'), 'owned QA home\n', { flag: 'wx', mode: 0o600 });
    const config = path.join(home, '.config/opencode');
    const data = path.join(home, '.config/openchamber');
    const authDirectory = path.join(home, '.local/share/opencode');
    const sourceConfig = path.join(sourceHome, '.config/opencode');
    const env = { ...process.env, DEVRYAN_QA_RUNTIME_ROOT: runtimeRoot, DEVRYAN_QA_HOME: home,
        OPENCODE_TEST_HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'),
        XDG_CACHE_HOME: path.join(home, '.cache'), TMPDIR: path.join(home, 'tmp'),
        BUN_INSTALL_CACHE_DIR: path.join(home, '.cache/bun'),
        OPENCHAMBER_DATA_DIR: data, OPENCHAMBER_ELECTRON_USER_DATA_DIR: path.join(runtimeRoot, 'browser-profile'),
        OPENCHAMBER_DIST_DIR: path.join(repositoryRoot, 'packages/web/dist'), OPENCHAMBER_ELECTRON_DEV: '1',
        OPENCODE_BINARY: opencodeBinary, CLAUDE_PROXY_PORT: '0',
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        NODE_OPTIONS: `--import=${JSON.stringify(homeShim)}`,
        NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' };
    for (const key of ['OPENCODE_HOST', 'OPENCODE_PORT', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_SKIP_START', 'OPENCHAMBER_SKIP_OPENCODE_START', 'OPENCHAMBER_SERVER_URL', 'ELECTRON_RUN_AS_NODE', 'OH_MY_OPENCODE_SLIM_PRESET', 'MERIDIAN_PROFILES', 'MERIDIAN_DEFAULT_PROFILE', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[key];
    // Native OpenCode loads inline config after global/project/managed config.
    // This test-only observer therefore sees final plugin reasoning controls.
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ plugin: [pathToFileURL(providerObserver).href] });
    await Promise.all([config, data, authDirectory, env.TMPDIR, env.XDG_CACHE_HOME, env.CLAUDE_CONFIG_DIR].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
    await cp(path.join(sourceConfig, 'node_modules'), path.join(config, 'node_modules'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    await ensurePrivateDependencyLinks(path.join(config, 'node_modules'));
    await cp(path.join(sourceConfig, 'package.json'), path.join(config, 'package.json'));
    for (const lockfile of ['bun.lock', 'bun.lockb']) {
        try { await cp(path.join(sourceConfig, lockfile), path.join(config, lockfile)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const provisioning = await createUserProfileProvisioningRuntime({
        homedir: () => home, configDirectory: config, configRoot: path.join(repositoryRoot, 'packages/web/server/default-config'),
        profileRoot: path.join(repositoryRoot, 'packages/web/server/default-config/user-profile'),
        runCommand: async (command, args, options) => {
            try { const result = await execute(command, args, { cwd: options.cwd, env, timeout: 120_000, maxBuffer: 1024 * 1024 }); return { ok: true, exitCode: 0, ...result }; }
            catch { return { ok: false, exitCode: 1, stdout: '', stderr: 'Private QA dependency provisioning failed' }; }
        },
    }).provision();
    if (!provisioning.ok) throw new Error(provisioning.error || 'Private QA provisioning failed');

    const base = await readOptionalJson(path.join(config, 'opencode.json'));
    const sourceConfigs = await Promise.all(['opencode.json', 'config.json', 'opencode.jsonc'].map((file) => readOptionalJson(path.join(sourceConfig, file))));
    const providers = Object.assign({}, ...sourceConfigs.map((value) => value.provider ?? {}));
    await writePrivateJson(path.join(config, 'opencode.json'), { ...base, model: `${providerId}/${modelId}`, enabled_providers: allowedProviders,
        provider: Object.fromEntries(Object.entries(providers).filter(([id]) => allowedProviders.includes(id))), mcp: {} });
    const slim = await readOptionalJson(path.join(sourceConfig, 'oh-my-opencode-slim.json'));
    const pinnedAgents = pinQaAgents(slim, { providerId, modelId, variant, agentAssignments });
    await writePrivateJson(path.join(config, 'oh-my-opencode-slim.json'), pinnedAgents);
    try { await cp(path.join(sourceConfig, 'AGENTS.md'), path.join(config, 'AGENTS.md')); } catch (error) { if (error.code !== 'ENOENT') throw error; }

    // Private package entry wrappers evaluate the same home shim before their
    // actual dependencies. The compiled OpenCode executable does not honor
    // NODE_OPTIONS preloads, while its own config honors OPENCODE_TEST_HOME.
    for (const plugin of base.plugin.filter((entry) => entry.startsWith('./node_modules/') && !entry.startsWith('./node_modules/context-mode/'))) {
        const entry = await realpath(path.join(config, plugin));
        if (!isInside(path.join(config, 'node_modules'), entry)) throw new Error('QA plugin escaped the copied installation');
        await prepareQaPluginHomeWrapper(entry);
    }
    const projectedAuth = projectQaAuth(await readOptionalJson(path.join(sourceHome, '.local/share/opencode/auth.json')));
    await writePrivateJson(path.join(authDirectory, 'auth.json'), projectedAuth.records);
    const claude = await readClaudeAccess(sourceHome);
    const credentialsEnvironment = {};
    if (claude) {
        credentialsEnvironment.MERIDIAN_PROFILES = JSON.stringify([{ id: 'qa', type: 'oauth-token', oauthToken: claude.access }]);
        credentialsEnvironment.MERIDIAN_DEFAULT_PROFILE = 'qa';
        projectedAuth.evidence.anthropic = { state: 'available', type: 'claude-cli-access-only', expires: claude.expires };
    }
    assertQaSelectedProviderAccess(providerId, projectedAuth.evidence);
    await writePrivateJson(path.join(runtimeRoot, 'credentials.env.json'), credentialsEnvironment);
    await writePrivateJson(path.join(data, 'settings.json'), { lastDirectory: workspace, projects: [{ id: 'qa-project', path: workspace, label: 'QA workspace' }],
        activeProjectId: 'qa-project', opencodeBinary: opencodeBinary, messageStreamTransport: 'sse', showReasoningTraces: true,
        desktopWindowState: { width: 1280, height: 800, maximized: false } });
    const evidence = { providerId, modelId, variant, credentials: projectedAuth.evidence,
        appearanceOverrides: { showReasoningTraces: true },
        dependencies: { installPerformed: Boolean(provisioning.install), degraded: provisioning.installDegraded === true },
        meridianHttpHotfix: provisioning.meridianHttpHotfix,
        fingerprints: await installedFingerprints(config, base.plugin, opencodeBinary),
        agentModels: Object.fromEntries(Object.entries(pinnedAgents.agents).map(([agent, selection]) => [agent, selection.model])),
        agentSelections: Object.fromEntries(Object.entries(pinnedAgents.agents).map(([agent, selection]) => [agent, {
            model: selection.model, variant: selection.variant ?? null,
        }])),
        isolation: { home, config, data, authDirectory, workspace, opencodeBinary, refreshTokensCopied: false, personalSkillsCopied: false, multiUser: false } };
    await writePrivateJson(path.join(runtimeRoot, 'profile-evidence.json'), evidence);
    return { env, bootstrapPath: fileURLToPath(new URL('./isolated-host.mjs', import.meta.url)), evidence };
}
