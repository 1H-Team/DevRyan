// A fake scheduler process for the process candidate's self-test
// (process-candidate.test.mjs): it speaks the protocol of process-candidate.mjs
// and does one thing by its argument: `refuse` refuses every case at its first
// input; `version` answers the hello with another version; `exit` ends at its
// first input without an answer; `garbage` answers its first input with a line
// that is no JSON.
import { createInterface } from 'node:readline';

const mode = process.argv[2];
const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.t === 'hello') { send({ r: { protocol: 'devryan-scheduler-candidate', version: mode === 'version' ? 2 : 1, members: [] } }); return; }
  if (message.t === 'sync') { send({ r: [] }); return; }
  if (mode === 'exit') process.exit(3);
  if (mode === 'garbage') { process.stdout.write('not json\n'); return; }
  send({ q: 'refuse', c: message.c ?? 0, detail: 'anything: the fake refuses every case' });
});
