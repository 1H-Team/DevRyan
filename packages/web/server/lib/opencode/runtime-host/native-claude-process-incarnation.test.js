import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { captureClaudeTransportIncarnation } from './native-claude-process-incarnation.js';

test('host attests the actual supervised executor and rejects missing or settled executors', async () => {
  if (process.platform === 'win32') {
    await expect(captureClaudeTransportIncarnation({ pid: process.pid, exitCode: null, signalCode: null }, process.execPath)).rejects.toThrow('unconfirmed');
    return;
  }
  const child = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});
    process.on('SIGTERM',()=>{worker.kill();process.exit();});
    setInterval(()=>{},1000);
  `], { stdio: 'ignore' });
  const exited = once(child, 'close');
  try {
    const first = await captureClaudeTransportIncarnation(child, process.execPath);
    expect(first.pid).not.toBe(child.pid);
    expect(await captureClaudeTransportIncarnation(child, process.execPath)).toEqual(first);
    expect(first.startIdKind).toBe(process.platform === 'darwin' ? 'darwin-ps-lstart'
      : process.platform === 'win32' ? 'windows-start-ticks' : 'linux-proc-start-ticks');
    process.kill(first.pid, 'SIGTERM');
    await expect(captureClaudeTransportIncarnation(child, process.execPath)).rejects.toThrow('unconfirmed');
    child.kill(); await exited;
    await expect(captureClaudeTransportIncarnation(child, process.execPath)).rejects.toThrow('unconfirmed');
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } }
});
