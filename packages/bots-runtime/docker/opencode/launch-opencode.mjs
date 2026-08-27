import fs from 'node:fs';
import { spawn } from 'node:child_process';

const SECRET_FILE = '/runtime-secrets/environment.json';
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_SECRET_COUNT = 128;
const MAX_SECRET_BYTES = 16 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const RESERVED_EXACT = new Set([
  'HOME', 'PATH', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'OLDPWD',
  'NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
]);

const fail = (message) => {
  process.stderr.write(`Bot environment initialization failed: ${message}\n`);
  process.exit(78);
};

const isReserved = (name) => {
  const upper = name.toUpperCase();
  return upper.startsWith('DEVRYAN_') || upper.startsWith('OPENCODE_')
    || upper.startsWith('XDG_') || RESERVED_EXACT.has(upper)
    || upper.endsWith('_PROXY');
};

let document;
try {
  document = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
} catch {
  fail('secret snapshot is unavailable');
}

if (!document || typeof document !== 'object' || Array.isArray(document)
  || Object.keys(document).sort().join('\0') !== 'variables\0version'
  || document.version !== 1 || !document.variables
  || typeof document.variables !== 'object' || Array.isArray(document.variables)) {
  fail('secret snapshot is invalid');
}

const entries = Object.entries(document.variables);
const expectedCount = Number(process.env.DEVRYAN_BOT_ENVIRONMENT_SECRET_COUNT);
if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || expectedCount > MAX_SECRET_COUNT
  || entries.length !== expectedCount) {
  fail('secret snapshot is incomplete');
}

let totalBytes = 0;
for (const [name, value] of entries) {
  const bytes = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : -1;
  if (!NAME_PATTERN.test(name) || isReserved(name) || bytes < 1 || bytes > MAX_SECRET_BYTES
    || value.includes('\0')) {
    fail('secret snapshot contains an invalid entry');
  }
  totalBytes += bytes;
  if (totalBytes > MAX_TOTAL_BYTES) fail('secret snapshot is too large');
}

for (const [name, value] of entries) process.env[name] = value;

const child = spawn('/opt/devryan/node_modules/.bin/opencode', process.argv.slice(2), {
  env: process.env,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', () => fail('OpenCode could not start'));
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
