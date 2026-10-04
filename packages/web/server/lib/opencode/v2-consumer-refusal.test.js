import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarnessToolManifestReader } from './harness-tool-manifest.js';
import { createHarnessRunFingerprintReader } from './harness-run-fingerprint.js';
import { createHarnessTaskContextHost } from './harness-task-context.js';
import { createClaudeProxyBaseUrlResolver } from '../quota/providers/claude-meridian.js';
import { createServerUtilsRuntime } from './server-utils-runtime.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

const invalidClients = [undefined, null, {}, { generation: () => 1 }, { generation: () => 3 }];

describe('native-only application consumer identity', () => {
  it.each(invalidClients)('never consults legacy transport when identity is invalid (%j)', async openCodeClient => {
    const fetchImpl = vi.fn(() => { throw new Error('Legacy transport selected'); });
    const buildOpenCodeUrl = vi.fn(() => { throw new Error('Legacy URL selected'); });
    const dependencies = { openCodeClient, fetchImpl, buildOpenCodeUrl };
    const manifest = await createHarnessToolManifestReader(dependencies)({ directory: '/project' });
    expect(manifest.toolIds).toEqual([]);
    expect(manifest.availability.ids).toMatchObject({ availability: 'unavailable', error: { kind: 'requestFailed' } });
    const fingerprint = await createHarnessRunFingerprintReader(dependencies).read({ directory: '/project' });
    expect(fingerprint).toMatchObject({ runtimeVersion: null, catalog: { availability: 'unavailable' } });
    await expect(createClaudeProxyBaseUrlResolver(dependencies).resolve('/project'))
      .rejects.toMatchObject({ code: 'opencode_generation_invalid', statusCode: 503 });
    const runtime = createServerUtilsRuntime({ ...dependencies, os: { homedir: () => '/fixture' }, getOpenCodePort: () => 3000 });
    await expect(runtime.fetchAgentsSnapshot({ directory: '/project' }))
      .rejects.toMatchObject({ code: 'opencode_generation_invalid', statusCode: 503 });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-consumer-refusal-')); roots.push(directory);
    const host = createHarnessTaskContextHost({ ...dependencies, dataDirectory: directory, compactionAnchorEnabled: true });
    await expect(host.readCanonicalPlanIdentity({ sessionID: 'ses_fixture', sourceMessageID: 'msg_fixture', directory: '/project' }))
      .rejects.toMatchObject({ code: 'context_canonical_source_unavailable' });
    await host.drain();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(buildOpenCodeUrl).not.toHaveBeenCalled();
  });
});
