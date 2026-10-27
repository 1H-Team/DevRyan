import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createRequiredCheckRunnerPolicy, prepareRequiredCheckDeclarations, requiredCheckRunnerPolicyFromEnvironment, resolveRequiredCheckRunnerCorrection, verifyRequiredCheckRunnerIdentity } from './required-check-runner.js';
import { createManagedTaskRecord, createManagedTaskResultEnvelope } from '@devryan/orchestration-runtime';
import { createWebManagedOrchestrationRuntime } from './runtime.js';
import { createNativeManagedTaskOwner } from '../opencode/runtime-host/managed-task-owner.js';

describe('repository-owned Edge runner correction', () => {
  let directory, check, runnerBytes, approvedHash;
  const runnerPath = 'scripts/testing/run-deno-tests.mjs';
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const options = () => ({ directory, check, now: () => 100,
    verifyRunner: identity => identity.kind === 'edge-deno-function-v1' && identity.scriptSha256 === approvedHash });
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-check-runner-'));
    check = { name: 'edge tests', command: 'npx vitest run supabase/functions/booking-documents/__tests__ --maxWorkers=2',
      paths: ['supabase/functions/booking-documents'], purpose: 'integration', prerequisites: ['fixture'] };
    await fs.mkdir(path.join(directory, 'scripts/testing'), { recursive: true });
    await fs.mkdir(path.join(directory, 'supabase/functions/booking-documents/__tests__'), { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts: { 'test:edge': `node ${runnerPath}` } }));
    // Host policy pins this fixture's exact selector contract. It is never run.
    runnerBytes = 'export const reviewedRunner = { executable: "deno", args: ["test"], selector: "--function" };\n';
    approvedHash = hash(runnerBytes);
    await fs.writeFile(path.join(directory, runnerPath), runnerBytes);
    await fs.writeFile(path.join(directory, 'supabase/functions/booking-documents/__tests__/documents.test.ts'), 'Deno.test("documents", () => {});\n');
  });
  afterEach(async () => fs.rm(directory, { recursive: true, force: true }));

  it('resolves the observed wrong runner without executing code or changing declared coverage', async () => {
    const result = await resolveRequiredCheckRunnerCorrection(options());
    expect(result).toMatchObject({ name: check.name, previousCommand: check.command, command: 'npm run test:edge -- --function booking-documents', observedAt: 100,
      runnerIdentity: { scriptSha256: approvedHash, selector: '--function', functionName: 'booking-documents', verifiedBy: 'host-policy' } });
    expect(result.runnerIdentity.coverageHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result.runnerIdentity)).toBe(true);
    expect(check.command).toContain('vitest');
    expect(await verifyRequiredCheckRunnerIdentity({ ...options(), check: { ...check, command: result.command }, correction: result })).toEqual(result.runnerIdentity);
  });

  it('requires trusted host proof; arbitrary scripts merely mentioning Deno cannot authorize a correction', async () => {
    await expect(resolveRequiredCheckRunnerCorrection({ ...options(), verifyRunner: undefined })).rejects.toMatchObject({ code: 'required_check_runner_unverified' });
    await fs.writeFile(path.join(directory, runnerPath), '// deno --function\nconsole.log("pass");');
    await expect(resolveRequiredCheckRunnerCorrection(options())).rejects.toMatchObject({ code: 'required_check_runner_unverified' });
  });

  it('requires exact owner-configured digests and prepares known wrong Deno declarations before dispatch', async () => {
    const policy = createRequiredCheckRunnerPolicy([{ kind: 'edge-deno-function-v1', scriptSha256: approvedHash }]);
    const prepared = await prepareRequiredCheckDeclarations({ directory, checks: [check], verifyRunner: policy, now: () => 100 });
    expect(prepared.checks[0].command).toBe('npm run test:edge -- --function booking-documents');
    expect(prepared.history[0].previousCheck).toEqual(check);
    await expect(prepareRequiredCheckDeclarations({ directory, checks: [check], verifyRunner: createRequiredCheckRunnerPolicy([]) })).rejects.toMatchObject({ code: 'required_check_runner_unverified' });
    expect(requiredCheckRunnerPolicyFromEnvironment({ DEVRYAN_REQUIRED_CHECK_RUNNER_POLICIES: JSON.stringify([{ kind: 'edge-deno-function-v1', scriptSha256: approvedHash }]) })({ kind: 'edge-deno-function-v1', scriptSha256: approvedHash })).toBe(true);
    expect(() => createRequiredCheckRunnerPolicy([{ kind: 'edge-deno-function-v1', scriptSha256: approvedHash, command: 'true' }])).toThrow('policy_invalid');
    expect(() => requiredCheckRunnerPolicyFromEnvironment({ DEVRYAN_REQUIRED_CHECK_RUNNER_POLICIES: '{bad' })).toThrow('policy_invalid');
  });

  it.each([false, true])('dispatch rejects unverified Deno runners or persists configured correction before the child starts (configured=%s)', async configured => {
    const starts = [];
    const runtime = createWebManagedOrchestrationRuntime({ now: () => 100,
      persistence: { load: async () => null, save: async () => {} },
      readAgentCatalog: async () => [{ name: 'fixer', mode: 'all' }], validateAgentExecution: async () => true,
      requiredCheckRunnerPolicies: configured ? [{ kind: 'edge-deno-function-v1', scriptSha256: approvedHash }] : [],
      executor: { start: async (task, control) => { starts.push(task); await control.setChildSessionId('ses_child'); await control.markAccepted();
        return { status: 'completed', recoverablePreview: '**Status:** complete' }; } } });
    const request = { method: 'submit', params: { idempotencyKey: 'dispatch', rootSessionId: 'ses_root', dispatchGroupId: 'msg_dispatch',
      directory, mode: 'orchestrator', providerId: 'openai', modelId: 'model', agent: 'fixer', variant: null, label: 'Work', prompt: 'Implement', requiredChecks: [check] } };
    try {
      if (!configured) {
        await expect(runtime.handleRpc(request)).rejects.toMatchObject({ code: 'required_check_runner_unverified' });
        expect(starts).toEqual([]);
      } else {
        const result = await runtime.handleRpc(request, { dispatchObjectiveId: 'msg_objective' });
        expect(result.task.requiredChecks[0].command).toBe('npm run test:edge -- --function booking-documents');
        await runtime.handleRpc({ method: 'wait', params: { rootSessionId: 'ses_root', directory, taskId: result.task.taskId } });
        expect(starts).toHaveLength(1);
        expect(starts[0].requiredCheckCorrections[0].previousCheck).toEqual(check);
        expect(starts[0].dispatchObjectiveId).toBe('msg_objective');
        expect(await runtime.inspectRequiredChecks({ rootSessionId: 'ses_root', directory, objectiveId: 'msg_objective' })).toMatchObject({ ready: false });
      }
    } finally { await runtime.shutdown(); }
  });

  it('rejects runner/manifest replacement after policy lookup and before receipt use', async () => {
    const correction = await resolveRequiredCheckRunnerCorrection(options());
    await expect(resolveRequiredCheckRunnerCorrection({ ...options(), verifyRunner: async () => {
      await fs.writeFile(path.join(directory, runnerPath), 'changed'); return true;
    } })).rejects.toMatchObject({ code: 'required_check_runner_changed' });
    await expect(verifyRequiredCheckRunnerIdentity({ ...options(), correction, verifyRunner: () => true })).rejects.toMatchObject({ code: 'required_check_runner_changed' });
  });

  it('refuses unsupported command, unrelated coverage, altered package alias and non-Deno selectors', async () => {
    await expect(resolveRequiredCheckRunnerCorrection({ ...options(), check: { ...check, command: 'true' } })).rejects.toMatchObject({ code: 'required_check_runner_unsupported' });
    await expect(resolveRequiredCheckRunnerCorrection({ ...options(), check: { ...check, paths: ['unrelated'] } })).rejects.toMatchObject({ code: 'required_check_runner_coverage_mismatch' });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts: { 'test:edge': 'true' } }));
    await expect(resolveRequiredCheckRunnerCorrection(options())).rejects.toMatchObject({ code: 'required_check_runner_script_unavailable' });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts: { 'test:edge': `node ${runnerPath}` } }));
    await fs.writeFile(path.join(directory, 'supabase/functions/booking-documents/__tests__/documents.test.ts'), 'import { test } from "vitest"; test("x",()=>{});');
    await expect(resolveRequiredCheckRunnerCorrection(options())).rejects.toMatchObject({ code: 'required_check_runner_test_dialect_unverified' });
  });

  it('refuses empty selectors and paths escaping the repository through symlinks', async () => {
    const tests = path.join(directory, 'supabase/functions/booking-documents/__tests__');
    await fs.rm(path.join(tests, 'documents.test.ts'));
    await expect(resolveRequiredCheckRunnerCorrection(options())).rejects.toMatchObject({ code: 'required_check_runner_tests_unavailable' });
    await fs.symlink(os.tmpdir(), path.join(tests, 'outside'));
    await expect(resolveRequiredCheckRunnerCorrection(options())).rejects.toMatchObject({ code: 'required_check_runner_scope' });
  });

  it('runs correction through the native root action, retains audit after restart and fences changed runners in receipts', async () => {
    const task = { ...createManagedTaskRecord({ taskId: 'dvr_task_correct', idempotencyKey: 'correct', rootSessionId: 'ses_root',
      parentTaskId: null, dispatchGroupId: 'msg_dispatch', dispatchObjectiveId: 'msg_objective', directory, sequence: 1, mode: 'orchestrator',
      providerId: 'openai', modelId: 'model', agent: 'fixer', variant: null, label: 'Tests', prompt: 'Implement', attempt: 1,
      priorTaskId: null, executionKind: 'start', createdAt: 1, timeoutAt: null, requiredChecks: [check] }),
      status: 'completed', childSessionId: 'ses_child', leaseToken: 'dvr_lease_correct', startedAt: 2, finishedAt: 3,
      requiredCheckReceipts: [{ name: check.name, callId: 'old_call', messageId: 'old_message', status: 'failed', exitCode: 1, observedAt: 4, contentHash: 'a'.repeat(64) }] };
    let saved = { version: 1, tasks: [task], resultEnvelopes: [{ ...createManagedTaskResultEnvelope(task, { sequence: 2, createdAt: 4, resumable: false }), action: 'collect', acknowledgedAt: 5 }] };
    const settings = { now: () => 100, persistence: { load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); } },
      requiredCheckRunnerPolicies: [{ kind: 'edge-deno-function-v1', scriptSha256: approvedHash }],
      executor: { start: async () => { throw Error('Correction must not dispatch work'); } } };
    let runtime = createWebManagedOrchestrationRuntime(settings);
    const scope = { rootSessionId: 'ses_root', directory, objectiveId: 'msg_objective' };
    const request = { method: 'correct_check', params: { ...scope, taskId: task.taskId, checkName: check.name, expectedCommand: check.command } };
    const nativeInput = { tool: 'devryan_task', sessionID: 'ses_root', directory, messageID: 'msg_correct', callID: 'call_correct',
      authorization: { input: { provenance: { id: 'devryan.managed-task', kind: 'plugin' } } },
      input: { action: 'correct_check', task_id: task.taskId, check_name: check.name, expected_command: check.command } };
    const owner = createNativeManagedTaskOwner({ admissionOwner: { recheckExecution: async () => {}, withPermit: async (_input, run) => run(),
      withManagedTaskCatalogInvocation: async (_input, run) => run() },
      taskContext: { authorizeNativeTaskInvocation: async () => ({ readOnly: false, objectiveID: scope.objectiveId }),
        authorizeNativeCheckCorrectionTask: async (_input, candidate) => { if (candidate.dispatchObjectiveId !== scope.objectiveId) throw Error('objective changed'); } },
      getManagedRuntime: () => runtime });
    try {
      await runtime.initialize();
      await expect(runtime.handleRpc(request)).rejects.toMatchObject({ code: 'required_check_correction_authority_required' });
      await expect(owner({ ...nativeInput, input: { ...nativeInput.input, runnerIdentity: { scriptSha256: approvedHash } } })).rejects.toMatchObject({ code: 'native_task_input_invalid' });
      const corrected = await owner(nativeInput);
      expect(corrected.correction.command).toBe('npm run test:edge -- --function booking-documents');
      expect(corrected.verification.ready).toBe(false);
      expect(saved.tasks[0].requiredCheckReceipts).toEqual([]);
      expect(saved.tasks[0].requiredCheckCorrections[0].previousReceipt.exitCode).toBe(1);
      await runtime.shutdown(); runtime = createWebManagedOrchestrationRuntime(settings); await runtime.initialize();
      expect(saved.tasks[0].requiredCheckCorrections).toHaveLength(1);
      await expect(owner(nativeInput)).rejects.toMatchObject({ code: 'required_check_correction_stale' });
      const command = corrected.correction.command;
      const invocation = { sessionId: 'ses_root', directory, tool: 'bash', command, callId: 'check_new', messageId: 'msg_new' };
      expect(await runtime.observeNativeRequiredCheck({ ...invocation, phase: 'before' })).toMatchObject({ tracked: true });
      await runtime.observeNativeRequiredCheck({ ...invocation, phase: 'after', exitCode: 0 });
      expect(await runtime.inspectRequiredChecks(scope)).toMatchObject({ ready: true });
      await fs.writeFile(path.join(directory, runnerPath), `${runnerBytes}\n// changed after success`);
      expect(await runtime.inspectRequiredChecks(scope)).toMatchObject({ ready: false, status: 'blocked' });
      await fs.writeFile(path.join(directory, runnerPath), runnerBytes);
      const second = { ...invocation, callId: 'check_changed', messageId: 'msg_changed' };
      await runtime.observeNativeRequiredCheck({ ...second, phase: 'before' });
      await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts: { 'test:edge': `node ${runnerPath}` }, changed: true }));
      await runtime.observeNativeRequiredCheck({ ...second, phase: 'after', exitCode: 0 });
      expect(await runtime.inspectRequiredChecks(scope)).toMatchObject({ ready: false, status: 'blocked' });
      expect(saved.tasks[0].requiredCheckReceipts[0].status).toBe('blocked');
      const refreshed = { ...invocation, callId: 'check_manifest_refreshed', messageId: 'msg_manifest_refreshed' };
      await runtime.observeNativeRequiredCheck({ ...refreshed, phase: 'before' });
      await runtime.observeNativeRequiredCheck({ ...refreshed, phase: 'after', exitCode: 0 });
      expect(await runtime.inspectRequiredChecks(scope)).toMatchObject({ ready: true });
    } finally { await runtime.shutdown(); }
  });
});
