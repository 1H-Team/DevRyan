import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runReadOnlySessionExecution } from '../../packages/harness-runtime/lib/session-execution.js';
import { repositoryRoot, repositoryPath } from './artifacts.mjs';

export function assertCompiledAssetReply(reply, buildId) {
  assert.deepEqual(Object.keys(reply).sort(), ['buildId', 'ffi', 'parser', 'photon', 'protocol', 'pty', 'type']);
  assert.equal(reply.protocol, 1); assert.equal(reply.type, 'assets-verified'); assert.equal(reply.buildId, buildId);
  assert.deepEqual(reply.parser, { bash: true, powershell: true });
  assert.deepEqual(reply.photon, { width: 1, height: 1, mime: 'image/png' });
  assert.deepEqual(reply.ffi, { loaded: true });
  assert.equal(reply.pty.sha256, 'd333339292bb9f9a739dbce9e2ababbce81b3040ea3d064b8a9b359a1c05ab61');
  assert.equal(reply.pty.executable, true); assert.ok(Number.isSafeInteger(reply.pty.size) && reply.pty.size > 0);
}

const assertReceipt = receipt => {
  assert.equal(receipt.terminated, true); assert.equal(receipt.confined, true); assert.equal(receipt.cancelled, false);
};

/** Actual compiled asset activation plus an independent positive read-denial control. */
export async function runCompiledAssetAcceptance({ artifacts, root }) {
  root = await repositoryPath(root);
  const deniedControl = path.join(root, 'denied-read-control'); await fs.mkdir(deniedControl);
  const sentinel = 'DEVRYAN_COMPILED_READ_DENIAL_CONTROL';
  const sentinelPath = path.join(deniedControl, 'sentinel.txt'); await fs.writeFile(sentinelPath, sentinel);
  const storage = path.join(root, 'asset-supervision');
  const deniedReadDirectories = await Promise.all(['node_modules', 'packages', 'scripts']
    .map(name => repositoryPath(path.join(repositoryRoot, name))));
  deniedReadDirectories.push(deniedControl);
  const common = { launcher: artifacts.launcher, storage, socketDirectory: null, workerBrowsers: false,
    env: { PATH: '/usr/bin:/bin' }, signal: AbortSignal.timeout(30_000) };
  const readable = await runReadOnlySessionExecution({ ...common, command: '/bin/cat', args: [sentinelPath] });
  assertReceipt(readable.receipt); assert.equal(readable.receipt.exitCode, 0);
  assert.equal(readable.stdout.toString(), sentinel); assert.equal(readable.stderr.length, 0);
  const denied = await runReadOnlySessionExecution({ ...common, deniedReadDirectories, command: '/bin/cat', args: [sentinelPath] });
  assertReceipt(denied.receipt); assert.notEqual(denied.receipt.exitCode, 0);
  assert.equal(denied.stdout.length, 0); assert.equal(denied.stderr.toString().includes(sentinel), false);
  let globals;
  const activated = await runReadOnlySessionExecution({ ...common, deniedReadDirectories,
    command: artifacts.controller, args: ['--verify-assets'],
    inputForLease: async lease => {
      const scratch = path.join(path.dirname(lease.viewDirectory), 'scratch');
      globals = Object.fromEntries(['home', 'config', 'data', 'cache', 'state', 'tmp', 'bin', 'log', 'repos']
        .map(key => [key, ['home', 'tmp'].includes(key) ? scratch : path.join(scratch, key)]));
      for (const directory of Object.values(globals)) await fs.mkdir(directory, { recursive: true });
      return JSON.stringify({ protocol: 1, type: 'verify-assets', globals, verificationRoot: lease.viewDirectory }) + '\n';
    }, environment: () => ({ PATH: '/usr/bin:/bin', HOME: globals.home, XDG_CONFIG_HOME: globals.config,
      XDG_DATA_HOME: globals.data, XDG_STATE_HOME: globals.state, XDG_CACHE_HOME: globals.cache, TMPDIR: globals.tmp }) });
  assertReceipt(activated.receipt);
  if(activated.receipt.exitCode!==0||activated.stderr.length)throw Object.assign(new Error('compiled_asset_activation_failed'),{code:'compiled_asset_activation_failed',protocolEvidence:{receipt:activated.receipt,stdout:activated.stdout.toString().slice(0,4096),stderr:activated.stderr.toString().slice(0,4096)}});
  const reply = JSON.parse(activated.stdout.toString()); assertCompiledAssetReply(reply, artifacts.manifest.buildId);
  assert.equal(await fs.readFile(sentinelPath, 'utf8'), sentinel);
  return { id: 'compiled-assets-source-denied', status: 'passed', source: 'accepted-supervisor-direct-compiled-asset-mode',
    assets: reply, receipt: activated.receipt, readDenialControl: { readable: readable.receipt, denied: denied.receipt },
    deniedReadDirectories };
}
