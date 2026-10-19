import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { sessionExecutionProfile, prepareSessionExecution } from '@devryan/harness-runtime/lib/session-execution.js';
import { readOnlyShellLease } from './native-readonly-shell.js';
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-plan-shell-'))); roots.push(root);
  const snapshot = path.join(root, 'snapshot'), project = path.join(root, 'project'), auxiliaryDirectory = path.join(root, 'cache');
  for (const directory of [snapshot, project, auxiliaryDirectory]) await fs.mkdir(directory);
  await fs.writeFile(path.join(snapshot, 'tracked'), 'original'); await fs.writeFile(path.join(project, 'tracked'), 'canonical');
  await fs.symlink(project, path.join(snapshot, 'project-link'));
  const lease = { token: 'owned', scope: { sessionID: 'ses_plan', callID: 'call_shell' }, viewDirectory: snapshot, workingDirectory: snapshot,
    projectDirectory: project, auxiliaryDirectory, inputs: { writableDirectories: [project] } };
  return { root, snapshot, project, lease };
};
if (process.platform !== 'win32') it('keeps supervisor ownership and suppresses all writable input grants', async () => {
  const f = await fixture(), lease = await readOnlyShellLease(f.lease);
  expect(lease.scope).toBe(f.lease.scope); expect(lease.token).toBe('owned');
  expect(path.dirname(lease.viewDirectory)).toBe(path.dirname(f.lease.viewDirectory));
  expect(lease.inputs).toBeUndefined(); expect(lease.projectDirectory).toBeUndefined();
  expect(lease.logicalWorkingDirectory).toBe(f.snapshot);
  expect(lease.readOnly).toBe(true);
  const prepared = await prepareSessionExecution({ launcher: path.join(f.root, 'launcher'), lease, socketDirectory: null });
  expect(prepared.arguments[3]).toBe(path.join(f.root, 'termination.json'));
  const profile = await fs.readFile(prepared.profile, 'utf8');
  expect(profile).not.toContain(`(require-not (subpath "${f.snapshot}"))`);
  expect(profile).not.toContain(`(require-not (subpath "${f.project}"))`);
  expect(profile).toContain('(deny network*)');
  expect(prepared.environment.DEVRYAN_EXECUTION_READ_ONLY).toBe('1');
});
it.each(['darwin', 'linux'])('%s Plan shell retains the real inspection directory', async platform => {
  const f = await fixture();
  expect((await readOnlyShellLease(f.lease, { platform })).logicalWorkingDirectory).toBe(f.snapshot);
});
it('refuses when the launcher cannot grant a read-only workspace and isolated network', async () => {
  const f = await fixture();
  await expect(readOnlyShellLease(f.lease, { platform: 'win32' })).rejects.toMatchObject({ code: 'native_plan_confinement_unavailable' });
  expect(await fs.readdir(f.root)).not.toContain('read-only-worktree');
});
if (process.platform === 'darwin') it('macOS confined shell allows inspection and denies write/delete/rename/symlink/ignored-output escapes', async () => {
  const f = await fixture(), lease = await readOnlyShellLease(f.lease);
  const scratchDirectory = path.join(f.root, 'scratch'); await fs.mkdir(scratchDirectory);
  const profile = sessionExecutionProfile({ viewDirectory: lease.viewDirectory, scratchDirectory, auxiliaryDirectory: lease.auxiliaryDirectory, readOnly: true });
  const paths = [path.join(f.snapshot, 'tracked'), path.join(f.project, 'tracked'), path.join(f.snapshot, 'project-link', 'tracked'), path.join(f.snapshot, 'ignored-output')];
  const script = `const fs=require('node:fs');const results={read:fs.readFileSync(${JSON.stringify(paths[0])},'utf8'),denied:[]};
    for(const file of ${JSON.stringify(paths)}){for(const op of [()=>fs.writeFileSync(file,'changed'),()=>fs.unlinkSync(file),()=>fs.renameSync(file,file+'.renamed')]){try{op();results.denied.push(false);}catch(e){results.denied.push(['EPERM','EACCES','ENOENT'].includes(e.code));}}}
    fs.writeFileSync(${JSON.stringify(path.join(scratchDirectory, 'safe'))},'scratch');console.log(JSON.stringify(results));`;
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', script], { cwd: f.snapshot, encoding: 'utf8' });
  expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ read: 'original', denied: Array(12).fill(true) });
  expect(await fs.readFile(paths[0], 'utf8')).toBe('original'); expect(await fs.readFile(paths[1], 'utf8')).toBe('canonical');
  const implementation = sessionExecutionProfile({ viewDirectory:f.snapshot, scratchDirectory });
  const written = spawnSync('/usr/bin/sandbox-exec', ['-p', implementation, process.execPath, '-e',
    `require('node:fs').writeFileSync('tracked','approved implementation');`], { cwd:f.snapshot, encoding:'utf8' });
  expect(written.status).toBe(0);
  expect(await fs.readFile(paths[0], 'utf8')).toBe('approved implementation');
  expect(await fs.readFile(paths[1], 'utf8')).toBe('canonical');
});
// With SIP disabled (GitHub macOS runners) libuv's posix_spawn aborts with ENOSYS inside the
// sandbox, so this real-network probe only runs where user Macs run it: with SIP enabled.
const sipEnabled = process.platform === 'darwin' && /enabled/.test(spawnSync('/usr/bin/csrutil', ['status'], { encoding: 'utf8' }).stdout ?? '');
if (sipEnabled) it('macOS Plan shell denies actual local POST and git push while permitting reviewed inspection', async () => {
  const f = await fixture(), lease = await readOnlyShellLease(f.lease);
  const scratchDirectory = path.join(f.root, 'scratch'); await fs.mkdir(scratchDirectory);
  const gitEnv = { ...process.env, HOME:scratchDirectory, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TEMPLATE_DIR:'', GIT_TERMINAL_PROMPT:'0', NO_PROXY:'127.0.0.1', no_proxy:'127.0.0.1' };
  for (const args of [['init', '--quiet', f.snapshot], ['-C', f.snapshot, 'add', 'tracked'],
    ['-C', f.snapshot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Fixture']]) {
    expect(spawnSync('git', args, { env:gitEnv, encoding: 'utf8' }).status).toBe(0);
  }
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('unexpected'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const profile = sessionExecutionProfile({ viewDirectory: lease.viewDirectory, scratchDirectory, readOnly: true });
    const script = `const {spawnSync}=require('node:child_process');const fs=require('node:fs');
      const post=spawnSync('/usr/bin/curl',['--noproxy','*','--max-time','1','--request','POST',${JSON.stringify(url)}],{encoding:'utf8'});
      const push=spawnSync('/usr/bin/git',['-c','credential.helper=','-c','core.hooksPath=/dev/null','push',${JSON.stringify(url + '/repo')},'HEAD'],{encoding:'utf8',timeout:2000});
      console.log(JSON.stringify({read:fs.readFileSync('tracked','utf8'),post:post.status,push:push.status}));`;
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', script], { cwd: f.snapshot,
      env: gitEnv, encoding: 'utf8', timeout:5000 });
    expect(result.status, `signal=${result.signal} stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);
    const outcomes = JSON.parse(result.stdout);
    expect(outcomes.read).toBe('original'); expect(outcomes.post).toBe(7); expect(outcomes.push).toBe(128);
    expect(requests).toBe(0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
