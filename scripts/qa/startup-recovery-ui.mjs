import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { promisify, parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { prepareRuntimeUiProfile } from './native-backend-ui-diagnostic.mjs';
import { loadQaPackagedArtifact } from './packaged-artifact.mjs';
import { captureQaSourceIdentity, captureQaElectronAppIdentity } from './artifact-evidence.mjs';
import { createRunRoot, removeRunPayloads } from './run-root.mjs';
import { reservePort, startOwnedProcess } from './process.mjs';
import { CdpConnection, discoverPageTarget, evaluate } from './cdp.mjs';
import { createQaUiDriver } from './ui-driver.mjs';
import { readBundleStartupState } from './native-startup-benchmark.mjs';
import { readRuntimeBundleBinding } from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js';
import { createExecutionHostOwner, executionHostOwnerLost } from '../../packages/harness-runtime/lib/execution-host-owner.js';
import { createSessionMutationRuntime } from '../../packages/harness-runtime/lib/session-mutations.js';
import { readMacosBootIdentity } from '../../packages/web/server/lib/opencode/runtime-host/native-bundle-reboot-recovery.js';
import { prepareOwnedQaDirectory } from './owned-output.mjs';

async function hashReleaseFile(file, { signal } = {}) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file, { signal })) hash.update(bytes);
  return hash.digest('hex');
}

async function captureReleaseStartupScreenshot(launch, directory, name, identity) {
  assert.match(name, /^DevRyan-[a-z0-9.-]+\.png$/);
  const result = await launch.cdp.send('Page.captureScreenshot', { format: 'png' });
  const bytes = Buffer.from(result.data, 'base64');
  assert.ok(bytes.length > 1024 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, name), bytes, { mode: 0o600, flag: 'wx' });
  const { sourceCommit, dmgSha256, manifestSha256, appSha256 } = identity;
  return { name, sha256: createHash('sha256').update(bytes).digest('hex'), sourceCommit, dmgSha256, manifestSha256, appSha256 };
}

const exec = promisify(execFile), repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
export function parseStartupRecoveryUiArgs(args) {
  const { values } = parseArgs({ args, options: { 'package-evidence': { type: 'string' }, 'artifact-root': { type: 'string' },
    receipt: { type: 'string' } }, strict: true });
  for (const key of ['package-evidence', 'artifact-root', 'receipt']) assert.ok(path.isAbsolute(values[key] ?? '')
    && path.normalize(values[key]) === values[key], 'Normalized absolute QA inputs required');
  return { packageEvidence: values['package-evidence'], artifactRoot: values['artifact-root'], receiptPath: values.receipt };
}

/** Isolated development evidence only. It neither reboots the host nor qualifies a release. */
export async function runStartupRecoveryUi({ packageEvidence, artifactRoot, receiptPath }) {
  assert.ok(process.platform === 'darwin' && process.arch === 'arm64' && globalThis.Bun,
    'Isolated startup recovery UI requires Bun on Darwin ARM64');
  for (const file of [packageEvidence, artifactRoot, receiptPath]) assert.ok(path.normalize(file) === file && file.startsWith(path.join(repository, '.cache') + path.sep));
  for (const file of [packageEvidence, artifactRoot]) assert.equal(await fs.realpath(file), file);
  await prepareOwnedQaDirectory(path.dirname(receiptPath), repository);
  await prepareOwnedQaDirectory(path.join(repository, '.cache/qa'), repository);
  const source = await captureQaSourceIdentity(repository);
  const packaged = await loadQaPackagedArtifact({ root: repository, evidencePath: packageEvidence });
  assert.equal(packaged.evidence.source.sha256, source.sha256, 'QA package source differs');
  const appSha256 = (await captureQaElectronAppIdentity(packaged.evidence.appPath)).sha256;
  const bootId = await readMacosBootIdentity();
  let prepared, app, cdp;
  const stop = async () => {
    cdp?.close(); cdp = null;
    const current = app; app = null;
    if (current) { await current.stop(); await current.auditStopped(); assert.deepEqual(current.getCleanupEvidence().remainingProcessIds, []); }
  };
  const run = createRunRoot({ parent: path.join(repository, '.cache/qa'), prefix: 'startup-recovery-ui-',
    owner: 'scripts/qa/startup-recovery-ui.mjs', extraPayloads: ['fixture'],
    onInterrupt: async () => { await stop(); await prepared?.close(); } });
  const receipt = { protocol: 'devryan.startup-recovery-ui/1', outcome: 'failed', qualification: 'development-only',
    diagnosticJournal: 'unavailable-before-server-import',
    sourceSha256: source.sha256, archiveSha256: packaged.evidence.archiveSha256, appSha256,
    screenshots: [], retryAction: 'not-invoked', actualReboot: 'not-run', cleanup: 'pending' };
  try {
    const runtimeRoot = path.join(run.dir, 'fixture'), workspace = path.join(runtimeRoot, 'workspace');
    await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
    await exec('git', ['init', '--quiet', '--initial-branch=main', '--template=', workspace], {
      env: { PATH: process.env.PATH, HOME: runtimeRoot, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' } });
    prepared = await prepareRuntimeUiProfile({ cell: { transport: 'runtime-fixture' }, runtimeRoot, workspace,
      targetGeneration: 2, artifactRoot, startupUpgrade: true });
    const binding = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: prepared.controlRoot });
    const launch = binding.descriptor.launch, initial = readBundleStartupState(prepared.controlRoot);
    const databaseSha256 = await hashReleaseFile(launch.opencodeDatabasePath);
    const launcher = path.join(path.dirname(launch.artifactManifestPath), 'DevRyan-execution-darwin-arm64');
    const ownerDirectory = path.join(launch.webDataDirectory, 'harness/execution-owners');
    const owner = await createExecutionHostOwner({ directory: ownerDirectory, launcher });
    const runtime = createSessionMutationRuntime({ directory: path.join(launch.webDataDirectory, 'harness/session-mutations') });
    try {
      const reserved = await runtime.reserve({ directory: workspace, sessionID: 'qa-recovery-session', userMessageID: 'qa-recovery-user',
        messageID: 'qa-recovery-assistant', callID: 'qa-recovery-call', ownerID: owner.id });
      const preparedLease = await runtime.prepare(reserved);
      await runtime.claimLease({ directory: workspace, token: preparedLease.token, kind: 'process' });
      assert.equal(await executionHostOwnerLost({ directory: ownerDirectory, launcher, id: owner.id }), false);
    } finally { await runtime.drain(); await owner.close(); }
    assert.equal(await executionHostOwnerLost({ directory: ownerDirectory, launcher, id: owner.id }), true);
    const profile = path.join(runtimeRoot, 'profile'), port = await reservePort();
    const settingsPath = path.join(prepared.env.OPENCHAMBER_DATA_DIR, 'settings.json');
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    await fs.writeFile(settingsPath, JSON.stringify({ ...settings, desktopLocalPort: port, desktopLanAccessEnabled: false,
      productionBotsRuntimeMode: 'disabled', productionBotsRuntimeServiceOptOut: true }) + '\n', { mode: 0o600 });
    const env = { ...prepared.env, DEVRYAN_QA_RUNTIME: 'electron', OPENCHAMBER_ELECTRON_USER_DATA_DIR: profile };
    delete env.NODE_OPTIONS;
    const start = async code => {
      const debugPort = await reservePort();
      app = startOwnedProcess(packaged.binary, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`], { cwd: workspace, env });
      const target = await discoverPageTarget(debugPort);
      cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
      const ui = createQaUiDriver(cdp, { checkAlive: app.check, timeoutMs: 60000 });
      await ui.waitFor('settled native failure document', async () => {
        try { return await evaluate(cdp, `document.readyState==='complete' && location.protocol==='data:' && document.body.innerText.includes(${JSON.stringify(code)})`); }
        catch (error) {
          if (/Inspected target navigated or closed|Execution context was destroyed|Cannot find context/i.test(error.message)) return false;
          throw error;
        }
      });
      await ui.waitVisibleText(code);
      assert.equal(await evaluate(cdp, 'Boolean(document.querySelector("textarea"))'), false);
      return ui;
    };
    const image = async label => receipt.screenshots.push(await captureReleaseStartupScreenshot({ cdp }, path.dirname(receiptPath),
      `DevRyan-startup-recovery-${label}.png`, { sourceCommit: (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim(),
        appSha256, manifestSha256: initial.artifactManifestSha256, dmgSha256: null }));
    const ui = await start('bundle_execution_unsettled');
    await ui.waitVisibleText('Retry', 'a[href="openchamber://retry-startup"]');
    receipt.retryVisible = true; await image('failure');
    await ui.click({ selector: 'a[href="openchamber://prepare-reboot-recovery"]', text: 'Prepare recovery for restart' });
    await ui.waitVisibleText('Restart your computer to continue'); await image('prepared');
    await stop();
    await start('bundle_reboot_required'); await image('same-boot-refusal'); await stop();
    assert.equal(await readMacosBootIdentity(), bootId);
    assert.deepEqual(readBundleStartupState(prepared.controlRoot), initial);
    assert.equal(await hashReleaseFile(launch.opencodeDatabasePath), databaseSha256);
    assert.equal((await captureQaSourceIdentity(repository)).sha256, source.sha256);
    assert.equal((await loadQaPackagedArtifact({ root: repository, evidencePath: packageEvidence })).evidence.archiveSha256, receipt.archiveSha256);
    receipt.sameBootRefused = true; receipt.selectionPreserved = true; receipt.databasePreserved = true;
    await prepared.close(); prepared = null;
    if (!run.keepArtifacts) {
      removeRunPayloads(run.dir, { extra: ['fixture'] });
      assert.equal(await fs.lstat(runtimeRoot).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; }), false);
    }
    receipt.cleanup = 'passed'; receipt.outcome = 'passed';
  } finally {
    await stop(); await prepared?.close();
    await fs.mkdir(path.dirname(receiptPath), { recursive: true });
    await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    run.finish(receipt.outcome);
  }
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runStartupRecoveryUi(parseStartupRecoveryUiArgs(process.argv.slice(2)));
  console.log(JSON.stringify({ outcome: result.outcome, qualification: result.qualification }));
  process.exitCode = result.outcome === 'passed' ? 0 : 1;
}
