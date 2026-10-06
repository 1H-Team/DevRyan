import { expect, test } from 'bun:test';
import { Location } from '@opencode/core/location';
import { Effect, Layer, Schema } from 'effect';
import { Tool } from '@opencode/core/tool';
import { SessionInstructions } from '@opencode/core/session/instructions';
import { Environment } from '@opencode/core/environment/index';
import { LayerNode } from '@opencode/util/effect/layer-node';
import { ChildProcess } from 'effect/unstable/process';
import { createControllerHelper } from '../../packages/web/server/lib/opencode/runtime-host/controller-processes.ts';
import { createExecutionRouting } from '../../packages/web/server/lib/opencode/runtime-host/execution-routing.ts';
import { WorkerInput, ExecutionBatch } from '../../packages/web/server/lib/opencode/runtime-host/worker-protocol.ts';
import { rebaseWriterInput } from '../../packages/web/server/lib/opencode/runtime-host/writer-worker.ts';
import type { NativeAdmissionBridge, OwnedToolInvocation } from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.ts';
import { nativeVcsGitFlags } from '../../packages/web/server/lib/opencode/execution-helper-policy.js';
import { runWithHostRefusal } from '../../packages/web/server/lib/opencode/runtime-host/host-refusal.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createNativeReadGuard } from '../../packages/web/server/lib/opencode/runtime-host/execution-read-guard.ts';
import { captureReviewedSkill } from '../../packages/web/server/lib/opencode/runtime-host/reviewed-skills.js';

const bridge: NativeAdmissionBridge = { awaitReady: async () => {}, authorize: async () => ({ token: 'fixture', revision: 0 }),
  recheck: async () => {}, release: async () => {}, sealPrompt: async () => ({}), verifyAccepted: async () => {},
  deferContinuation: async () => {}, hold: async () => {}, releaseHold: async () => {}, isHeld: async () => false,
  registerShellJob: async () => {}, sealSynthetic: async () => ({}) };
const context = Schema.decodeUnknownSync(WorkerInput)({ protocol: 1, tool: 'write', input: {},
  directory: '/fixture/view', projectDirectory: '/fixture/view', logicalDirectory: '/fixture/project',
  logicalProjectDirectory: '/fixture/project', scratchDirectory: '/fixture/scratch', config: {},
  context: { sessionID: 'ses_fixture', agent: 'build', messageID: 'msg_fixture', id: 'call_fixture' } }).context;
const invocation = (toolID = 'write'): OwnedToolInvocation => ({ toolID,
  provenance: { kind: 'native', id: `opencode.tool.${toolID}`, manifestDigest: 'fixture', capabilities: ['write'] },
  input: { path: 'one.txt', content: 'written' }, location: Schema.decodeUnknownSync(Location.Info)({ directory: '/fixture/project', project: {id:'global',directory:'/fixture/project',canonical:'/fixture/project'} }), nativeContext: { ...context, progress: () => Effect.void },
  existingPermit: { token: 'fixture', revision: 0, sessionID: context.sessionID }, recheckPermit: () => Effect.void,
  nativePermissionAssert: () => Effect.void, executeNative: () => Effect.die(new Error('controller writer must not run')) });

test('native writer permission/progress return through controller once before settled result', async () => {
  const calls: string[] = [];
  const routing = createExecutionRouting({ directory: '/fixture/project', bridge, rpc: async (method, params) => {
    calls.push(method);
    if (method.endsWith('start')) return { handle: 'owned_fixture' };
    if (method.endsWith('input')) { expect(params.reply).toMatchObject({ id: 'permission_fixture', ok: true }); return { accepted: true }; }
    if (method.endsWith('read') && params.cursor === 0) return { cursor: 3, done: true, events: [
      { cursor: 1, type: 'permission', id: 'permission_fixture', input: { action: 'edit', resources: ['one.txt'], sessionID: context.sessionID } },
      { cursor: 2, type: 'progress', update: { title: 'native progress' } },
      { cursor: 3, type: 'settled', ok: true, receipt: { terminated: true, confined: true, cancelled: false, exitCode: 0 }, result: { content: 'written' } },
    ] };
    return { cursor: 3, done: true, events: [] };
  } });
  let permissions = 0, progress = 0;
  const call = invocation();
  const result = await Effect.runPromise(routing.executeOwned({ ...call,
    nativePermissionAssert: (input) => Effect.sync(() => { permissions += 1; expect(input.source).toEqual({ type: 'tool', messageID: context.messageID, id: context.id }); }),
    nativeContext: { ...call.nativeContext, progress: () => Effect.sync(() => { progress += 1; }) } }));
  expect(result.content).toBe('written'); expect(permissions).toBe(1); expect(progress).toBe(1);
  expect(calls).toEqual(['execution.native.start', 'execution.native.read', 'execution.native.input', 'execution.native.read']);
  await routing.close();
});

test('only exact reviewed native registrations are reconstructed', async () => {
  let requests = 0;
  const routing = createExecutionRouting({ directory: '/fixture/project', bridge, rpc: async () => { requests += 1; throw new Error('must not reach bridge'); } });
  const call = invocation();
  await expect(Effect.runPromise(routing.executeOwned({ ...call, provenance: { ...call.provenance, kind: 'plugin' } }))).rejects.toThrow('native_registration_required');
  await expect(Effect.runPromise(routing.executeOwned({ ...call, toolID: 'unreviewed' }))).rejects.toThrow('native_registration_required');
  expect(requests).toBe(0); await routing.close();
});

for (const browser of [false, true]) test(`${browser ? 'browser' : 'AST'} routing keeps the full compiled origin and original input through supervised execution`, async () => {
  const origin = { kind: 'plugin' as const, id: browser ? 'devryan.browser' : 'devryan.slim', manifestDigest: 'a'.repeat(64), capabilities: ['read', 'write', 'process'] as const };
  const starts: unknown[] = [];
  const routing = createExecutionRouting({ directory: '/fixture/project', bridge, ...(browser ? { reviewedBrowserOrigin: origin } : { reviewedAstOrigin: origin }), rpc: async (method, params) => {
    if (method.endsWith('start')) { starts.push(params); return { handle: 'ast-fixture' }; }
    if (params.cursor === 0) return { cursor: 1, done: true, events: [{ cursor: 1, type: 'settled', ok: true,
      receipt: { terminated: true, confined: true, cancelled: false, exitCode: 0 }, result: { content: 'original result' } }] };
    return { cursor: 1, done: true, events: [] };
  } });
  const tool = browser ? 'devryan_browser' : 'ast_grep_search';
  const call = { ...invocation(tool), provenance: origin, input: browser ? { command: 'snapshot' } : { pattern: 'old()', lang: 'javascript' } };
  expect((await Effect.runPromise(routing.executeOwned(call))).content).toBe('original result');
  expect(starts).toEqual([expect.objectContaining({ tool, input: call.input, authorization: expect.objectContaining({ input: expect.objectContaining({ provenance: origin }) }) })]);
  for (const provenance of [{ ...origin, kind: 'native' as const }, { ...origin, manifestDigest: 'f'.repeat(64) }, { ...origin, capabilities: ['read'] as const }])
    await expect(Effect.runPromise(routing.executeOwned({ ...call, provenance }))).rejects.toThrow(browser ? 'native_browser_registration_required' : 'native_ast_registration_required');
  expect(starts).toHaveLength(1); await routing.close();
});

test('read failure still settles its ledger fence and preserves native Tool.Error', async () => {
  const calls: string[] = [];
  const routing = createExecutionRouting({ directory: '/fixture/project', bridge, rpc: async (method) => {
    calls.push(method); return method.endsWith('direct-admit') ? { token: 'fixture-direct', generation: 2 } : {};
  } });
  const error = new Tool.Error({ message: 'native read failed', metadata: { code: 'fixture' } });
  const result = await Effect.runPromiseExit(routing.executeOwned({ ...invocation('read'), executeNative: () => Effect.fail(error) }));
  expect(result._tag).toBe('Failure');
  expect(calls).toEqual(['execution.native.direct-admit', 'execution.native.direct-finish']);
  await routing.close();
});

test('writer path rebasing preserves edit text, BOM content, and external path identity', () => {
  const content = '\ufeff/fixture/project/in-content.txt';
  expect(rebaseWriterInput({ path: '/fixture/project/one.txt', content }, 'write', '/fixture/project', '/fixture/view'))
    .toEqual({ path: '/fixture/view/one.txt', content });
  expect(rebaseWriterInput({ path: '/outside/one.txt', oldString: '/fixture/project/text', newString: content }, 'edit', '/fixture/project', '/fixture/view'))
    .toEqual({ path: '/outside/one.txt', oldString: '/fixture/project/text', newString: content });
  expect(rebaseWriterInput({ patchText: '*** Update File: /fixture/project/one.txt\n-/fixture/project/old\n+/fixture/project/new\n*** Move to: /fixture/project/two.txt' },
    'patch', '/fixture/project', '/fixture/view')).toEqual({ patchText:
      '*** Update File: /fixture/view/one.txt\n-/fixture/project/old\n+/fixture/project/new\n*** Move to: /fixture/view/two.txt' });
});

test('bounded execution protocol rejects guessed or incomplete termination evidence', () => {
  expect(() => Schema.decodeUnknownSync(ExecutionBatch)({ cursor: 1, done: true,
    events: [{ cursor: 1, type: 'settled', ok: true, receipt: { exitCode: 0 } }] })).toThrow();
});

test('controller discovery helper requires reviewed Git arguments and verified bounded receipt', async () => {
  const calls: string[] = [];
  const helper = createControllerHelper({ rpc: async (method, params) => {
    calls.push(method); expect(params.args).toEqual(['remote', 'get-url', 'origin']);
    return { exitCode: 128, stdout: '', stderr: Buffer.from('no origin').toString('base64'),
      receipt: { terminated: true, confined: true, cancelled: false, exitCode: 128 } };
  } });
  const result = await Effect.runPromise(helper(ChildProcess.make('git', ['remote', 'get-url', 'origin'], { cwd: '/fixture/project' })));
  expect(result.exitCode).toBe(128); expect(result.stderr.toString()).toBe('no origin');
  await expect(Effect.runPromise(helper(ChildProcess.make('git', ['fetch', 'origin'], { cwd: '/fixture/project' })))).rejects.toThrow('controller_helper_denied');
  expect(calls).toEqual(['execution.native.helper']);
});

test('controller VCS info permits only the pinned prefix and required read operands', async () => {
  const accepted: unknown[] = [];
  const helper = createControllerHelper({ rpc: async (_method, params) => {
    accepted.push(params.args);
    return { exitCode: 0, stdout: '', stderr: '', receipt: { terminated: true, confined: true, cancelled: false, exitCode: 0 } };
  } });
  for (const args of [['symbolic-ref', '--quiet', '--short', 'HEAD'], ['remote'],
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], ['config', 'init.defaultBranch'],
    ['symbolic-ref', 'refs/remotes/origin/HEAD']]) {
    await Effect.runPromise(helper(ChildProcess.make('git', [...nativeVcsGitFlags, ...args], { cwd: '/fixture/project' })));
  }
  for (const args of [['config', 'init.defaultBranch', 'mutate'], ['config', 'credential.helper'],
    ['symbolic-ref', 'refs/remotes/../HEAD'], ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/new'],
    ['status', '--porcelain'], ['fetch', 'origin']]) {
    await expect(Effect.runPromise(helper(ChildProcess.make('git', [...nativeVcsGitFlags, ...args], { cwd: '/fixture/project' })))).rejects.toThrow('controller_helper_denied');
  }
  const changed = [...nativeVcsGitFlags]; changed[2] = 'core.fsmonitor=arbitrary';
  await expect(Effect.runPromise(helper(ChildProcess.make('git', [...changed, 'remote'], { cwd: '/fixture/project' })))).rejects.toThrow('controller_helper_denied');
  expect(accepted).toHaveLength(5);
});

test('helper transport and malformed receipts remain host refusals through native error fallback', async () => {
  for (const rpc of [async () => { throw new Error('offline'); }, async () => ({ exitCode: 0, stdout: '', stderr: '', receipt: {} })]) {
    const helper = createControllerHelper({ rpc });
    const result = await runWithHostRefusal(() => Effect.runPromise(helper(ChildProcess.make('git', ['remote', 'get-url', 'origin'], { cwd: '/fixture/project' }))
      .pipe(Effect.catchCause(() => Effect.succeed(null)))));
    expect(result.ok).toBe(false);
  }
});

test('native read guard resolves symlinks and rejects external/protected/Git targets', async () => {
  const base = path.resolve(import.meta.dirname, '../../.cache/v2-validation');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'read-guard-'));
  try {
    const project = path.join(root, 'project'), protectedRoot = path.join(project, 'owned-host'), outside = path.join(root, 'external');
    await Promise.all([fs.mkdir(protectedRoot, { recursive: true }), fs.mkdir(outside)]);
    await fs.writeFile(path.join(project, 'allowed.txt'), 'allowed');
    await fs.writeFile(path.join(outside, 'external.txt'), 'external');
    await fs.writeFile(path.join(protectedRoot, 'host.txt'), 'host');
    await fs.mkdir(path.join(project, '.git')); await fs.writeFile(path.join(project, '.git', 'config'), 'git');
    await fs.mkdir(path.join(project, 'nested', '.GiT'), { recursive: true });
    await fs.writeFile(path.join(project, 'nested', '.GiT', 'config'), 'mixed case metadata');
    await fs.symlink(path.join(outside, 'external.txt'), path.join(project, 'escape'));
    await fs.symlink(path.join(project, '.git'), path.join(project, 'metadata-alias'));
    await fs.symlink(path.join(project, 'allowed.txt'), path.join(project, 'internal-link'));
    const guard = createNativeReadGuard({ directory: project, protectedRoots: [protectedRoot] });
    await guard(path.join(project, 'allowed.txt')); await guard(path.join(project, 'internal-link'));
    await guard(path.join(project, 'missing', 'file.txt'));
    for (const target of [path.join(project, 'escape'), path.join(project, '.git', 'config'), path.join(project, 'metadata-alias', 'config'),
      path.join(project, 'nested', '.GiT', 'config'), path.join(protectedRoot, 'host.txt'), path.join(outside, 'external.txt')]) {
      await expect(guard(target)).rejects.toMatchObject({ code: 'native_read_root_denied' });
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('explicit native instruction loading cannot import symlinked or unreviewed AGENTS files', async () => {
  const base = path.resolve(import.meta.dirname, '../../.cache/v2-validation');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'instruction-guard-'));
  const project = path.join(root, 'project'), external = path.join(root, 'external');
  await Promise.all([fs.mkdir(path.join(project, 'nested'), { recursive: true }), fs.mkdir(external)]);
  const routing = createExecutionRouting({ directory: project, bridge, rpc: async () => { throw new Error('instruction load must not invoke execution'); } });
  try {
    const outsideInstructions = path.join(external, 'AGENTS.md'), insideInstructions = path.join(project, 'AGENTS.md');
    const symlink = path.join(project, 'nested', 'AGENTS.md');
    await fs.writeFile(outsideInstructions, 'unreviewed external instruction');
    await fs.writeFile(insideInstructions, 'unreviewed project instruction');
    await fs.symlink(outsideInstructions, symlink);
    // Compile the real replacement rather than testing only its path helper.
    // No Bus/Store/FSUtil dependency exists, so importing/publishing bytes is
    // impossible even when ReadTool catches the refusal defect.
    const layer = LayerNode.compile(SessionInstructions.node, { replacements: routing.overrides });
    const load = (paths: string[]) => Effect.runPromise(Effect.gen(function* () {
      const instructions = yield* SessionInstructions.Service;
      yield* instructions.load({ sessionID: context.sessionID, paths });
    }).pipe(Effect.provide(layer)));
    for (const [target, code] of [[symlink, 'native_read_root_denied'], [insideInstructions, 'native_instruction_asset_authority_required']]) {
      const result = await runWithHostRefusal(() => load([target]).catch(() => undefined));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Unreviewed instructions were accepted');
      expect(result.refusal.code).toBe(code);
    }
    await load([]);
  } finally { await routing.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('actual Environment serves only verified skill files through the current direct read scope', async () => {
  const root = await fs.mkdtemp(path.resolve('.cache/v2-validation/skill-read-'));
  const project = path.join(root, 'project'), protectedRoot = path.join(root, 'private'), skillRoot = path.join(protectedRoot, 'skill');
  await Promise.all([fs.mkdir(project), fs.mkdir(skillRoot, { recursive: true })]);
  const file = path.join(skillRoot, 'SKILL.md'), support = path.join(skillRoot, 'support.txt');
  await fs.writeFile(file, 'reviewed body'); await fs.writeFile(support, 'verified support\n');
  const skill = await captureReviewedSkill({ directory: project, skill: { name: 'Fixture', path: file }, allowedRoots: [protectedRoot],
    parseMarkdown: () => ({ body: 'reviewed body', frontmatter: {} }) });
  const calls: string[] = [];
  const routing = createExecutionRouting({ directory: project, protectedRoots: [protectedRoot], bridge,
    configurationSnapshot: { digest: 'f'.repeat(64), locations: [{ directory: project, skills: [skill] }] },
    rpc: async method => { calls.push(method); return method.endsWith('direct-admit') ? { token: 'fixture', generation: 1 } : {}; } });
  try {
    const location = Schema.decodeUnknownSync(Location.Info)({ directory: project, project: { id: 'global', directory: project, canonical: project } });
    const layer = LayerNode.compile(Environment.node, { replacements: [...routing.overrides, Location.node.replace(Layer.succeed(Location.Service, location))] });
    const run = (target: string, options: { list?: boolean; tool?: string; range?: { offset: number; length: number } } = {}) => {
      const call = { ...invocation(options.tool ?? 'read'), location, input: { path: target }, executeNative: () => Effect.gen(function* () {
        const environment = yield* Environment.Service;
        if (options.list) { yield* environment.files.list(target); return { content: 'listed' }; }
        const info = yield* environment.files.stat(target);
        const result = yield* environment.files.read(target, options.range);
        expect(info.type).toBe('file');
        return { content: new TextDecoder().decode(result.bytes) };
      }).pipe(Effect.provide(layer), Effect.mapError(error => new Tool.Error({ message: error._tag }))) };
      return Effect.runPromise(routing.executeOwned(call));
    };
    expect((await run(support)).content).toBe('verified support\n');
    expect((await run(support, { range: { offset: 9, length: 7 } })).content).toBe('support');
    expect((await run(file)).content).toBe('reviewed body');
    await fs.writeFile(path.join(skillRoot, 'unlisted.txt'), 'unreviewed');
    for (const target of [path.join(skillRoot, 'unlisted.txt'), protectedRoot]) await expect(run(target)).rejects.toThrow('native_read_root_denied');
    await expect(run(skillRoot, { list: true })).rejects.toThrow('native_read_root_denied');
    await expect(run(support, { tool: 'grep' })).rejects.toThrow('native_read_root_denied');
    await fs.writeFile(support, 'modified support\n');
    await expect(run(support)).rejects.toThrow('native_skill_resource_changed');
    await fs.unlink(support); await fs.symlink(file, support);
    await expect(run(support)).rejects.toThrow('native_skill_resource_changed');
    expect(calls.filter(value => value.endsWith('direct-admit')).length).toBe(calls.filter(value => value.endsWith('direct-finish')).length);
  } finally { await routing.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('the explicit writer entry refuses empty input with a failed protocol reply', async () => {
  const repository = path.resolve(import.meta.dirname, '../..');
  const base = path.join(repository, '.cache/v2-validation');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'writer-entry-'));
  try {
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']
      .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]!]));
    Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
      XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_STATE_HOME: root,
      TEMP: root, TMP: root, TMPDIR: root });
    const result = spawnSync(process.execPath,
      [path.join(repository, 'packages/web/server/lib/opencode/runtime-host/writer-entry.ts')],
      { input: '', cwd: root, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 65_536 });
    expect(result.error).toBeUndefined();
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 1, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({ type: 'result', ok: false, error: { message: 'native_worker_input_invalid' } });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 20_000);

test('fresh private SDK awaits real native write/edit/patch registration', async () => {
  const base = path.resolve(import.meta.dirname, '../../.cache/v2-validation');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'writer-registry-'));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const project = path.join(root, 'project'), scratch = path.join(root, 'scratch');
    await Promise.all([fs.mkdir(project), fs.mkdir(path.join(scratch, 'tmp'), { recursive: true })]);
    await fs.writeFile(path.join(scratch, 'tmp', 'package.json'), '{"type":"commonjs"}\n');
    const request = { protocol: 1, tool: 'write', input: {}, directory: project, projectDirectory: project,
      logicalDirectory: project, logicalProjectDirectory: project, scratchDirectory: scratch, config: {}, context };
    // A fresh child sets HOME/XDG before SDK imports capture native Global.Path
    // and Flock roots. It acquires the graph only; no leaf/model is executed.
    const worker = new URL('../../packages/web/server/lib/opencode/runtime-host/writer-worker.ts', import.meta.url).href;
    const source = `
      import { Effect, Logger } from 'effect';
      const { acquireWriterRegistry } = await import(${JSON.stringify(worker)});
      const denied = () => Effect.die(new Error('graph check must not ask permission'));
      const permission = { close: Effect.void, ask: denied, reply: denied, get: denied, forSession: denied, list: denied, assert: denied };
      const ids = await Effect.runPromise(Effect.scoped(acquireWriterRegistry(JSON.parse(process.env.DEVRYAN_GRAPH_REQUEST), permission)
        .pipe(Effect.map(entries => entries.map(entry => entry.id))))
        .pipe(Effect.provide(Logger.layer([], { mergeWithExisting: false }))));
      process.stdout.write(JSON.stringify(ids));
    `;
    child = Bun.spawn([process.execPath, '--eval', source], { cwd: path.resolve(import.meta.dirname, '../..'),
      env: { PATH: '/usr/bin:/bin', HOME: scratch, TMPDIR: path.join(scratch, 'tmp'),
        XDG_CONFIG_HOME: path.join(scratch, 'config'), XDG_DATA_HOME: path.join(scratch, 'data'),
        XDG_CACHE_HOME: path.join(scratch, 'cache'), XDG_STATE_HOME: path.join(scratch, 'state'),
        GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', DEVRYAN_GRAPH_REQUEST: JSON.stringify(request) },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timeout = setTimeout(() => child?.kill('SIGKILL'), 15_000);
    const output = child.stdout, errors = child.stderr;
    if (!output || typeof output === 'number' || !errors || typeof errors === 'number') throw new Error('Graph check requires bounded owned pipes');
    const [stdout, stderr, exitCode] = await Promise.all([new Response(output).text(), new Response(errors).text(), child.exited]);
    clearTimeout(timeout);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
    const ids = Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(stdout));
    for (const id of ['write', 'edit', 'patch']) expect(ids.filter(value => value === id)).toHaveLength(1);
  } finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited; } await fs.rm(root, { recursive: true, force: true }); }
}, 20_000);
