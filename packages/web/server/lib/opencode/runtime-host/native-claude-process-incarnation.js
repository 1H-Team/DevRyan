import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { parseClaudeTransportIncarnation } from './native-claude-transport-protocol.js';

const execute = promisify(execFile);
const hash = text => createHash('sha256').update(text).digest('hex');
const probe = async (command, args) => {
  try {
    return (await execute(command, args, {
      timeout: process.platform === 'win32' ? 10000 : 2000, maxBuffer: 128 * 1024, windowsHide: true,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC0' },
    })).stdout.trim();
  } catch { throw Error('native_claude_transport_unconfirmed'); }
};

/** Match Meridian's persisted incarnation format using the host's owned child,
 * never a worker-supplied PID or a generated substitute for OS identity. */
async function observeClaudeTransportIncarnation(supervisor, executable) {
  const live = () => Number.isSafeInteger(supervisor.pid) && supervisor.pid > 0 && supervisor.exitCode === null && supervisor.signalCode === null;
  if (!live() || typeof executable !== 'string' || !executable.startsWith('/')) throw Error('native_claude_transport_unconfirmed');
  const executor = async () => {
    if (!live()) throw Error('native_claude_transport_unconfirmed');
    let candidates;
    if (process.platform === 'darwin') {
      const children = (await probe('/usr/bin/pgrep', ['-P', String(supervisor.pid)])).split(/\s+/);
      if (children.length > 16 || children.some(pid => !/^[1-9][0-9]{0,9}$/.test(pid))) throw Error('native_claude_transport_unconfirmed');
      const output = await probe('/bin/ps', ['-p', children.join(','), '-o', 'pid=,ppid=,pgid=,comm=']);
      candidates = output.split('\n').flatMap(line => {
        const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        return row && Number(row[2]) === supervisor.pid && Number(row[1]) === Number(row[3]) && row[4] === executable ? [Number(row[1])] : [];
      });
    } else if (process.platform === 'linux') {
      const children = (await fs.readFile(`/proc/${supervisor.pid}/task/${supervisor.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
      candidates = [];
      for (const child of children) {
        const pid = Number(child), stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
        const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(/\s+/);
        if (Number(fields[1]) === supervisor.pid && Number(fields[2]) === pid && await fs.readlink(`/proc/${pid}/exe`).catch(() => '') === executable) candidates.push(pid);
      }
    } else throw Error('native_claude_transport_unconfirmed');
    if (!live() || candidates.length !== 1) throw Error('native_claude_transport_unconfirmed');
    return candidates[0];
  };
  // The native supervisor forks before exec. Wait only for that owned child to
  // become the exact reviewed executable; never attest the transient launcher.
  let pid;
  const deadline = AbortSignal.timeout(2000);
  for (;;) {
    try { pid = await executor(); break; }
    catch (error) { if (!live() || deadline.aborted) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  let hostId, bootId, startId, startIdKind;
  if (process.platform === 'darwin') {
    const [hardware, boot, start] = await Promise.all([
      probe('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']),
      probe('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']),
      probe('/bin/ps', ['-p', String(pid), '-o', 'lstart=']),
    ]);
    const machine = hardware.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"/)?.[1]?.toLowerCase();
    if (!machine || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(machine)) throw Error('native_claude_transport_unconfirmed');
    hostId = hash(`darwin:${machine}`); bootId = boot.toLowerCase(); startId = start; startIdKind = 'darwin-ps-lstart';
  } else if (process.platform === 'linux') {
    const machine = await fs.readFile('/etc/machine-id', 'utf8').catch(() => fs.readFile('/var/lib/dbus/machine-id', 'utf8'));
    const namespace = await fs.readlink('/proc/self/ns/pid');
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    if (!/^[a-fA-F0-9]{32}$/.test(machine.trim()) || !/^pid:\[[0-9]+\]$/.test(namespace) || !stat.startsWith(`${pid} (`)) throw Error('native_claude_transport_unconfirmed');
    const boundary = stat.lastIndexOf(') ');
    if (boundary < 0) throw Error('native_claude_transport_unconfirmed');
    hostId = hash(`linux:${machine.trim().toLowerCase()}:${namespace}`);
    bootId = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim().toLowerCase();
    startId = stat.slice(boundary + 2).trim().split(/\s+/)[19]; startIdKind = 'linux-proc-start-ticks';
  } else throw Error('native_claude_transport_unconfirmed');
  if (await executor() !== pid) throw Error('native_claude_transport_unconfirmed');
  return parseClaudeTransportIncarnation({ version: 1, pid, hostId, bootId, startId, startIdKind });
}

export async function captureClaudeTransportIncarnation(supervisor, executable) {
  try { return await observeClaudeTransportIncarnation(supervisor, executable); }
  catch { throw Object.assign(Error('native_claude_transport_unconfirmed'), { code: 'native_claude_transport_unconfirmed' }); }
}
