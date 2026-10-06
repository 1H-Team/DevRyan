import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startOwnedProcess } from '../qa/process.mjs';
import { createQaHostLaunchEnvironment } from '../qa/launch-environment.mjs';
const repository = path.resolve(import.meta.dirname, '../..');
const source = 'synthetic-siwc-native-credential-create-source-sdk-shared-queue';
const sha = value => createHash('sha256').update(value).digest('hex');

export function assertSourceImageOAuthProof(proof) {
  assert.deepEqual(Object.keys(proof).sort(), ['accounts', 'compiledOAuthCreation', 'nativeVersion', 'reopened', 'requestPhases', 'settledMutations', 'source']);
  assert.equal(proof.source, source); assert.equal(proof.nativeVersion, '2.0.20');
  assert.equal(proof.compiledOAuthCreation, false); assert.equal(proof.settledMutations, 2);
  assert.equal(proof.accounts.length, 2);
  proof.accounts.forEach((account, index) => {
    assert.deepEqual(Object.keys(account).sort(), ['accountID', 'credentialID', 'expectedFingerprint', 'expires', 'methodID', 'valueFingerprint']);
    assert.match(account.credentialID, /^cred_[A-Za-z0-9]+$/); assert.equal(account.methodID, 'chatgpt-siwc');
    assert.equal(account.accountID, `owned-image-account-${index === 0 ? 'A' : 'B'}`);
    assert.match(account.valueFingerprint, /^[a-f0-9]{64}$/);assert.match(account.expectedFingerprint,/^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(account.expires));
  });
  assert.notEqual(proof.accounts[0].credentialID, proof.accounts[1].credentialID);
  assert.deepEqual(proof.reopened, proof.accounts[1]);
  assert.deepEqual(proof.requestPhases, ['A', 'B'].map(account => ({ account, phase: 'create' })));
  return proof;
}

/** The caller owns the quiesced database. No compiled producer may be open. */
export async function prepareSourceImageAccounts({ root, databasePath, directory, bunCommand = 'bun' }) {
  for (const file of [root, databasePath, directory]) {
    assert.ok(path.isAbsolute(file) && file.startsWith(repository + path.sep));
    assert.equal(await fs.realpath(file), file);
  }
  const profileRoot = await fs.mkdtemp(path.join(root, 'source-image-oauth-'));
  const globals = Object.fromEntries(['home', 'data', 'cache', 'config', 'state', 'tmp', 'bin', 'log', 'repos']
    .map(key => [key, path.join(profileRoot, key)]));
  for (const value of Object.values(globals)) await fs.mkdir(value, { mode: 0o700 });
  const requestPath = path.join(profileRoot, 'request.json'), proofPath = path.join(profileRoot, 'proof.json');
  await fs.writeFile(requestPath, JSON.stringify({ databasePath, directory, profileRoot, expiresIn: { A: 3600, B: 30 } }), { flag: 'wx', mode: 0o600 });
  const inputs = ['package-image-oauth-entry.mjs', 'package-image-source-oauth.mjs'];
  const hashes = await Promise.all(inputs.map(async file => ({ path: `scripts/opencode-v2-native/${file}`, sha256: sha(await fs.readFile(path.join(import.meta.dirname, file))) })));
  const child = startOwnedProcess(bunCommand, [path.join(import.meta.dirname, inputs[0]), requestPath, proofPath], {
    cwd: repository, env: createQaHostLaunchEnvironment({ HOME: globals.home, XDG_CONFIG_HOME: globals.config,
      XDG_DATA_HOME: globals.data, XDG_STATE_HOME: globals.state, XDG_CACHE_HOME: globals.cache, TMPDIR: globals.tmp,
      TMP: globals.tmp, TEMP: globals.tmp, GIT_CEILING_DIRECTORIES: repository }) });
  let timer, proof, cause;
  try {
    const exit = new Promise((resolve, reject) => {
      if (child.child.exitCode !== null || child.child.signalCode !== null) return resolve({ code: child.child.exitCode, signal: child.child.signalCode });
      child.child.once('error', reject); child.child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const result = await Promise.race([exit, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(Error('source_image_oauth_preparation_timeout')), 30000);
    })]);
    assert.deepEqual(result, { code: 0, signal: null }, 'Original source OAuth preparation did not exit normally');
    assert.equal(await fs.realpath(proofPath), proofPath);
    const handle = await fs.open(proofPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat(); assert.ok(stat.isFile() && stat.size <= 16384 && (stat.mode & 0o077) === 0);
      const bytes = await handle.readFile(); assert.equal(bytes.length, stat.size); proof = assertSourceImageOAuthProof(JSON.parse(bytes));
    } finally { await handle.close(); }
  } catch (error) { cause = error; }
  finally { clearTimeout(timer); }
  try {
    const cleanup = await child.stop();
    await fs.writeFile(path.join(profileRoot, 'cleanup.json'), JSON.stringify(cleanup, null, 2), { mode: 0o600 });
    for (const input of hashes) assert.equal(sha(await fs.readFile(path.join(repository, input.path))), input.sha256, 'Source OAuth fixture changed during execution');
    if (cause) throw cause;
    return { proof, proofPath, inputHashes: hashes, cleanup, sourceOAuthCreation: true, compiledOAuthCreation: false };
  } catch (cleanup) {
    if (cause && cleanup !== cause) throw new AggregateError([cause, cleanup], 'Source OAuth preparation and cleanup failed');
    throw cleanup;
  }
}
