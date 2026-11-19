// How a recorded process is identified on Linux: by the kernel's start tick
// and its command line, read from /proc text. The parser is pure, so it is
// tested on every platform.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linuxProcessFacts, processFacts } from './arm-groups.mjs';

// /proc/<pid>/stat: pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime
// cutime cstime priority nice num_threads itrealvalue starttime …
const stat = (comm, state, start) => `4242 (${comm}) ${state} 1 4242 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 7 0 ${start} 1000000 200 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 1 0 0 0 0 0\n`;

test('the start is the start tick (field 22) and the command is the command line', () => {
  assert.deepEqual(linuxProcessFacts(stat('node', 'S', '987654'), '/usr/bin/node\0/work/group-host.mjs\0--data-root=/tmp/run/data\0'),
    { start: 'ticks 987654', command: '/usr/bin/node /work/group-host.mjs --data-root=/tmp/run/data' });
});

test('a command name with spaces and parentheses does not shift the fields', () => {
  assert.equal(linuxProcessFacts(stat('weird) name (x', 'T', '12'), 'a\0b\0').start, 'ticks 12');
  assert.equal(linuxProcessFacts(stat('MainThread', 'R', '77'), 'node\0x.mjs\0').start, 'ticks 77');
});

test('a zombie, or a process with no command line, is named as ps names it', () => {
  assert.equal(linuxProcessFacts(stat('node', 'Z', '5'), '').command, '<defunct>');
  assert.equal(linuxProcessFacts(stat('node', 'S', '5'), '').command, '<defunct>');
});

test('text that is not a stat line gives nothing', () => {
  assert.equal(linuxProcessFacts('', ''), null);
  assert.equal(linuxProcessFacts('4242 (node) S 1 2 3', 'node\0'), null);
  assert.equal(linuxProcessFacts('4242 (node) S 1 4242 4242 0 -1 0 0 0 0 0 0 0 0 0 20 0 7 0 soon 1 2', 'node\0'), null);
});

test('this process has facts, the same on two reads, and its command line holds its script', () => {
  const first = processFacts([process.pid]).get(process.pid);
  const second = processFacts([process.pid]).get(process.pid);
  assert.ok(first && second);
  assert.equal(first.start, second.start);
  assert.match(first.command, /arm-groups\.test\.mjs/);
});
