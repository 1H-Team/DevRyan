#!/usr/bin/env node
// A writer that never stops (BH2 self-test only): rewrites <root>/counter in
// place as fast as the event loop turns and holds <root>/held open, so a
// snapshot taken while it is frozen can be shown to be stable, and one taken
// after it continued to see it move.
//   node toy/tree-writer.mjs <root>
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const counter = path.join(root, 'counter');
fs.writeFileSync(path.join(root, 'held'), 'held open\n');
const held = fs.openSync(path.join(root, 'held'), 'r');
let count = 0;
const write = () => { fs.writeFileSync(counter, `${count += 1}\n`); setImmediate(write); };
fs.writeFileSync(counter, '0\n');
process.stdout.write(`${JSON.stringify({ ready: { pid: process.pid, held } })}\n`);
process.stdin.on('end', () => process.exit(0)).resume();
setImmediate(write);
