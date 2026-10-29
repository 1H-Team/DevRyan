// One foreground verification call under the real confinement launcher, the
// replacement for a background server in a delegated task: the call starts a
// server, stops it on exit, waits until it answers, checks it and leaves its
// evidence in $DEVRYAN_ARTIFACT_DIR (one-call-verification.test.ts).
import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from '../../packages/harness-runtime/lib/session-changes-git.js';
import { createSessionMutationRuntime } from '../../packages/harness-runtime/lib/session-mutations.js';
import { startSessionExecution } from '../../packages/harness-runtime/lib/session-execution.js';

export const ONE_CALL_PAGE = '<h1>fixture page</h1>\n';
const SERVER = [
  "const http = require('node:http'), fs = require('node:fs'), path = require('node:path');",
  "const server = http.createServer((request, response) => response.end(fs.readFileSync('index.html')));",
  "server.listen(0, '127.0.0.1', () => fs.writeFileSync(path.join(process.env.TMPDIR, 'port'), String(server.address().port)));",
].join('\n');
const CALL = [
  '"$NODE" serve.js & server=$!',
  "trap 'kill $server' EXIT",
  'for i in $(seq 100); do [ -s "$TMPDIR/port" ] && break; sleep 0.1; done',
  'port=$(cat "$TMPDIR/port"); echo "$port" > "$DEVRYAN_ARTIFACT_DIR/port.txt"',
  'for i in $(seq 100); do curl -fs "http://127.0.0.1:$port/" -o "$DEVRYAN_ARTIFACT_DIR/page.html" && break; sleep 0.1; done',
  'grep -q "fixture page" "$DEVRYAN_ARTIFACT_DIR/page.html" && echo checked',
].join('\n');

export async function runOneCallVerification({ launcher, root, node }) {
  const directory = path.join(root, 'project');
  await fs.mkdir(directory); await git(directory, ['init', '--quiet']);
  await fs.writeFile(path.join(directory, '.gitignore'), '.artifacts/\n');
  await fs.writeFile(path.join(directory, 'index.html'), ONE_CALL_PAGE);
  await fs.writeFile(path.join(directory, 'serve.js'), SERVER);
  await git(directory, ['add', '.gitignore', 'index.html', 'serve.js']);
  await git(directory, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const runtime = createSessionMutationRuntime({ directory: path.join(root, 'ledger') });
  try {
    const lease = await runtime.begin({ directory, sessionID: 'ses_oneCall', userMessageID: 'msg_oneCall',
      messageID: 'msg_oneCall_assistant', callID: 'call_oneCall' });
    await runtime.claimLease({ directory, token: lease.token, kind: 'process' });
    let stdout = '', stderr = '';
    const started = await startSessionExecution({ launcher, lease, command: '/bin/sh', args: ['-c', CALL],
      env: { PATH: '/usr/bin:/bin', NODE: node }, socketDirectory: null, workerBrowsers: false,
      onOutput: ({ stream, data }) => { if (stream === 'stdout') stdout += data; else stderr += data; } });
    const receipt = await started.result;
    const published = (await runtime.finish({ directory, token: lease.token })).files;
    return { receipt, stdout, stderr, directory, artifactDirectory: started.artifactDirectory ?? null, published };
  } finally { await runtime.drain(); }
}
