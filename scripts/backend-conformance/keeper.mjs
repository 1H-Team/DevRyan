#!/usr/bin/env node
// The keeper (BH2 fix; arm-groups.mjs): started by a harness process in a
// session of its own, it holds a pipe from that process. On stdin, one JSON
// line each:
//   {"watch":<record>}   an arm group (or an escaped process) to kill if the harness dies; acknowledged
//                        on stdout with {"watching":<key>} once held
//   {"forget":<key>}     that group is gone; nothing to do for it any more
// When stdin ends (the harness exited, or was killed by any signal) the keeper
// continues and kills exactly the groups it still holds, each after checking
// that its leader is still the recorded process, and exits. It never kills by
// name or pattern, and it is never in the group of an arm.
import { killRecorded, recordKey } from './arm-groups.mjs';

const held = new Map();
let buffered = '';
const say = (value) => { try { process.stdout.write(`${JSON.stringify(value)}\n`); } catch { /* the harness is gone */ } };
process.stdout.on('error', () => {});
// Ctrl-C in the harness's terminal does not reach this session; any other end is the pipe's.
for (const signal of ['SIGINT', 'SIGHUP']) process.on(signal, () => {});

const finish = () => {
  for (const record of held.values()) killRecorded(record);
  process.exit(0);
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message?.watch) { const key = recordKey(message.watch); held.set(key, message.watch); say({ watching: key }); }
    if (typeof message?.forget === 'string') held.delete(message.forget);
  }
});
process.stdin.on('end', finish);
process.stdin.on('error', finish);
say({ ready: process.pid });
