// One real confined tool call. No installed-app state or provider access.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { DevRyanBrowserPlugin } from '../../../web/server/default-config/plugins/devryan-browser.mjs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { invocation, context, cancelAfterMs, protectedFile } = JSON.parse(input);
await assert.rejects(fs.writeFile(protectedFile, 'must not write'), { code: 'EPERM' });
const plugin = await DevRyanBrowserPlugin();
const controller = new AbortController();
const timer = cancelAfterMs && setTimeout(() => controller.abort(), cancelAfterMs);
try {
  const output = await plugin.tool.devryan_browser.execute(invocation, { ...context, abort: controller.signal });
  assert.equal(JSON.parse(output).results.find(row => row.command === 'eval')?.output, '"confined"');
  assert.ok(!cancelAfterMs, 'Cancellation must fail the call');
  process.stdout.write(JSON.stringify({ output }));
} catch (error) {
  if (!cancelAfterMs || error.code !== 'DEVRYAN_BROWSER_COMMAND_ABORTED') throw error;
  const details = JSON.parse(error.message.slice(error.message.indexOf('{')));
  assert.equal(details.results.find(row => row.command === 'eval')?.output, '"confined"');
  assert.equal(details.recordingFinalized, true, error.message);
  assert.ok(!details.recordingIncomplete, error.message);
  process.stdout.write(JSON.stringify({ cancelled: true, details }));
} finally { clearTimeout(timer); }
