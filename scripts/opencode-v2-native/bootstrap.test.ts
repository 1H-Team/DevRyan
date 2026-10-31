import { expect, test } from 'bun:test';
import { Effect } from 'effect';
import { ChildProcess } from 'effect/process';
import { Config } from '@opencode/core/config';
import { ConfigPluginSource } from '@opencode/core/config/plugin/source';
import { AppProcess } from '@opencode/util/process';
import { LayerNode } from '@opencode/util/effect/layer-node';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Layer, Schema } from 'effect';
import { AbsolutePath } from '@opencode/core/schema';
import { InstructionBuiltIns } from '@opencode/core/instructions/builtins';
import { Instructions } from '@opencode/core/instructions/index';
import { Location } from '@opencode/core/location';
import { Project } from '@opencode/core/project';
import { Global } from '@opencode/util/global';
import { configurationOverrides, DEVRYAN_SCRATCH_ADVICE } from '../../packages/web/server/lib/opencode/runtime-host/configuration.js';
import { controllerProcessOverrides } from '../../packages/web/server/lib/opencode/runtime-host/controller-processes.js';
import { nativeHostAuthorized } from '../../packages/web/server/lib/opencode/runtime-host/bootstrap.js';
import { runWithHostRefusal } from '../../packages/web/server/lib/opencode/runtime-host/host-refusal.js';
import { trustedPluginOverride } from '../../packages/web/server/lib/opencode/runtime-host/trusted-plugins.js';
import { childSessionRoute } from '../../packages/web/server/lib/opencode/runtime-host/child-session-route.js';
import { runWithRequestPermit, requestPermit } from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.js';

test('native configuration has no filesystem discovery and preserves explicit formatter settings', async () => {
  const replacements = configurationOverrides({ formatter: { fixture: { command: ['fixture-format', '$FILE'], extensions: ['.txt'] } } });
  const layer = LayerNode.compile(LayerNode.group([Config.node, ConfigPluginSource.node]), { replacements });
  const actual = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const config = yield* Config.Service;
    const plugins = yield* ConfigPluginSource.Service;
    if (!config.compatibility) throw new Error('Closed configuration lacks explicit discovery roots');
    return { entries: yield* config.entries(), roots: yield* config.compatibility(), plugins: yield* plugins.operations() };
  }).pipe(Effect.provide(layer))));
  expect(actual.roots).toEqual({ claude: [], agents: [] });
  expect(actual.plugins).toEqual([]);
  expect(actual.entries).toHaveLength(1);
  expect(Config.latest(actual.entries, 'snapshots')).toBe(false);
  expect(Config.latest(actual.entries, 'warming')).toBe(false);
  expect(Config.latest(actual.entries, 'formatter')).toEqual({ fixture: { command: ['fixture-format', '$FILE'], extensions: ['.txt'] } });
});

test('native environment instruction names shell scratch instead of the protected global tmp', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-environment-')));
  try {
  const at = (name: string) => path.join(root, name), tmp = at('tmp'), directory = Schema.decodeUnknownSync(AbsolutePath)('/fixture/project');
  const global = Global.node.replace(Global.layerWith({ home: at('home'), data: at('data'), cache: at('cache'),
    config: at('config'), state: at('state'), tmp, bin: at('bin'), log: at('log'), repos: at('repos') }));
  const location = Location.node.replace(Layer.succeed(Location.Service,
    new Location.Info({ directory, project: { id: Project.ID.global, directory, canonical: directory } })));
  const layer = LayerNode.compile(InstructionBuiltIns.node, { replacements: [...configurationOverrides({}), global, location] });
  const values = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    return yield* Instructions.read(yield* (yield* InstructionBuiltIns.Service).load());
  }).pipe(Effect.provide(layer))));
  const environment = values.find(value => String(value.key) === 'core/environment')?.value;
  expect(typeof environment).toBe('string');
  expect(environment).toContain(DEVRYAN_SCRATCH_ADVICE);
  expect(environment).toContain(`Working directory: ${directory}`);
  expect(environment).not.toContain(tmp);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('installed OpenCode still emits the global tmp advice the environment override replaces', async () => {
  // A changed sentence would let the advice through again: update GLOBAL_TMP_ADVICE in configuration.ts.
  const entry = fileURLToPath(import.meta.resolve('@opencode/core/instructions/builtins'));
  const chunk = /from "(\.\.\/chunks\/[^"]+)"/.exec(await fs.readFile(entry, 'utf8'))?.[1];
  expect(chunk).toBeDefined();
  expect(await fs.readFile(path.resolve(path.dirname(entry), chunk ?? ''), 'utf8'))
    .toMatch(/`  Prefer \$\{global\.tmp\} over generic system temporary directories/);
});

test('native configuration refuses unreviewed discovery, MCP and competing file snapshots', () => {
  for (const config of [{ plugins: ['unreviewed'] }, { snapshots: true }, { warming: true }, { unknownOption: true },
    { instructions: ['../AGENTS.md'] }, { skills: ['https://example.invalid/skills'] },
    { references: { external: { path: '/outside' } } },
    { mcp: { servers: { external: { type: 'local', command: ['sh'] } } } }]) {
    expect(() => configurationOverrides(config)).toThrow();
  }
});

test('controller process execution fails before a subprocess can be started', async () => {
  const layer = LayerNode.compile(AppProcess.node, { replacements: controllerProcessOverrides() });
  const result = await runWithHostRefusal(() => Effect.runPromise(Effect.gen(function* () {
    const processes = yield* AppProcess.Service;
    return yield* processes.run(ChildProcess.make('sh', ['-c', 'exit 42']));
  }).pipe(Effect.provide(layer))));
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Unowned process was admitted');
  expect(result.refusal.code).toBe('owned_execution_required');
});

test('private native HTTP accepts only the exact bearer token', () => {
  const token = 'a'.repeat(43);
  expect(nativeHostAuthorized(`Bearer ${token}`, token)).toBe(true);
  for (const value of [null, token, `Basic ${token}`, `Bearer ${token}x`, `Bearer ${'b'.repeat(43)}`]) {
    expect(nativeHostAuthorized(value, token)).toBe(false);
  }
});

test('host child creation validates bounded input and retains only its exact parent permit', async () => {
  const permit = { token: 'a'.repeat(64), revision: 0, sessionID: 'ses_parent' };
  const headers = new Headers({ 'x-devryan-native-permit': JSON.stringify(permit) });
  const calls: unknown[] = [];
  const create: Parameters<typeof childSessionRoute>[1] = async (input, directory) => {
    calls.push({ input, directory, permit: requestPermit() });
    throw new Error('native-create-reached');
  };
  const post = (body: unknown) => new Request('http://127.0.0.1/devryan/session', { method: 'POST', body: JSON.stringify(body) });
  await expect(childSessionRoute(post({ parentID: 'ses_parent' }), create)).rejects.toMatchObject({ code: 'native_permit_required' });
  await runWithRequestPermit(headers, async () => {
    for (const body of [{ parentID: '' }, { parentID: 'ses_parent', id: 'ses_parent' },
      { parentID: 'ses_parent', location: { directory: '/project', extra: true } }, { parentID: 'ses_parent', unreviewed: true }]) {
      expect((await childSessionRoute(post(body), create)).status).toBe(400);
    }
    expect((await childSessionRoute(post({ parentID: 'ses_parent', title: 'x'.repeat(1024 * 1024) }), create)).status).toBe(413);
    await expect(childSessionRoute(post({ parentID: 'ses_other' }), create)).rejects.toMatchObject({ code: 'native_permit_lineage_mismatch' });
    expect(calls).toEqual([]);
    await expect(childSessionRoute(post({ parentID: 'ses_parent', id: 'ses_child', location: { directory: '/project' },
      agent: 'fixer', model: { providerID: 'sim', id: 'm1' } }), create)).rejects.toThrow('native-create-reached');
  });
  expect(calls).toEqual([{ input: { parentID: 'ses_parent', id: 'ses_child', agent: 'fixer', model: { providerID: 'sim', id: 'm1' } },
    directory: '/project', permit }]);
  expect(requestPermit()).toBeUndefined();
});

test('SDK registration cannot use a reserved native identity or an unreviewed digest', () => {
  const plugin = { id: 'fixture', effect: () => Effect.void };
  const origin = { kind: 'plugin', id: 'fixture', manifestDigest: 'a'.repeat(64), capabilities: [] } as const;
  expect(() => trustedPluginOverride({ plugins: [{ plugin, origin }], additionalOrigins: [],
    nativePlugins: new Map([['fixture', { ...origin, kind: 'native' }]]) })).toThrow();
  expect(() => trustedPluginOverride({ plugins: [{ plugin, origin: { ...origin, manifestDigest: 'unknown' } }],
    additionalOrigins: [], nativePlugins: new Map() })).toThrow();
});
