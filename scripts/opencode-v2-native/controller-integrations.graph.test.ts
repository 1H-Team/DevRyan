import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';

test('assembled native ServerFetch integration and provider attempts retain real owned scopes', async () => {
  const repository = path.resolve(import.meta.dirname, '../..');
  const root = await fs.mkdtemp(path.join(repository, '.cache/v2-validation/integration-server-'));
  const home = path.join(root, 'home'), tmp = path.join(home, 'tmp');
  await fs.mkdir(tmp, { recursive: true });
  await fs.writeFile(path.join(tmp, 'package.json'), '{"type":"commonjs"}\n');
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    child = Bun.spawn([process.execPath, path.join(repository, 'scripts/opencode-v2-native/controller-integrations.graph-fixture.mjs')], {
      cwd: repository, env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp,
        XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
        XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'),
        GIT_CEILING_DIRECTORIES: root, DEVRYAN_INTEGRATION_FIXTURE_ROOT: root }, stdout: 'pipe', stderr: 'pipe',
    });
    if (!child.stdout || typeof child.stdout === 'number' || !child.stderr || typeof child.stderr === 'number') throw new Error('Owned child pipes required');
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    await fs.writeFile(path.join(repository, '.cache/v2-validation/stage-d-integration-server-child.log'), stderr);
    await fs.writeFile(path.join(repository, '.cache/v2-validation/stage-d-integration-server-child.stdout.log'), stdout);
    await fs.copyFile(path.join(root, 'rpc-errors.jsonl'), path.join(repository, '.cache/v2-validation/stage-d-integration-server-rpc-errors.jsonl')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.copyFile(path.join(root, 'native-causes.jsonl'), path.join(repository, '.cache/v2-validation/stage-d-integration-server-native-causes.jsonl')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    for (const name of ['admissions.jsonl','messages.json','receipt-count.json','hooks.jsonl','reported-causes.jsonl']) await fs.copyFile(path.join(root,name),path.join(repository,'.cache/v2-validation/stage-d-integration-server-'+name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    const report = JSON.parse(stdout);
    expect(report.integrationLocations).toBe(2);
    expect(report.nativeOAuthCommit).toBe(true);
    expect(report.revokedAttemptRefused).toBe(true);
    expect(report.closedHandlesRefused).toBe(true);
    expect(report.providerKinds).toEqual(['compaction', 'generate', 'primary', 'title']);
    expect(report.physicalReceipts).toBeGreaterThanOrEqual(4);
    expect(report.permitsWereOwned).toBe(true);
    expect(report.websocketReceipts).toBe(0);
    expect(report.refreshedCredential).toBe(true);
    expect(report.accountChange).toBe(true);
    expect(report.providerCompatibility).toBe(true);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
