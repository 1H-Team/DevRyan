import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  BOT_RESOURCE_LIMITS,
  BotDockerError,
  createBotDockerSupervisor,
  createDockerSocketClient,
} from './docker.js';
import { buildBotOwnershipLabels, deriveBotResourceNames } from './names.js';
import { createBotWorkspaceListingParser } from './workspace-listing.js';

const DEPLOYMENT_ID = 'deployment-01';
const REASONING_IMAGE = 'devryan/bot-opencode:dev';
const COMPUTER_IMAGE = 'devryan/bot-computer:dev';
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const RUNTIME_TOKEN = 'runtime-token-0123456789abcdef0123456789';
const COMPILED_HASH = 'c'.repeat(64);
const HOST_RUNTIME_ROOT = '/Users/test/.config/openchamber/bots/runtime';
const GATEWAY_RELAY_URL = 'http://egress:43121';
const EGRESS_TOKEN = `drb1.${'e'.repeat(64)}.${'f'.repeat(43)}`;
const SHARED_BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const SHARED_CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const SHARED_MESSAGE_ID = 'd0000000-0000-4000-8000-000000000001';
const SHARED_REVISION_ID = 'e0000000-0000-4000-8000-000000000001';

const notFound = () => new BotDockerError(
  'not found',
  'bot_supervisor_docker_not_found',
  { statusCode: 404, dockerStatusCode: 404 },
);

class FakeDocker {
  constructor() {
    this.images = new Map([
      [REASONING_IMAGE, { Id: DIGEST_A, RepoDigests: [] }],
      [COMPUTER_IMAGE, { Id: DIGEST_A, RepoDigests: [] }],
    ]);
    this.containers = new Map();
    this.volumes = new Map();
    this.workspaceEntries = new Map();
    this.workspaceArchives = new Map();
    this.calls = [];
    this.nextPort = 49152;
    this.nextContainer = 1;
    this.inspectDelay = null;
    this.initializerExitCode = 0;
    this.unavailable = false;
  }

  async inspectImage(reference) {
    this.calls.push(['inspectImage', reference]);
    if (this.unavailable) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
    if (this.inspectDelay) await this.inspectDelay;
    const image = this.images.get(reference);
    if (!image) throw notFound();
    return structuredClone(image);
  }

  async inspectContainer(name) {
    this.calls.push(['inspectContainer', name]);
    const container = this.containers.get(name);
    if (!container) throw notFound();
    return structuredClone(container);
  }

  async listContainers(labels) {
    this.calls.push(['listContainers', labels]);
    return [...this.containers.values()].filter((container) => labels.every((filter) => {
      const [key, expected] = filter.split('=');
      return container.Config.Labels[key] === expected;
    })).map((container) => ({
      Id: container.Id,
      Names: [`/${container.Name}`],
      Labels: container.Config.Labels,
      State: container.State.Running ? 'running' : 'exited',
    }));
  }

  async inspectVolume(name) {
    this.calls.push(['inspectVolume', name]);
    const volume = this.volumes.get(name);
    if (!volume) throw notFound();
    return structuredClone(volume);
  }

  async createVolume(name, labels) {
    this.calls.push(['createVolume', name]);
    this.volumes.set(name, { Name: name, Labels: structuredClone(labels) });
    return this.volumes.get(name);
  }

  async removeVolume(name) {
    this.calls.push(['removeVolume', name]);
    this.volumes.delete(name);
  }

  async createContainer(name, config) {
    this.calls.push(['createContainer', name, config]);
    const portKey = Object.keys(config.ExposedPorts || {})[0];
    const publishesPort = Boolean(portKey && config.HostConfig?.PortBindings?.[portKey]);
    const container = {
      Id: `container-${this.nextContainer++}`,
      Name: name,
      Config: structuredClone(config),
      State: { Running: false, ExitCode: null },
      NetworkSettings: {
        Ports: publishesPort ? {
          [portKey]: [{ HostIp: '127.0.0.1', HostPort: String(this.nextPort++) }],
        } : {},
        Networks: { [config.HostConfig.NetworkMode]: {} },
      },
    };
    this.workspaceEntries.set(`${container.Id}:/`, {
      name: '/', mode: 0x800001ed, linkTarget: '',
    });
    this.workspaceEntries.set(`${container.Id}:/workspace`, {
      name: 'workspace', mode: 0x800001ed, linkTarget: '',
    });
    this.containers.set(name, container);
    return { Id: container.Id };
  }

  async startContainer(id) {
    this.calls.push(['startContainer', id]);
    const container = [...this.containers.values()].find((candidate) => candidate.Id === id);
    if (container.Config.Cmd?.[0] === 'initialize') {
      container.State.Running = false;
      container.State.ExitCode = this.initializerExitCode;
    } else {
      container.State.Running = true;
    }
  }

  async waitContainer(id) {
    this.calls.push(['waitContainer', id]);
    const container = [...this.containers.values()].find((candidate) => candidate.Id === id);
    return { StatusCode: container.State.ExitCode ?? 0 };
  }

  async stopContainer(id) {
    this.calls.push(['stopContainer', id]);
    const container = [...this.containers.values()].find((candidate) => candidate.Id === id);
    container.State.Running = false;
  }

  async removeContainer(id) {
    this.calls.push(['removeContainer', id]);
    const entry = [...this.containers.entries()].find(([, candidate]) => candidate.Id === id);
    if (entry) this.containers.delete(entry[0]);
  }

  async statContainerPath(id, containerPath) {
    this.calls.push(['statContainerPath', id, containerPath]);
    const entry = this.workspaceEntries.get(`${id}:${containerPath}`);
    if (!entry) throw notFound();
    return structuredClone(entry);
  }

  async listContainerDirectory(id, containerPath) {
    this.calls.push(['listContainerDirectory', id, containerPath]);
    const archive = this.workspaceArchives.get(`${id}:${containerPath}`);
    if (!archive) throw notFound();
    const parser = createBotWorkspaceListingParser({
      includeSpecialEntries: true,
      hiddenRootEntries: null,
    });
    parser.push(archive);
    const result = parser.result();
    return {
      truncated: result.truncated,
      entries: result.entries.map((entry) => ({
        name: entry.name,
        kind: entry.type === 'dir'
          ? 'directory'
          : entry.type === 'file' ? 'file' : entry.type === 'link' ? 'symlink' : 'special',
        size: entry.size,
        mode: entry.mode,
        modifiedAt: entry.modifiedAt,
        unreadable: false,
      })),
    };
  }

  async putContainerArchive(id, destination, archive) {
    this.calls.push(['putContainerArchive', id, destination, Buffer.from(archive)]);
    if (destination === '/workspace/Shared') {
      // Docker returns a single-entry archive when the supervisor reads the
      // staged file back, even though the import archive also contains its two
      // explicitly owned parent directories.
      const headerOffset = 2 * 512;
      const header = archive.subarray(headerOffset, headerOffset + 512);
      const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
      const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
      const size = Number.parseInt(
        header.subarray(124, 136).toString('ascii').replace(/[\0 ]+$/u, ''),
        8,
      );
      const contentBlocks = Math.ceil(size / 512);
      const extracted = Buffer.alloc((1 + contentBlocks + 2) * 512);
      header.copy(extracted, 0);
      archive.subarray(headerOffset + 512, headerOffset + 512 + size).copy(extracted, 512);
      const containerPath = `${destination}/${prefix}/${name}`;
      this.workspaceEntries.set(`${id}:${containerPath}`, {
        name,
        mode: 0x80000180,
        linkTarget: '',
      });
      this.workspaceArchives.set(`${id}:${containerPath}`, extracted);
    }
  }

  async commitSharedFile(id, source, destination) {
    this.calls.push(['commitSharedFile', id, source, destination]);
    const archive = this.workspaceArchives.get(`${id}:${source}`);
    const entry = this.workspaceEntries.get(`${id}:${source}`);
    if (!archive || !entry) throw notFound();
    const filename = destination.split('/').at(-1);
    const committed = Buffer.from(archive);
    committed.fill(0, 0, 100);
    Buffer.from(filename, 'ascii').copy(committed, 0);
    committed.fill(0x20, 148, 156);
    const checksum = [...committed.subarray(0, 512)].reduce((sum, byte) => sum + byte, 0);
    Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(committed, 148);
    this.workspaceEntries.delete(`${id}:${source}`);
    this.workspaceArchives.delete(`${id}:${source}`);
    this.workspaceEntries.set(`${id}:${destination}`, { ...entry, name: filename });
    this.workspaceArchives.set(`${id}:${destination}`, committed);
  }

  async streamContainerArchive(id, containerPath, consumer) {
    this.calls.push(['streamContainerArchive', id, containerPath]);
    const archive = this.workspaceArchives.get(`${id}:${containerPath}`);
    if (!archive) throw notFound();
    // Deliberately split so the parser is exercised across chunk boundaries.
    for (let offset = 0; offset < archive.length; offset += 700) {
      consumer.push(archive.subarray(offset, offset + 700));
    }
    return consumer.result();
  }
}

const reasoningRequest = () => ({
  botId: 'bot-01',
  scopeKey: 'channel:channel-01',
  runId: 'run-01',
  channelId: 'channel-01',
  revisionId: 'revision-01',
  runtimeToken: RUNTIME_TOKEN,
  compiledHash: COMPILED_HASH,
  egressToken: EGRESS_TOKEN,
  environmentSecretCount: 0,
  chatgptImageGeneration: false,
});

// Minimal ustar writer so listing tests exercise the real header parser.
const tarArchive = (entries) => {
  const blocks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '', 'utf8');
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, 'ascii');
    header.write('000644\0 ', 100, 8, 'ascii');
    header.write(`${(entry.uid ?? 10001).toString(8).padStart(7, '0')}\0`, 108, 8, 'ascii');
    header.write(`${(entry.gid ?? 10001).toString(8).padStart(7, '0')}\0`, 116, 8, 'ascii');
    header.write(`${content.byteLength.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write(`${(1_700_000_000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header[156] = Buffer.from(entry.type ?? '0', 'ascii')[0];
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header);
    if (content.byteLength > 0) {
      const padded = Buffer.alloc(Math.ceil(content.byteLength / 512) * 512);
      content.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
};

const computerRequest = () => ({
  botId: 'bot-01',
  scopeKey: 'bot:bot-01',
  runId: 'run-01',
  channelId: 'channel-01',
  revisionId: 'revision-01',
  runtimeToken: RUNTIME_TOKEN,
  scopeMode: 'team',
  egressToken: EGRESS_TOKEN,
  isolationTier: 'standard',
});

const sharedComputerRequest = () => ({
  botId: SHARED_BOT_ID,
  scopeKey: `bot:${SHARED_BOT_ID}`,
  runId: SHARED_BOT_ID,
  channelId: SHARED_CHANNEL_ID,
  revisionId: SHARED_REVISION_ID,
  runtimeToken: RUNTIME_TOKEN,
  scopeMode: 'team',
  egressToken: EGRESS_TOKEN,
  isolationTier: 'standard',
});

const createFixture = (docker = new FakeDocker()) => ({
  docker,
  supervisor: createBotDockerSupervisor({
    docker,
    deploymentId: DEPLOYMENT_ID,
    images: { reasoning: REASONING_IMAGE, computer: COMPUTER_IMAGE },
    runtimeRoot: HOST_RUNTIME_ROOT,
  }),
});

describe('restricted Bot Docker supervisor', () => {
  test('exposes fixed verbs and keeps reasoning on the internal network', async () => {
    const { docker, supervisor } = createFixture();
    expect(Object.keys(supervisor).sort()).toEqual([
      'ensureComputer',
      'ensureReasoning',
      'exportWorkspaceImage',
      'importSharedFile',
      'listFilesystem',
      'listOwned',
      'listWorkspace',
      'reset',
      'status',
      'stop',
      'writeWorkspace',
    ]);

    const result = await supervisor.ensureReasoning(reasoningRequest());
    const create = docker.calls.find(([name, , candidate]) => (
      name === 'createContainer' && candidate.ExposedPorts?.['4096/tcp']
    ));
    const config = create[2];

    expect(result).toMatchObject({ state: 'running', replaced: false });
    expect(result.endpoint).toEqual({
      host: expect.stringMatching(/^devryan-bot-reasoning-[0-9a-f]{24}$/),
      port: 4096,
    });
    expect(config.User).toBe('10001:10001');
    expect(config.HostConfig.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(config.HostConfig.CapDrop).toEqual(['ALL']);
    expect(config.HostConfig).not.toHaveProperty('PortBindings');
    expect(config.HostConfig.NetworkMode).toBe('devryan-bots_runtime-internal');
    expect(config.HostConfig).not.toHaveProperty('ExtraHosts');
    expect(config.HostConfig.Memory).toBe(BOT_RESOURCE_LIMITS.reasoning.memoryBytes);
    expect(config.HostConfig.PidsLimit).toBe(BOT_RESOURCE_LIMITS.reasoning.pids);
    expect(config.Labels).toMatchObject({
      'devryan.runtime': 'production-bots',
      'devryan.deployment': DEPLOYMENT_ID,
      'devryan.bot': 'bot-01',
      'devryan.image': DIGEST_A,
      'devryan.revision': 'revision-01',
    });
    expect(config.Env).toContain('DEVRYAN_BOT_RUN_ID=run-01');
    expect(config.Env).toContain('DEVRYAN_BOT_CHANNEL_ID=channel-01');
    expect(config.Env).toContain(
      `HTTPS_PROXY=http://devryan:${EGRESS_TOKEN}@egress:43121/`,
    );
    expect(config.Env).toContain('NO_PROXY=127.0.0.1,localhost,egress');
    expect(config.Env).toContain(`DEVRYAN_BOT_GATEWAY_URL=${GATEWAY_RELAY_URL}`);
    // The container joins exactly one internal network and is attached to
    // nothing else, so it has no route to the host or the public internet.
    expect(docker.calls.some(([name]) => name === 'connectContainerNetwork')).toBe(false);
    expect(JSON.stringify(config.Labels)).not.toContain(EGRESS_TOKEN);

    expect(docker.calls.some(([name, , candidate]) => (
      name === 'createContainer' && candidate.Cmd?.[0] === 'initialize'
    ))).toBe(false);
    expect(config.HostConfig.Binds).toContain(
      `${HOST_RUNTIME_ROOT}/channels/channel-01/revision-01/${COMPILED_HASH}:/runtime-config:ro`,
    );
    expect(config.HostConfig.Binds).toContain(
      `${HOST_RUNTIME_ROOT}/channels/channel-01/revision-01/${COMPILED_HASH}/skills:/workspace/.opencode/skills:ro`,
    );
    expect(config.HostConfig.Binds).toContain(
      `${HOST_RUNTIME_ROOT}/artifacts/run-01:/workspace/.devryan:ro`,
    );
    expect(config.HostConfig.Binds).toContain(
      `${HOST_RUNTIME_ROOT}/auth/run-01/auth.json:/data/opencode/auth.json:rw`,
    );
    expect(config.HostConfig.Binds).toContain(
      `${HOST_RUNTIME_ROOT}/environment/run-01/environment.json:/runtime-secrets/environment.json:ro`,
    );
    expect(config.Env).toContain('DEVRYAN_BOT_ENVIRONMENT_SECRET_COUNT=0');
    expect(config.Env).toContain('DEVRYAN_BOT_CHATGPT_IMAGE_GENERATION=0');
    expect(config.HostConfig.Binds).not.toContain(
      `${HOST_RUNTIME_ROOT}/auth/run-01:/data/opencode:rw`,
    );
  });

  test('writes one reviewed regular file into the owned reasoning workspace', async () => {
    const { docker, supervisor } = createFixture();
    await supervisor.ensureReasoning(reasoningRequest());

    const result = await supervisor.writeWorkspace({
      botId: 'bot-01',
      scopeKey: 'channel:channel-01',
      path: 'approval-check.txt',
      content: 'BOT_APPROVAL_OK',
    });

    expect(result).toEqual({
      written: true,
      path: 'approval-check.txt',
      bytes: 15,
      sha256: '887d2d4bb547561d54e01ded904df1d98685cfbe4e3959ef115a84919d20f4f1',
    });
    const write = docker.calls.find(([name]) => name === 'putContainerArchive');
    expect(write?.[2]).toBe('/workspace');
    expect(write?.[3].subarray(0, 18).toString('ascii')).toBe('approval-check.txt');
  });

  test('imports and verifies one binary attachment at its deterministic Shared path', async () => {
    const { docker, supervisor } = createFixture();
    await supervisor.ensureComputer(sharedComputerRequest());
    const bytes = Buffer.from([0, 1, 2, 3, 255]);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

    const result = await supervisor.importSharedFile({
      botId: SHARED_BOT_ID,
      scopeKey: `bot:${SHARED_BOT_ID}`,
      channelId: SHARED_CHANNEL_ID,
      messageId: SHARED_MESSAGE_ID,
      filename: 'fixture.bin',
      contentBase64: bytes.toString('base64'),
      expectedSize: bytes.byteLength,
      sha256,
    });

    expect(result).toEqual({
      written: true,
      path: `/workspace/Shared/${SHARED_CHANNEL_ID}/${SHARED_MESSAGE_ID}/fixture.bin`,
      bytes: 5,
      sha256,
    });
    expect(docker.calls).toContainEqual([
      'streamContainerArchive',
      expect.any(String),
      `/workspace/Shared/${SHARED_CHANNEL_ID}/${SHARED_MESSAGE_ID}/fixture.bin`,
    ]);
    expect(docker.calls).toContainEqual([
      'commitSharedFile',
      expect.any(String),
      `/workspace/Shared/${SHARED_CHANNEL_ID}/${SHARED_MESSAGE_ID}/devryan-import-${sha256}.tmp`,
      `/workspace/Shared/${SHARED_CHANNEL_ID}/${SHARED_MESSAGE_ID}/fixture.bin`,
    ]);
    expect(docker.calls.filter(([name]) => name === 'streamContainerArchive')).toHaveLength(2);
    const config = [...docker.containers.values()][0].Config;
    expect(config.HostConfig.Binds.some((bind) => bind.endsWith(':/workspace/Shared:rw'))).toBe(true);
  });

  test('exports one finalized regular workspace image before reasoning teardown', async () => {
    const { docker, supervisor } = createFixture();
    await supervisor.ensureReasoning(reasoningRequest());
    const container = [...docker.containers.values()][0];
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('fixture'),
    ]);
    docker.workspaceEntries.set(`${container.Id}:/workspace/generated/ad.png`, {
      name: 'ad.png', mode: 0o600, linkTarget: '',
    });
    docker.workspaceEntries.set(`${container.Id}:/workspace`, {
      name: 'workspace', mode: 0x800001ed, linkTarget: '',
    });
    docker.workspaceEntries.set(`${container.Id}:/workspace/generated`, {
      name: 'generated', mode: 0x800001ed, linkTarget: '',
    });
    docker.workspaceArchives.set(`${container.Id}:/workspace/generated/ad.png`, tarArchive([{
      path: 'ad.png', content: bytes,
    }]));

    const result = await supervisor.exportWorkspaceImage({
      botId: 'bot-01',
      scopeKey: 'channel:channel-01',
      path: 'generated/ad.png',
    });
    expect(result).toEqual({
      path: 'generated/ad.png',
      filename: 'ad.png',
      contentType: 'image/png',
      size: bytes.byteLength,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      contentBase64: bytes.toString('base64'),
    });
    await expect(supervisor.exportWorkspaceImage({
      botId: 'bot-01',
      scopeKey: 'channel:channel-01',
      path: '../secret.png',
    })).rejects.toMatchObject({ code: 'bot_image_publication_failed' });

    docker.workspaceEntries.set(`${container.Id}:/workspace/generated`, {
      name: 'generated', mode: 0x080001ff, linkTarget: '/outside',
    });
    await expect(supervisor.exportWorkspaceImage({
      botId: 'bot-01',
      scopeKey: 'channel:channel-01',
      path: 'generated/ad.png',
    })).rejects.toMatchObject({ code: 'bot_image_publication_failed' });

    docker.workspaceEntries.set(`${container.Id}:/workspace/generated`, {
      name: 'generated', mode: 0x800001ed, linkTarget: '',
    });
    docker.workspaceArchives.set(`${container.Id}:/workspace/generated/ad.png`, tarArchive([{
      path: 'ad.png', content: bytes, uid: 0, gid: 0,
    }]));
    await expect(supervisor.exportWorkspaceImage({
      botId: 'bot-01',
      scopeKey: 'channel:channel-01',
      path: 'generated/ad.png',
    })).rejects.toMatchObject({ code: 'bot_image_publication_failed' });
  });

  test('refuses traversal, absent workspaces, and existing non-regular entries', async () => {
    const { docker, supervisor } = createFixture();
    await expect(supervisor.writeWorkspace({
      botId: 'bot-01',
      scopeKey: 'channel:channel-01',
      path: '../outside',
      content: 'blocked',
    })).rejects.toMatchObject({ code: 'bot_supervisor_workspace_write_invalid' });

    await supervisor.ensureReasoning(reasoningRequest());
    const container = [...docker.containers.values()][0];
    docker.workspaceEntries.set(`${container.Id}:/workspace/link.txt`, {
      name: 'link.txt',
      mode: 0x080001ff,
      linkTarget: '/runtime-config/opencode.json',
    });
    await expect(supervisor.writeWorkspace({
      botId: 'bot-01',
      scopeKey: 'channel:channel-01',
      path: 'link.txt',
      content: 'blocked',
    })).rejects.toMatchObject({ code: 'bot_supervisor_workspace_path_unsafe' });
    expect(docker.calls.filter(([name]) => name === 'putContainerArchive')).toHaveLength(0);
  });

  test('lists the shared computer workspace one level deep', async () => {
    const { docker, supervisor } = createFixture();
    await supervisor.ensureComputer(computerRequest());
    const container = [...docker.containers.values()]
      .find((candidate) => candidate.Config.Labels['devryan.kind'] === 'computer');
    docker.workspaceEntries.set(`${container.Id}:/workspace`, {
      name: 'workspace',
      mode: 0x800001ed,
      linkTarget: '',
    });
    docker.workspaceArchives.set(`${container.Id}:/workspace`, tarArchive([
      { path: 'workspace/', type: '5' },
      { path: 'workspace/notes.md', content: '# Notes\n' },
      { path: 'workspace/reports/', type: '5' },
      // Nested content arrives in the same archive and must not be listed.
      { path: 'workspace/reports/q3.csv', content: 'a,b\n' },
      // Read-only mounts the Bot does not own.
      { path: 'workspace/.devryan/', type: '5' },
      { path: 'workspace/.opencode/', type: '5' },
      // A symlink must never be presented as a real file.
      { path: 'workspace/escape.txt', type: '2' },
    ]));

    const result = await supervisor.listWorkspace({
      kind: 'computer',
      botId: 'bot-01',
      scopeKey: 'bot:bot-01',
      path: null,
    });

    expect(result.truncated).toBe(false);
    expect(result.entries.map((entry) => entry.name)).toEqual(['reports', 'notes.md']);
    expect(result.entries[0]).toMatchObject({ type: 'dir', path: 'reports' });
    expect(result.entries[1]).toMatchObject({ type: 'file', path: 'notes.md', size: 8 });
  });

  test('lists the full computer container for administrators and marks restricted entries', async () => {
    const { docker, supervisor } = createFixture();
    await supervisor.ensureComputer(computerRequest());
    const container = [...docker.containers.values()]
      .find((candidate) => candidate.Config.Labels['devryan.kind'] === 'computer');
    docker.workspaceEntries.set(`${container.Id}:/`, {
      name: '/', mode: 0x800001ed, linkTarget: '',
    });
    docker.workspaceArchives.set(`${container.Id}:/`, tarArchive([
      { path: 'root/', type: '5' },
      { path: 'root/workspace/', type: '5' },
      { path: 'root/proc/', type: '5' },
      { path: 'root/data/', type: '5' },
      { path: 'root/escape', type: '2' },
      { path: 'root/workspace/nested.txt', content: 'hidden at this level' },
    ]));

    const result = await supervisor.listFilesystem({
      kind: 'computer', botId: 'bot-01', scopeKey: 'bot:bot-01', path: null,
    });

    expect(result).toMatchObject({ state: 'running', path: '', truncated: false });
    expect(result.entries.map((entry) => [entry.name, entry.kind, entry.restricted])).toEqual([
      ['data', 'directory', false],
      ['proc', 'directory', true],
      ['workspace', 'directory', false],
      ['escape', 'symlink', true],
    ]);
  });

  test('rejects restricted, absolute, traversing, and overly deep container paths', async () => {
    const { supervisor } = createFixture();
    await supervisor.ensureComputer(computerRequest());
    for (const path of ['/etc', '../etc', 'proc', 'data/chromium', 'workspace/.devryan']) {
      await expect(supervisor.listFilesystem({
        kind: 'computer', botId: 'bot-01', scopeKey: 'bot:bot-01', path,
      })).rejects.toMatchObject({
        code: path.startsWith('proc') || path.startsWith('data/') || path.startsWith('workspace/')
          ? 'bot_supervisor_filesystem_path_restricted'
          : 'bot_supervisor_filesystem_path_unsafe',
      });
    }
    await expect(supervisor.listFilesystem({
      kind: 'computer',
      botId: 'bot-01',
      scopeKey: 'bot:bot-01',
      path: Array.from({ length: 33 }, () => 'nested').join('/'),
    })).rejects.toMatchObject({ code: 'bot_supervisor_filesystem_path_unsafe' });
  });

  test('allows ordinary spaced container directories but never archives a file target', async () => {
    const { docker, supervisor } = createFixture();
    await supervisor.ensureComputer(computerRequest());
    const container = [...docker.containers.values()]
      .find((candidate) => candidate.Config.Labels['devryan.kind'] === 'computer');
    docker.workspaceEntries.set(`${container.Id}:/workspace/My Files`, {
      name: 'My Files', mode: 0x800001ed, linkTarget: '',
    });
    docker.workspaceArchives.set(`${container.Id}:/workspace/My Files`, tarArchive([
      { path: 'My Files/brief.txt', content: 'brief' },
    ]));
    const adminListing = await supervisor.listFilesystem({
      kind: 'computer', botId: 'bot-01', scopeKey: 'bot:bot-01', path: 'workspace/My Files',
    });
    expect(adminListing).toMatchObject({ path: 'workspace/My Files' });
    expect(adminListing.entries[0]).toMatchObject({
      path: 'workspace/My Files/brief.txt', name: 'brief.txt',
    });
    const managerListing = await supervisor.listWorkspace({
      kind: 'computer', botId: 'bot-01', scopeKey: 'bot:bot-01', path: 'My Files',
    });
    expect(managerListing).toMatchObject({ path: 'My Files' });
    expect(managerListing.entries[0]).toMatchObject({
      path: 'My Files/brief.txt', name: 'brief.txt',
    });

    docker.workspaceEntries.set(`${container.Id}:/workspace/brief.txt`, {
      name: 'brief.txt', mode: 0o644, linkTarget: '',
    });
    await expect(supervisor.listFilesystem({
      kind: 'computer', botId: 'bot-01', scopeKey: 'bot:bot-01', path: 'workspace/brief.txt',
    })).rejects.toMatchObject({ code: 'bot_supervisor_filesystem_path_unsafe' });
    expect(docker.calls).not.toContainEqual([
      'streamContainerArchive', container.Id, '/workspace/brief.txt',
    ]);
  });

  test('refuses unsafe workspace paths and linked roots while listing stopped computers', async () => {
    const { docker, supervisor } = createFixture();
    await supervisor.ensureComputer(computerRequest());
    const container = [...docker.containers.values()]
      .find((candidate) => candidate.Config.Labels['devryan.kind'] === 'computer');

    for (const path of ['../outside', '/etc', '.devryan', 'a/../../b']) {
      await expect(supervisor.listWorkspace({
        kind: 'computer', botId: 'bot-01', scopeKey: 'bot:bot-01', path,
      })).rejects.toMatchObject({ code: 'bot_supervisor_workspace_path_unsafe' });
    }

    docker.workspaceEntries.set(`${container.Id}:/workspace/linked`, {
      name: 'linked',
      mode: 0x800001ed,
      linkTarget: '/runtime-config',
    });
    await expect(supervisor.listWorkspace({
      kind: 'computer', botId: 'bot-01', scopeKey: 'bot:bot-01', path: 'linked',
    })).rejects.toMatchObject({ code: 'bot_supervisor_workspace_path_unsafe' });

    await expect(supervisor.listWorkspace({
      kind: 'computer', botId: 'bot-01', scopeKey: 'bot:bot-01', path: 'missing',
    })).rejects.toMatchObject({ code: 'bot_supervisor_workspace_not_found' });

    docker.workspaceEntries.set(`${container.Id}:/workspace`, {
      name: 'workspace', mode: 0x800001ed, linkTarget: '',
    });
    docker.workspaceArchives.set(`${container.Id}:/workspace`, tarArchive([
      { path: 'workspace/saved.txt', content: 'still here' },
    ]));
    await supervisor.stop({ kind: 'computer', botId: 'bot-01', scopeKey: 'bot:bot-01' });
    await expect(supervisor.listWorkspace({
      kind: 'computer', botId: 'bot-01', scopeKey: 'bot:bot-01', path: null,
    })).resolves.toMatchObject({ state: 'stopped', path: '' });
  });

  test('reports a truncated listing instead of an unbounded one', async () => {
    const { docker, supervisor } = createFixture();
    await supervisor.ensureComputer(computerRequest());
    const container = [...docker.containers.values()]
      .find((candidate) => candidate.Config.Labels['devryan.kind'] === 'computer');
    docker.workspaceEntries.set(`${container.Id}:/workspace`, {
      name: 'workspace', mode: 0x800001ed, linkTarget: '',
    });
    docker.workspaceArchives.set(`${container.Id}:/workspace`, tarArchive(
      Array.from({ length: 640 }, (_unused, index) => ({
        path: `workspace/file-${String(index).padStart(4, '0')}.txt`,
        content: 'x',
      })),
    ));

    const result = await supervisor.listWorkspace({
      kind: 'computer', botId: 'bot-01', scopeKey: 'bot:bot-01', path: null,
    });
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(500);
  });

  test('gives Chromium one GiB shared memory and no model proxy', async () => {
    const { docker, supervisor } = createFixture();
    await supervisor.ensureComputer(computerRequest());
    const config = docker.calls.find(([name, , candidate]) => (
      name === 'createContainer' && candidate.ExposedPorts?.['43122/tcp']
    ))[2];
    expect(config.HostConfig.ShmSize).toBe(1024 ** 3);
    // Publishing a host port would require a bridge, and a bridge would also
    // hand Chromium a route off its internal network. The supervisor proxies it.
    expect(config.HostConfig).not.toHaveProperty('PortBindings');
    expect(config.HostConfig).not.toHaveProperty('ExtraHosts');
    expect(config.Env).toContain(`DEVRYAN_BOT_GATEWAY_URL=${GATEWAY_RELAY_URL}`);
    expect(config.Env).toContain('DEVRYAN_COMPUTER_NETWORK_POLICY=proxy-only');
    expect(config.Env).toContain('DEVRYAN_BROWSER_EGRESS_URL=http://egress:43121');
    expect(config.Env).toContain(`DEVRYAN_BROWSER_EGRESS_TOKEN=${EGRESS_TOKEN}`);
    expect(config.Env.some((entry) => entry.startsWith('HTTP_PROXY='))).toBe(false);
    expect(config.Env).toContain(`DEVRYAN_BOT_RUNTIME_TOKEN=${RUNTIME_TOKEN}`);
    expect(config.Env).toContain('DEVRYAN_BOT_SCOPE_MODE=team');
    expect(config.HostConfig.Binds.some((entry) => entry.endsWith(':/data/chromium:rw'))).toBe(true);
    // Long enough for Browser.close to flush the persistent profile before SIGKILL.
    expect(config.StopTimeout).toBe(30);
  });

  test('keeps the running computer and its browser session across a Bot revision bump', async () => {
    const { docker, supervisor } = createFixture();
    const first = await supervisor.ensureComputer(computerRequest());
    const containerId = first.name;
    const volumes = [...docker.volumes.keys()].sort();

    const bumped = await supervisor.ensureComputer({
      ...computerRequest(),
      revisionId: 'revision-02',
    });

    expect(bumped).toMatchObject({ name: containerId, state: 'running', replaced: false });
    expect([...docker.volumes.keys()].sort()).toEqual(volumes);
    expect(docker.calls.filter(([name]) => name === 'removeContainer')).toHaveLength(0);
    expect(docker.calls.filter(([name]) => name === 'stopContainer')).toHaveLength(0);
    expect(docker.calls.filter(([name, , candidate]) => (
      name === 'createContainer' && candidate.ExposedPorts?.['43122/tcp']
    ))).toHaveLength(1);
  });

  test('still recreates reasoning for a revision bump alone', async () => {
    const { docker, supervisor } = createFixture();
    await supervisor.ensureReasoning(reasoningRequest());

    const bumped = await supervisor.ensureReasoning({
      ...reasoningRequest(),
      revisionId: 'revision-02',
    });

    expect(bumped.replaced).toBe(true);
    expect([...docker.containers.values()][0].Config.Labels['devryan.revision']).toBe('revision-02');
  });

  test('recreates a computer still carrying a retired gateway address', async () => {
    const { docker, supervisor } = createFixture();
    const first = await supervisor.ensureComputer(computerRequest());
    const volumes = [...docker.volumes.keys()].sort();

    const same = await supervisor.ensureComputer(computerRequest());
    expect(same).toMatchObject({ name: first.name, replaced: false });

    // A computer created before the gateway moved in-network still holds the old
    // host-loopback address in its environment and cannot stage files, so the
    // recorded address is what decides whether it survives.
    const stale = [...docker.containers.values()][0];
    stale.Config.Labels['devryan.gateway'] = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

    const moved = await supervisor.ensureComputer(computerRequest());
    const current = [...docker.containers.values()][0];
    expect(moved.replaced).toBe(true);
    expect([...docker.volumes.keys()].sort()).toEqual(volumes);
    expect(current.Config.Env).toContain(`DEVRYAN_BOT_GATEWAY_URL=${GATEWAY_RELAY_URL}`);
  });

  test('rotates computer capabilities while preserving the scoped profile and scratch volumes', async () => {
    const { docker, supervisor } = createFixture();
    await supervisor.ensureComputer(computerRequest());
    const volumes = [...docker.volumes.keys()].sort();
    const rotated = await supervisor.ensureComputer({
      ...computerRequest(),
      runId: 'run-02',
      channelId: 'channel-02',
      revisionId: 'revision-02',
      runtimeToken: 'computer-rotated-token-0123456789abcdef0123456789',
    });
    const current = [...docker.containers.values()][0];
    expect(rotated.replaced).toBe(true);
    expect([...docker.volumes.keys()].sort()).toEqual(volumes);
    expect(current.Config.Env).toContain('DEVRYAN_BOT_RUN_ID=run-02');
    expect(current.Config.Labels['devryan.capability']).not.toContain('computer-rotated-token');
  });

  test('keeps the running computer and persistent volumes during browser egress rotation', async () => {
    const { docker, supervisor } = createFixture();
    const first = await supervisor.ensureComputer(computerRequest());
    const containerId = first.name;
    const volumes = [...docker.volumes.keys()].sort();
    const rotated = await supervisor.ensureComputer({
      ...computerRequest(),
      egressToken: `drb1.${'c'.repeat(43)}.${'d'.repeat(43)}`,
    });

    expect(rotated).toMatchObject({ name: containerId, state: 'running', replaced: false });
    expect([...docker.volumes.keys()].sort()).toEqual(volumes);
    expect(docker.calls.filter(([name]) => name === 'removeContainer')).toHaveLength(0);
  });

  test('deduplicates concurrent ensure for the same deterministic name', async () => {
    const docker = new FakeDocker();
    let release;
    docker.inspectDelay = new Promise((resolve) => { release = resolve; });
    const { supervisor } = createFixture(docker);

    const first = supervisor.ensureReasoning(reasoningRequest());
    const second = supervisor.ensureReasoning(reasoningRequest());
    release();
    await Promise.all([first, second]);

    expect(docker.calls.filter(([name, , config]) => (
      name === 'createContainer' && config.ExposedPorts?.['4096/tcp']
    ))).toHaveLength(1);
  });

  test('serializes a capability rotation and recreates reasoning with the newer revision', async () => {
    const { docker, supervisor } = createFixture();
    await supervisor.ensureReasoning(reasoningRequest());
    const rotated = {
      ...reasoningRequest(),
      revisionId: 'revision-02',
      runtimeToken: 'rotated-token-0123456789abcdef0123456789',
    };
    const result = await supervisor.ensureReasoning(rotated);
    const current = [...docker.containers.values()][0];

    expect(result.replaced).toBe(true);
    expect(current.Config.Labels['devryan.revision']).toBe('revision-02');
    expect(current.Config.Env).toContain('DEVRYAN_BOT_REVISION_ID=revision-02');
    expect(current.Config.Labels['devryan.capability']).not.toContain(rotated.runtimeToken);
  });

  test('refuses a deterministic-name collision not owned by this deployment', async () => {
    const docker = new FakeDocker();
    const input = reasoningRequest();
    const names = deriveBotResourceNames({
      deploymentId: DEPLOYMENT_ID,
      botId: input.botId,
      scopeKey: input.scopeKey,
      kind: 'reasoning',
    });
    docker.containers.set(names.container, {
      Id: 'foreign',
      Name: names.container,
      Config: { Labels: { 'devryan.runtime': 'someone-else' } },
      State: { Running: true },
      NetworkSettings: { Ports: {} },
    });
    const { supervisor } = createFixture(docker);

    await expect(supervisor.ensureReasoning(input)).rejects.toMatchObject({
      code: 'bot_supervisor_ownership_refused',
    });
    expect(docker.calls.some(([name]) => name === 'removeContainer')).toBe(false);
  });

  test('rotates a reasoning container when its immutable compiled config changes', async () => {
    const { docker, supervisor } = createFixture();
    await supervisor.ensureReasoning(reasoningRequest());
    const changedHash = 'd'.repeat(64);
    const result = await supervisor.ensureReasoning({
      ...reasoningRequest(),
      compiledHash: changedHash,
    });
    const current = [...docker.containers.values()][0];
    expect(result.replaced).toBe(true);
    expect(current.Config.Labels['devryan.config']).toBe(changedHash);
    expect(current.Config.HostConfig.Binds).toContain(
      `${HOST_RUNTIME_ROOT}/channels/channel-01/revision-01/${changedHash}:/runtime-config:ro`,
    );
  });

  test('rejects mismatched channel and computer scope capabilities', () => {
    const { supervisor } = createFixture();
    const capture = (operation) => {
      try {
        operation();
      } catch (error) {
        return error;
      }
      return null;
    };
    expect(capture(() => supervisor.ensureReasoning({
      ...reasoningRequest(),
      channelId: 'different-channel',
    }))).toMatchObject({ code: 'bot_supervisor_request_invalid' });
    expect(capture(() => supervisor.ensureComputer({
      ...computerRequest(),
      scopeKey: 'bot:another-bot',
    }))).toMatchObject({ code: 'bot_supervisor_request_invalid' });
    expect(capture(() => supervisor.ensureComputer({
      ...computerRequest(),
      scopeMode: 'personalized',
    }))).toMatchObject({ code: 'bot_supervisor_request_invalid' });
  });

  test('replaces a stale image while preserving all named volumes', async () => {
    const { docker, supervisor } = createFixture();
    const first = await supervisor.ensureReasoning(reasoningRequest());
    const volumeNames = [...docker.volumes.keys()].sort();
    docker.images.set(REASONING_IMAGE, { Id: DIGEST_B, RepoDigests: [] });

    const second = await supervisor.ensureReasoning(reasoningRequest());

    expect(first.image).toBe(DIGEST_A);
    expect(second).toMatchObject({ image: DIGEST_B, replaced: true });
    expect([...docker.volumes.keys()].sort()).toEqual(volumeNames);
    expect(docker.calls.filter(([name]) => name === 'removeVolume')).toHaveLength(0);
    expect(docker.calls.filter(([name]) => name === 'removeContainer').length).toBeGreaterThanOrEqual(1);
  });

  test('stops idempotently and resets only the selected owned volume', async () => {
    const { docker, supervisor } = createFixture();
    await supervisor.ensureComputer(computerRequest());
    const target = {
      kind: 'computer',
      botId: computerRequest().botId,
      scopeKey: computerRequest().scopeKey,
    };
    const stopped = await supervisor.stop(target);
    expect(stopped.state).toBe('stopped');
    await supervisor.stop(target);

    const reset = await supervisor.reset({
      ...target,
      resource: 'scratch',
    });
    expect(reset.removed).toEqual(['scratch']);
    expect([...docker.volumes.keys()].some((name) => name.endsWith('-profile'))).toBe(true);
    expect([...docker.volumes.keys()].some((name) => name.endsWith('-scratch'))).toBe(false);
  });

  test('reports owned containers without exposing an arbitrary Docker operation', async () => {
    const { supervisor } = createFixture();
    await supervisor.ensureComputer(computerRequest());
    const owned = await supervisor.listOwned();
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({ kind: 'computer', botId: 'bot-01', state: 'running' });
    expect(supervisor.request).toBeUndefined();
  });

  test('returns a stable unavailable error when Docker cannot be reached', async () => {
    const docker = new FakeDocker();
    docker.unavailable = true;
    const { supervisor } = createFixture(docker);
    await expect(supervisor.ensureReasoning(reasoningRequest())).rejects.toMatchObject({
      code: 'bot_supervisor_docker_unavailable',
      statusCode: 503,
    });
  });

  test('refuses foreign volume labels before creating a container', async () => {
    const docker = new FakeDocker();
    const input = computerRequest();
    const identity = {
      deploymentId: DEPLOYMENT_ID,
      botId: input.botId,
      scopeKey: input.scopeKey,
      kind: 'computer',
    };
    const names = deriveBotResourceNames(identity);
    docker.volumes.set(names.volumes.profile, {
      Name: names.volumes.profile,
      Labels: buildBotOwnershipLabels({ ...identity, imageIdentity: DIGEST_A }),
    });
    const { supervisor } = createFixture(docker);
    await expect(supervisor.ensureComputer(input)).rejects.toMatchObject({
      code: 'bot_supervisor_ownership_refused',
    });
  });
});

if (process.env.DEVRYAN_RUN_DOCKER_TESTS === '1') {
  describe('Bot supervisor Docker socket integration', () => {
    test('reaches Docker and round-trips one uniquely owned disposable volume', async () => {
      const docker = createDockerSocketClient();
      expect(await docker.ping()).toBe('OK');
      const name = `devryan-bot-integration-${crypto.randomUUID()}`;
      let created = false;
      try {
        await docker.createVolume(name, {
          'devryan.runtime': 'production-bots-test',
          'devryan.owner': 'integration-test',
        });
        created = true;
        expect(await docker.inspectVolume(name)).toMatchObject({ Name: name });
      } finally {
        if (created) await docker.removeVolume(name);
      }
      await expect(docker.inspectVolume(name)).rejects.toMatchObject({
        code: 'bot_supervisor_docker_not_found',
      });
    });

    test('browses the running computer root and Shared through fixed supervisor operations', async () => {
      const suffix = crypto.randomUUID();
      const deploymentId = `integration-${suffix}`;
      const network = `devryan-bot-integration-${suffix}`;
      const botId = `bot-${suffix}`;
      const scopeKey = `bot:${botId}`;
      const docker = createDockerSocketClient();
      const runDocker = (args) => {
        const result = spawnSync('docker', args, { encoding: 'utf8' });
        if (result.status !== 0) {
          throw new Error(result.stderr || `docker ${args.join(' ')} failed`);
        }
        return result.stdout.trim();
      };
      let networkCreated = false;
      const supervisor = createBotDockerSupervisor({
        docker,
        deploymentId,
        images: {
          reasoning: process.env.DEVRYAN_BOT_REASONING_IMAGE || REASONING_IMAGE,
          computer: process.env.DEVRYAN_BOT_COMPUTER_IMAGE || COMPUTER_IMAGE,
        },
        computerNetwork: network,
      });
      const input = {
        botId,
        scopeKey,
        runId: `run-${suffix}`,
        channelId: `channel-${suffix}`,
        revisionId: `revision-${suffix}`,
        runtimeToken: RUNTIME_TOKEN,
        scopeMode: 'team',
        egressToken: EGRESS_TOKEN,
        isolationTier: 'standard',
      };
      try {
        runDocker(['network', 'create', network]);
        networkCreated = true;
        await supervisor.ensureComputer(input);

        const root = await supervisor.listFilesystem({
          kind: 'computer', botId, scopeKey, path: null,
        });
        expect(root).toMatchObject({ state: 'running', path: '', truncated: false });
        expect(root.entries.find((entry) => entry.name === 'workspace')).toMatchObject({
          kind: 'directory', restricted: false,
        });
        expect(root.entries.find((entry) => entry.name === 'proc')).toMatchObject({
          kind: 'directory', restricted: true,
        });

        const adminShared = await supervisor.listFilesystem({
          kind: 'computer', botId, scopeKey, path: 'workspace/Shared',
        });
        expect(adminShared).toMatchObject({
          state: 'running', path: 'workspace/Shared', truncated: false,
        });

        const managerShared = await supervisor.listWorkspace({
          kind: 'computer', botId, scopeKey, path: 'Shared',
        });
        expect(managerShared).toMatchObject({
          state: 'running', path: 'Shared', truncated: false,
        });
      } finally {
        await supervisor.reset({
          kind: 'computer', botId, scopeKey, resource: 'all',
        }).catch(() => undefined);
        await supervisor.reset({
          kind: 'computer', botId, scopeKey, resource: 'shared',
        }).catch(() => undefined);
        if (networkCreated) runDocker(['network', 'rm', network]);
      }
    }, 120_000);

    test('injects a private secret into the reasoning process without exposing its value', async () => {
      const suffix = crypto.randomUUID();
      const deploymentId = `integration-${suffix}`;
      const reasoningNetwork = `devryan-bot-reasoning-${suffix}`;
      const botId = `bot-${suffix}`;
      const channelId = `channel-${suffix}`;
      const revisionId = `revision-${suffix}`;
      const runId = `run-${suffix}`;
      const scopeKey = `channel:${channelId}`;
      const secretName = 'SYNTHETIC_REASONING_SECRET';
      const secretValue = crypto.randomBytes(32).toString('base64url');
      const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-bot-runtime-'));
      const configRoot = path.join(runtimeRoot, 'channels', channelId, revisionId, COMPILED_HASH);
      const authRoot = path.join(runtimeRoot, 'auth', runId);
      const environmentRoot = path.join(runtimeRoot, 'environment', runId);
      fs.mkdirSync(path.join(configRoot, 'skills'), { recursive: true });
      fs.mkdirSync(authRoot, { recursive: true });
      fs.mkdirSync(environmentRoot, { recursive: true });
      fs.mkdirSync(path.join(runtimeRoot, 'artifacts', runId), { recursive: true });
      fs.writeFileSync(path.join(configRoot, 'opencode.json'), `${JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        default_agent: 'bot',
        plugin: ['/opt/devryan/devryan-bot-tools.mjs'],
        agent: {
          bot: {
            mode: 'primary',
            prompt: 'Docker environment injection verification.',
            permission: { '*': 'deny', read: 'allow' },
          },
        },
      })}\n`, { mode: 0o444 });
      fs.writeFileSync(path.join(authRoot, 'auth.json'), '{}\n', { mode: 0o600 });
      const environmentFile = path.join(environmentRoot, 'environment.json');
      fs.writeFileSync(environmentFile, `${JSON.stringify({
        version: 1,
        variables: { [secretName]: secretValue },
      })}\n`, { mode: 0o400 });

      const runDocker = (args) => {
        const result = spawnSync('docker', args, { encoding: 'utf8' });
        if (result.status !== 0) {
          throw new Error(result.stderr || `docker ${args.join(' ')} failed`);
        }
        return result.stdout.trim();
      };
      let reasoningNetworkCreated = false;
      const docker = createDockerSocketClient();
      const supervisor = createBotDockerSupervisor({
        docker,
        deploymentId,
        images: {
          reasoning: process.env.DEVRYAN_BOT_REASONING_IMAGE || REASONING_IMAGE,
          computer: process.env.DEVRYAN_BOT_COMPUTER_IMAGE || COMPUTER_IMAGE,
        },
        reasoningNetwork,
        runtimeRoot,
      });
      try {
        runDocker(['network', 'create', '--internal', reasoningNetwork]);
        reasoningNetworkCreated = true;
        const reasoning = await supervisor.ensureReasoning({
          botId,
          scopeKey,
          runId,
          channelId,
          revisionId,
          runtimeToken: RUNTIME_TOKEN,
          compiledHash: COMPILED_HASH,
          egressToken: EGRESS_TOKEN,
          environmentSecretCount: 1,
          chatgptImageGeneration: false,
        });
        const inspected = await docker.inspectContainer(reasoning.name);
        expect(inspected.Config.Env.some((entry) => entry.startsWith(`${secretName}=`))).toBe(false);

        const probe = String.raw`
const fs = require('node:fs');
const name = process.argv[1];
for (const entry of fs.readdirSync('/proc')) {
  if (!/^\d+$/.test(entry)) continue;
  try {
    const values = fs.readFileSync('/proc/' + entry + '/environ').toString('utf8').split('\0');
    if (values.some((value) => value.startsWith(name + '=') && value.length > name.length + 1)) {
      process.exit(0);
    }
  } catch {}
}
process.exit(1);
`;
        let detected = false;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const result = spawnSync('docker', [
            'exec', '--user', '10001:10001', reasoning.name,
            'node', '-e', probe, '--', secretName,
          ], { encoding: 'utf8' });
          expect(result.stdout).toBe('');
          if (result.status === 0) {
            detected = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(detected).toBe(true);

        const imageBytes = Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.from('docker publication fixture'),
        ]);
        const writeImage = spawnSync('docker', [
          'exec', '--user', '10001:10001', reasoning.name,
          'node', '-e', String.raw`
const fs = require('node:fs');
fs.mkdirSync('/workspace/generated', { recursive: true, mode: 0o700 });
fs.writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'), { mode: 0o600 });
`, '--', '/workspace/generated/docker-fixture.png', imageBytes.toString('base64'),
        ], { encoding: 'utf8' });
        expect(writeImage.status).toBe(0);
        expect(writeImage.stdout).toBe('');
        const exported = await supervisor.exportWorkspaceImage({
          botId,
          scopeKey,
          path: 'generated/docker-fixture.png',
        });
        expect(exported).toMatchObject({
          path: 'generated/docker-fixture.png',
          filename: 'docker-fixture.png',
          contentType: 'image/png',
          size: imageBytes.byteLength,
          sha256: crypto.createHash('sha256').update(imageBytes).digest('hex'),
          contentBase64: imageBytes.toString('base64'),
        });
      } finally {
        await supervisor.reset({
          kind: 'reasoning', botId, scopeKey, resource: 'all',
        }).catch(() => undefined);
        await supervisor.reset({
          kind: 'computer', botId, scopeKey: `bot:${botId}`, resource: 'shared',
        }).catch(() => undefined);
        if (reasoningNetworkCreated) runDocker(['network', 'rm', reasoningNetwork]);
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
      }
    }, 120_000);
  });
}
