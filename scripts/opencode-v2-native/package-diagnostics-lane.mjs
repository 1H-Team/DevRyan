import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readSessionExecutionReceipt } from '../../packages/harness-runtime/lib/session-execution.js';

/** A real compiler failure must disappear only after a published native edit. */
export async function runCompiledDiagnostics({ invoke, runtime, directory, sessionID }) {
  const file = 'native-diagnostic.cjs';
  const command = `'${process.execPath.replaceAll("'", "'\\''")}' --check ${file}`;
  await invoke({ id: 'cli-diagnostic-seed', tool: 'write', input: { path: file, content: 'const answer = ;\n' } });
  const failed = await invoke({ id: 'cli-diagnostic-fail', tool: 'shell', input: { command } });
  const before = await runtime.leaseForCall({ directory, sessionID, callID: failed.callID });
  const failedReceipt = await readSessionExecutionReceipt(before);
  assert.equal(failedReceipt.terminated, true); assert.equal(failedReceipt.confined, true);
  assert.notEqual(failedReceipt.exitCode, 0);
  assert.match(failed.state.output, /SyntaxError/);
  await invoke({ id: 'cli-diagnostic-fix', tool: 'edit', input: { path: file, oldString: 'answer = ;', newString: 'answer = 42;' } });
  assert.equal(await fs.readFile(path.join(directory, file), 'utf8'), 'const answer = 42;\n');
  const passed = await invoke({ id: 'cli-diagnostic-pass', tool: 'shell', input: { command } });
  const after = await runtime.leaseForCall({ directory, sessionID, callID: passed.callID });
  const passedReceipt = await readSessionExecutionReceipt(after);
  assert.equal(passedReceipt.terminated, true); assert.equal(passedReceipt.confined, true);
  assert.equal(passedReceipt.exitCode, 0); assert.doesNotMatch(passed.state.output, /SyntaxError/);
  return { id: 'compiled-cli-diagnostic-fail-fix-pass', status: 'passed',
    source: 'actual-node-syntax-check-supervised-native-shell-and-published-native-edit',
    callIDs: [failed.callID, passed.callID], failedReceipt, passedReceipt };
}
