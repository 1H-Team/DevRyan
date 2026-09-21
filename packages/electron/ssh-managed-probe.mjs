/** Runs over the authenticated SSH control connection. The ownership key stays
 * in a private remote file and never appears in command output or HTTP. */
async function remoteManagedOperation(input) {
  const fs = await import('node:fs/promises'), crypto = await import('node:crypto');
  const { constants } = await import('node:fs');
  const path = await import('node:path'), os = await import('node:os');
  const directory = path.join(os.homedir(), '.config', 'openchamber', 'ssh-managed');
  const file = path.join(directory, crypto.createHash('sha256').update(input.id).digest('hex') + '.key');
  const readKey = async () => {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('ssh_owner_file_invalid');
      const key = await handle.readFile('utf8');
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('ssh_owner_file_invalid');
      return key;
    } finally { await handle.close(); }
  };
  if (input.action === 'start') {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(crypto.randomBytes(32).toString('hex')); await handle.sync(); }
      finally { await handle.close(); }
    } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    const key = await readKey();
    const { spawn } = await import('node:child_process');
    const child = spawn('openchamber', ['serve', '--hostname', '127.0.0.1', '--port', String(input.port)], {
      env: { ...process.env, OPENCHAMBER_RUNTIME: 'ssh-remote', DEVRYAN_SSH_INSTANCE_ID: input.id,
        DEVRYAN_SSH_OWNER_TOKEN: key, ...(input.password ? { OPENCHAMBER_UI_PASSWORD: input.password } : {}) },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (code !== 0) throw new Error('ssh_managed_start_failed');
    return { state: 'started', port: input.port };
  }
  const nonce = crypto.randomBytes(32).toString('hex');
  let response;
  try { response = await fetch(`http://127.0.0.1:${input.port}/health?sshChallenge=${nonce}`, { signal: AbortSignal.timeout(3000) }); }
  catch (cause) {
    if (cause.code === 'ECONNREFUSED' || cause.cause?.code === 'ECONNREFUSED') return { state: 'absent' };
    return { state: 'unverified' };
  }
  let key;
  try { key = await readKey(); } catch { await response.body?.cancel(); return { state: 'unverified' }; }
  if (!response.ok) { await response.body?.cancel(); return { state: 'unverified' }; }
  const reader = response.body?.getReader(); let size = 0, text = '';
  if (!reader) return { state: 'unverified' };
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 64 * 1024) { await reader.cancel(); return { state: 'unverified' }; }
    text += decoder.decode(value, { stream: true });
  }
  const identity = JSON.parse(text).sshManaged;
  if (!identity || identity.protocol !== 1 || identity.id !== input.id || identity.host !== '127.0.0.1'
    || identity.port !== input.port || identity.nonce !== nonce || typeof identity.runtimeInstanceId !== 'string'
    || !/^[a-f0-9]{64}$/.test(identity.proof ?? '')) return { state: 'unverified' };
  const claim = { protocol: 1, id: identity.id, version: identity.version, runtimeInstanceId: identity.runtimeInstanceId,
    host: identity.host, port: identity.port, nonce: identity.nonce };
  const expected = crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(claim)).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(identity.proof, 'hex'))) return { state: 'unverified' };
  if (input.action === 'stop') {
    const claim = { action: 'shutdown', id: input.id, runtimeInstanceId: identity.runtimeInstanceId,
      port: input.port, at: Date.now(), nonce };
    const proof = crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(claim)).digest('hex');
    const stopped = await fetch(`http://127.0.0.1:${input.port}/health/ssh-shutdown`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...claim, proof }),
      signal: AbortSignal.timeout(3000),
    });
    await stopped.body?.cancel();
    return { state: stopped.ok ? 'stopped' : 'unverified' };
  }
  return { state: identity.version === input.version ? 'ready' : 'version_mismatch', port: input.port };
}

export function managedSshOperationScript(input) {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || typeof input.id !== 'string' || !input.id) {
    throw new Error('Invalid managed SSH identity');
  }
  return `(${remoteManagedOperation.toString()})(${JSON.stringify(input)}).then(value => process.stdout.write(JSON.stringify(value)), () => { process.stderr.write('Managed SSH ownership verification failed'); process.exitCode = 1 })`;
}
