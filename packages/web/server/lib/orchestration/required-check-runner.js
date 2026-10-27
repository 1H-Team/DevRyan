import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateRequiredChecks } from '@devryan/orchestration-runtime';
import { applyCheckCorrection, correctedEdgeCommand, parseVitestEdgeCommand, validateCheckCorrection } from '../../../../orchestration-runtime/check-correction.js';
import { fingerprintCheckContent } from './required-check-observer.js';

const fail = code => Object.assign(new Error(code), { code, statusCode: 409 });
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const scriptPath = 'scripts/testing/run-deno-tests.mjs';
const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);

export function createRequiredCheckRunnerPolicy(entries = []) {
  if (!Array.isArray(entries) || entries.length > 32 || entries.some(entry => !entry || Object.keys(entry).sort().join() !== 'kind,scriptSha256'
    || entry.kind !== 'edge-deno-function-v1' || !/^[a-f0-9]{64}$/.test(entry.scriptSha256))) throw fail('required_check_runner_policy_invalid');
  const approved = new Set(entries.map(entry => entry.scriptSha256));
  return identity => identity.kind === 'edge-deno-function-v1' && approved.has(identity.scriptSha256);
}

export function requiredCheckRunnerPolicyFromEnvironment(environment = process.env) {
  let entries = [];
  try { entries = environment.DEVRYAN_REQUIRED_CHECK_RUNNER_POLICIES ? JSON.parse(environment.DEVRYAN_REQUIRED_CHECK_RUNNER_POLICIES) : []; }
  catch { throw fail('required_check_runner_policy_invalid'); }
  return createRequiredCheckRunnerPolicy(entries);
}

async function projectFile(root, relative, limit = 128 * 1024) {
  const file = path.resolve(root, relative);
  const resolved = await fs.realpath(file).catch(() => { throw fail('required_check_runner_file_unavailable'); });
  if (!inside(root, resolved)) throw fail('required_check_runner_scope');
  const handle = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => { throw fail('required_check_runner_file_unavailable'); });
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) throw fail('required_check_runner_file_invalid');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true }), named = await fs.stat(resolved, { bigint: true });
    if (bytes.length > limit || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key] || before[key] !== named[key])
      || await fs.realpath(file) !== resolved) throw fail('required_check_runner_changed');
    return { bytes, sha256: digest(bytes) };
  } finally { await handle.close(); }
}

async function assertDenoTests(root, testPath) {
  let tests = 0, entriesSeen = 0;
  const visit = async (relative, depth = 0) => {
    if (depth > 16) throw fail('required_check_runner_inventory_limit');
    const directory = await fs.realpath(path.join(root, relative)).catch(() => { throw fail('required_check_runner_tests_unavailable'); });
    if (!inside(root, directory)) throw fail('required_check_runner_scope');
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => { throw fail('required_check_runner_tests_unavailable'); });
    if ((entriesSeen += entries.length) > 512) throw fail('required_check_runner_inventory_limit');
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw fail('required_check_runner_scope');
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(file, depth + 1);
      else if (/(?:^|[._-])test\.[cm]?[jt]sx?$/.test(entry.name)) {
        const source = (await projectFile(root, file)).bytes.toString('utf8');
        // This only identifies the declared test dialect. Runner semantics are
        // authorized separately by a host-owned, digest-pinned policy below.
        if (!/\bDeno\.test\s*\(/.test(source) || /(?:from\s*|import\s*\()['"](?:vitest|@jest\/globals)['"]/.test(source)) {
          throw fail('required_check_runner_test_dialect_unverified');
        }
        tests++;
      }
    }
  };
  await visit(testPath);
  if (!tests) throw fail('required_check_runner_tests_unavailable');
}

/** No execution and no model-selected replacement. verifyRunner is supplied by
 * the trusted host constructor and must approve this exact script digest and
 * edge-deno-function-v1 selector contract. Merely containing "deno" is no proof. */
export async function resolveRequiredCheckRunnerCorrection({ directory, check, previousReceipt, verifyRunner, now = Date.now }) {
  validateRequiredChecks([check]);
  const source = parseVitestEdgeCommand(check.command);
  if (!source || check.kind === 'visual') throw fail('required_check_runner_unsupported');
  if (check.paths.some(file => file !== source.functionPath && !file.startsWith(`${source.functionPath}/`))) throw fail('required_check_runner_coverage_mismatch');
  const root = await fs.realpath(directory).catch(() => { throw fail('required_check_runner_scope'); });
  const manifest = await projectFile(root, 'package.json');
  let metadata;
  try { metadata = JSON.parse(manifest.bytes.toString('utf8')); } catch { throw fail('required_check_runner_manifest_invalid'); }
  if (metadata?.scripts?.['test:edge'] !== `node ${scriptPath}`) throw fail('required_check_runner_script_unavailable');
  const script = await projectFile(root, scriptPath);
  await assertDenoTests(root, source.testPath);
  const coverageHash = await fingerprintCheckContent(root, check.paths);
  if (!coverageHash) throw fail('required_check_runner_coverage_unavailable');
  const runnerIdentity = { kind: 'edge-deno-function-v1', packagePath: 'package.json', packageSha256: manifest.sha256,
    scriptPath, scriptSha256: script.sha256, functionName: source.functionName, selector: '--function', testPath: source.testPath,
    coverageHash, verifiedBy: 'host-policy' };
  if (typeof verifyRunner !== 'function') throw fail('required_check_runner_unverified');
  let approved;
  try { approved = await verifyRunner(Object.freeze({ ...runnerIdentity })); }
  catch { throw fail('required_check_runner_policy_unavailable'); }
  if (approved !== true) throw Object.assign(fail('required_check_runner_unverified'), {
    message: `required_check_runner_unverified: the host owner must attest edge-deno-function-v1 selector coverage for script SHA-256 ${script.sha256} in requiredCheckRunnerPolicies or DEVRYAN_REQUIRED_CHECK_RUNNER_POLICIES before correcting this check` });
  // Policy lookup may yield; stale runner bytes never acquire correction authority.
  if (manifest.sha256 !== (await projectFile(root, 'package.json')).sha256 || script.sha256 !== (await projectFile(root, scriptPath)).sha256
    || coverageHash !== await fingerprintCheckContent(root, check.paths) || await fs.realpath(directory) !== root) throw fail('required_check_runner_changed');
  return validateCheckCorrection({ name: check.name, previousCommand: check.command, command: correctedEdgeCommand(source.functionName),
    reason: 'repository_edge_deno_runner', observedAt: now(), ...(previousReceipt === undefined ? {} : { previousReceipt }), runnerIdentity }, check);
}

/** Recheck immediately before admission/receipt use. Ordinary source freshness
 * remains the observer's responsibility; runner script/manifest changes fence it. */
export async function verifyRequiredCheckRunnerIdentity({ directory, check, correction, verifyRunner, allowManifestRefresh = false }) {
  const previous = { ...check, command: correction.previousCommand };
  const { previousCheck: archivedDefinition, ...audit } = correction;
  if (archivedDefinition && JSON.stringify(archivedDefinition) !== JSON.stringify(previous)) throw fail('required_check_runner_changed');
  const expected = validateCheckCorrection(audit, previous);
  const current = await resolveRequiredCheckRunnerCorrection({ directory, check: previous, verifyRunner });
  if (expected.runnerIdentity.scriptSha256 !== current.runnerIdentity.scriptSha256
    || !allowManifestRefresh && expected.runnerIdentity.packageSha256 !== current.runnerIdentity.packageSha256) throw fail('required_check_runner_changed');
  return current.runnerIdentity;
}

export async function prepareRequiredCheckDeclarations({ directory, checks = [], verifyRunner, now = Date.now }) {
  validateRequiredChecks(checks);
  let prepared = { checks: structuredClone(checks), receipts: [], history: [] };
  for (const check of checks) {
    if (!parseVitestEdgeCommand(check.command)) continue;
    let correction;
    try { correction = await resolveRequiredCheckRunnerCorrection({ directory, check, verifyRunner, now }); }
    catch (error) {
      // A genuine Vitest project or another repository convention is unchanged.
      // Known Deno selectors with an unapproved runner fail before dispatch.
      if (['required_check_runner_script_unavailable', 'required_check_runner_manifest_invalid', 'required_check_runner_file_unavailable',
        'required_check_runner_test_dialect_unverified', 'required_check_runner_tests_unavailable'].includes(error?.code)) continue;
      throw error;
    }
    prepared = applyCheckCorrection(prepared, correction);
  }
  return prepared;
}
