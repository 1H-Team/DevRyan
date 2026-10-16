import { expect, it } from 'vitest';
import { inspect } from 'node:util';
import { createObservedNativeClaudeCredentialCommand, runNativeClaudeCredentialCommand } from './native-provider-runtime-owner.js';

it.each([36,44])('removes command, argument and stderr material from actual command failures while preserving exit %i', async code => {
  let failure;
  try{
    await runNativeClaudeCredentialCommand(process.execPath,['-e',`process.stderr.write('synthetic-private-stderr');process.exit(${code})`,'synthetic-private-argument'],{});
  }catch(error){failure=error;}
  expect(failure).toMatchObject({message:'claude_credential_command_failed',code});
  expect(inspect(failure)).not.toMatch(/synthetic-private|process\.stderr|cmd:|stderr:/);
  expect(Object.keys(failure)).toEqual(['code']);
});

it('reports only phase and bounded exit code without altering arguments, results or errors', async () => {
  const rows = [], calls = []; let failure;
  const result = { stdout: 'synthetic private credential' }, options = { timeout: 5000 };
  const execute = async (...args) => { calls.push(args); if (failure) throw failure; return result; };
  const observed = createObservedNativeClaudeCredentialCommand({ execute, onDiagnostic: row => rows.push(row) });
  for (const [args, phase] of [[['find-generic-password', '-s', 'private-service'], 'probe'], [['find-generic-password', '-w'], 'read'], [['add-generic-password', '-w', 'synthetic-secret'], 'write'], [['delete-generic-password'], 'delete']]) {
    expect(await observed('/usr/bin/security', args, options)).toBe(result); expect(calls.at(-1)).toEqual(['/usr/bin/security', args, options]);
    expect(rows.at(-1)).toEqual({ phase, exitCode: 0 }); expect(Object.isFrozen(rows.at(-1))).toBe(true);
  }
  failure = Object.assign(Error('synthetic raw credential must not be logged'), { code: 36, stdout: 'synthetic secret', stderr: 'private system output' });
  await expect(observed('/usr/bin/security', ['add-generic-password'], options)).rejects.toBe(failure);
  expect(rows.at(-1)).toEqual({ phase: 'write', exitCode: 36 });
  failure.code = 'ENOENT'; await expect(observed('/usr/bin/security', ['find-generic-password', '-w'], options)).rejects.toBe(failure);
  expect(rows.at(-1)).toEqual({ phase: 'read', exitCode: null });
  const before = rows.length; failure = undefined;
  await observed('/unowned/security', ['find-generic-password'], options); await observed('/usr/bin/security', ['unrelated'], options);
  expect(rows).toHaveLength(before);
  expect(JSON.stringify(rows)).not.toMatch(/synthetic|secret|service|stdout|stderr|HOME/);
});
it('does not release or diagnose before the original command settles and a diagnostic failure cannot change its result', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); const rows = [];
  const observed = createObservedNativeClaudeCredentialCommand({ execute: async () => gate, onDiagnostic: row => { rows.push(row); throw Error('diagnostic observer failed'); } });
  const pending = observed('/usr/bin/security', ['find-generic-password', '-w'], { signal: new AbortController().signal });
  await Promise.resolve(); expect(rows).toEqual([]); const result = { stdout: 'synthetic private value' }; release(result);
  expect(await pending).toBe(result); expect(rows).toEqual([{ phase: 'read', exitCode: 0 }]);
});
