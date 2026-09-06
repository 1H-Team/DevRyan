import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { captureFixtureManifest } from '../agent-evals/fixture.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ownedFixtures = new WeakMap();
export const QA_PROJECT_SEED_VERSION = 1;
export const QA_PROJECT_PROTECTED_PATHS = Object.freeze([
  'docs/user-notes.md', 'requirements/brief.txt', 'requirements/priority-reference.png',
]);
export const QA_PROJECT_PLAN_PREFIXES = Object.freeze(['.opencode/plans/']);
const verificationScope = 'Use native bash for the full test suite, HTTP API checks, and verification of persistence after stopping and restarting the server. The independent QA browser will inspect the resulting UI after implementation; report that browser check as pending. Do not discover or install browser tooling, inspect application directories, or request access outside this repository for browser verification.';

const seedFiles = () => ({
  'package.json': JSON.stringify({ name: 'devryan-qa-task-board', private: true, type: 'module',
    scripts: { test: 'node --test test/*.test.mjs', start: 'node src/server.mjs' } }, null, 2) + '\n',
  '.gitignore': 'data/\n',
  'README.md': '# Task Board\n\nDependency-free Node task tracker. Run `npm test`, then `npm start`. The server prints its loopback URL. Use `PORT=0` to request an available port. Data lives in `data/tasks.json`.\n\nOwnership: `src/tasks.mjs` owns task rules; `src/store.mjs` owns JSON persistence; `src/server.mjs` owns HTTP; `public/` owns the accessible browser UI. Existing tests include known failures. Preserve the current uncommitted user notes.\n',
  'AGENTS.md': '# Fixture instructions\n\nWork only in this repository. Do not install dependencies, publish, or commit changes. Preserve the pre-existing uncommitted edit in `docs/user-notes.md`. Read `requirements/brief.txt` and the attached visual reference. Follow this causal sequence in separate completed tool calls: first successfully read `src/tasks.mjs` with native read; only after that read completes, use native bash to run standalone `node --test test/tasks.test.mjs` in this repository and inspect its failing result; only then change implementation when authorized; after the final implementation change, run that exact standalone command again with native bash and verify it passes. Do not run the initial failing test before or concurrently with the source read. These two native tool results must preserve the real numeric process exit status for the causal repair check; do not wrap them in ctx_execute, another script, or a command chain. Also run `npm test` to exercise the complete suite, including your added tests. When Plan mode disables native execution, complete the source read during planning and run the initial failing command immediately after approval and before any implementation edit. Public exports and HTTP route shapes in README/source are compatibility contracts. Keep `test/tasks.test.mjs` unchanged; add behavioral tests for your fix in separate test files. Plans belong under `.opencode/plans/`; plan mode must not edit implementation, tests, or dependencies. A later user revision supersedes the initial priority display order.\n\n' + verificationScope + '\n',
  'docs/user-notes.md': '# User notes\n\nThe board must remain usable without installing a framework.\n',
  'requirements/brief.txt': 'Task Board QA brief, revision 1\nFix summary totals so archived tasks never count toward active totals or completion percentage. Fix stale/equal revision events overwriting newer task state. Add persisted priority low/normal/high, with normal as the backwards-compatible default. Reject invalid priorities with HTTP 400. Add a labeled priority selector when creating a task and show priority on each task row using both text and color. Initially show high, normal, then low. Follow the attached visual reference for the words and colors. Keep keyboard focus visible. Preserve the existing uncommitted user note. Do not add dependencies or delete tests. Do not use localStorage as the source of truth.\n',
  'src/tasks.mjs': `export const createTask = (input, id) => {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('Title is required');
  return { id, title: input.title.trim(), done: false, archived: false, revision: 1 };
};

export const summarizeTasks = (tasks) => {
  const active = tasks.filter((task) => !task.archived);
  const completed = tasks.filter((task) => task.done).length;
  return { total: active.length, completed, percent: active.length ? Math.round(completed / active.length * 100) : 0 };
};

export const applyTaskEvent = (tasks, event) => {
  if (!Number.isSafeInteger(event.revision) || event.revision < 1) throw new Error('Invalid revision');
  return tasks.map((task) => task.id === event.id ? { ...task, ...event.patch, id: task.id, revision: event.revision } : task);
};
`,
  'src/store.mjs': `import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyTaskEvent, createTask } from './tasks.mjs';

export const createTaskStore = async (filePath) => {
  let tasks;
  try { tasks = JSON.parse(await readFile(filePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; tasks = []; }
  if (!Array.isArray(tasks)) throw new Error('Stored tasks must be an array');
  let pending = Promise.resolve();
  const change = (operation) => {
    const next = pending.then(async () => {
      const updated = operation(tasks);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath + '.tmp', JSON.stringify(updated));
      await rename(filePath + '.tmp', filePath);
      tasks = updated;
      return structuredClone(tasks);
    });
    pending = next.catch(() => {});
    return next;
  };
  return {
    list: () => structuredClone(tasks),
    add: async (input) => {
      const task = createTask(input, randomUUID());
      await change((current) => [...current, task]);
      return structuredClone(task);
    },
    apply: (event) => change((current) => applyTaskEvent(current, event)),
  };
};
`,
  'src/server.mjs': `import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTaskStore } from './store.mjs';
import { summarizeTasks } from './tasks.mjs';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const readJson = async (request) => {
  let text = '';
  for await (const chunk of request) { text += chunk; if (text.length > 65536) throw new Error('Body too large'); }
  return JSON.parse(text);
};
export const startTaskServer = async ({ port = 0, dataFile = path.resolve('data/tasks.json') } = {}) => {
  const store = await createTaskStore(dataFile);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const json = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    try {
      if (request.method === 'GET' && url.pathname === '/api/tasks') return json(200, store.list());
      if (request.method === 'GET' && url.pathname === '/api/summary') return json(200, summarizeTasks(store.list()));
      if (request.method === 'POST' && url.pathname === '/api/tasks') return json(201, await store.add(await readJson(request)));
      if (request.method === 'POST' && url.pathname === '/api/events') return json(200, await store.apply(await readJson(request)));
      if (request.method === 'PATCH' && url.pathname.startsWith('/api/tasks/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/tasks/'.length));
        const current = store.list().find((task) => task.id === id);
        if (!current) return json(404, { error: 'Task not found' });
        const patch = await readJson(request);
        const tasks = await store.apply({ id, revision: current.revision + 1, patch });
        return json(200, tasks.find((task) => task.id === id));
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      const asset = assets[url.pathname];
      if (request.method === 'GET' && asset) { response.writeHead(200, { 'content-type': asset[1] }); return response.end(await readFile(path.join(publicRoot, asset[0]))); }
      return json(404, { error: 'Not found' });
    } catch (error) { return json(400, { error: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, origin: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
};
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = await startTaskServer({ port: Number(process.env.PORT ?? 0) });
  process.stdout.write(app.origin + '\\n');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
}
`,
  'public/index.html': '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Task Board</title><link rel="stylesheet" href="/style.css"></head><body><main><h1>Task Board</h1><form id="new-task"><label for="title">Task title</label><input id="title" name="title" required><button>Add task</button></form><p id="summary" aria-live="polite"></p><p id="error" role="alert"></p><ul id="tasks" aria-label="Tasks"></ul></main><script type="module" src="/app.js"></script></body></html>\n',
  'public/style.css': 'body{font:16px system-ui;color:#172033;background:#f5f7fa;margin:0}main{max-width:48rem;margin:3rem auto;padding:1rem}form{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem}input,button,select{font:inherit;padding:.65rem}input{flex:1;min-width:8rem}button{cursor:pointer}ul{padding:0;list-style:none}li{background:white;border:1px solid #cdd5df;border-radius:.5rem;padding:1rem;margin:.75rem 0;display:flex;align-items:center;gap:1rem}li span{flex:1}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #2563eb;outline-offset:3px}#error{color:#b91c1c}\n',
  'public/app.js': `const form = document.querySelector('#new-task');
const title = document.querySelector('#title');
const request = async (url, options) => {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body;
};
const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const render = async () => {
  const [tasks, summary] = await Promise.all([request('/api/tasks'), request('/api/summary')]);
  const rows = tasks.filter((task) => !task.archived).map((task) => {
    const row = document.createElement('li');
    row.dataset.taskId = task.id;
    const text = document.createElement('span');
    text.textContent = task.title;
    const button = document.createElement('button');
    button.textContent = task.done ? 'Reopen' : 'Complete';
    button.addEventListener('click', async () => { await request('/api/tasks/' + task.id, json('PATCH', { done: !task.done })); await render(); });
    row.append(text, button);
    return row;
  });
  document.querySelector('#tasks').replaceChildren(...rows);
  document.querySelector('#summary').textContent = summary.completed + ' of ' + summary.total + ' complete (' + summary.percent + '%)';
};
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await request('/api/tasks', json('POST', { title: title.value })); title.value = ''; await render(); }
  catch (error) { document.querySelector('#error').textContent = error.message; }
});
await render();
`,
  'test/tasks.test.mjs': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTaskEvent, createTask, summarizeTasks } from '../src/tasks.mjs';
test('new tasks retain their title and have a positive revision', () => {
  const task = createTask({ title: ' Read the requirements ' }, 'a');
  assert.equal(task.title, 'Read the requirements');
  assert.equal(task.revision, 1);
  assert.throws(() => createTask({ title: ' ' }, 'b'));
});
test('archived completed tasks do not affect active completion', () => {
  assert.deepEqual(summarizeTasks([{ done: true, archived: false }, { done: false, archived: false }, { done: true, archived: true }]), { total: 2, completed: 1, percent: 50 });
});
test('older and repeated events preserve newer state', () => {
  const current = [{ id: 'a', title: 'Current', revision: 4, done: false, archived: false }];
  for (const revision of [2, 4]) assert.deepEqual(applyTaskEvent(current, { id: 'a', revision, patch: { title: 'Stale' } }), current);
});
`,
});

// A small deterministic visual attachment: legible text and swatches, no external font or image dependency.
const makePriorityReference = () => {
  const glyphs = {
    H: ['101','101','111','101','101'], I: ['111','010','010','010','111'], G: ['111','100','101','101','111'],
    N: ['1001','1101','1011','1001','1001'], O: ['111','101','101','101','111'], R: ['110','101','110','101','101'],
    M: ['10001','11011','10101','10001','10001'], A: ['010','101','111','101','101'], L: ['100','100','100','100','111'],
    W: ['10001','10001','10101','10101','01010'],
  };
  const width = 360; const height = 180;
  const pixels = Buffer.alloc(width * height * 3, 250);
  const pixel = (x, y, rgb) => { if (x >= 0 && x < width && y >= 0 && y < height) pixels.set(rgb, (y * width + x) * 3); };
  const colors = [[185, 28, 28], [161, 98, 7], [37, 99, 235]];
  for (const [index, word] of ['HIGH', 'NORMAL', 'LOW'].entries()) {
    const top = 15 + index * 55;
    for (let y = top; y < top + 35; y++) for (let x = 15; x < 50; x++) pixel(x, y, colors[index]);
    let offset = 70;
    for (const letter of word) {
      const glyph = glyphs[letter];
      for (let y = 0; y < 5; y++) for (let x = 0; x < glyph[y].length; x++) if (glyph[y][x] === '1') {
        for (let dy = 0; dy < 5; dy++) for (let dx = 0; dx < 5; dx++) pixel(offset + x * 5 + dx, top + y * 5 + dy, [23, 32, 51]);
      }
      offset += (glyph[0].length + 1) * 5;
    }
  }
  const crc = (buffer) => {
    let value = 0xffffffff;
    for (const byte of buffer) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const bytes = Buffer.concat([Buffer.from(type), data]);
    const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(bytes));
    return Buffer.concat([header, bytes, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const scanlines = Buffer.alloc(height * (width * 3 + 1));
  for (let row = 0; row < height; row++) pixels.copy(scanlines, row * (width * 3 + 1) + 1, row * width * 3, (row + 1) * width * 3);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
};

export const createQaProjectPrompts = ({ agent = 'builder', planMode = false } = {}) => {
  if (!['builder', 'orchestrator'].includes(agent) || typeof planMode !== 'boolean') throw new Error('Invalid project prompt selection');
  const workflow = agent === 'orchestrator'
    ? 'Delegate independent investigation of domain/persistence and browser behavior to specialists, then integrate their results. Observe managed task identities and handle each result once. Do not delegate writable work while planning.'
    : 'Diagnose and implement the task directly. Read the relevant code, run the failing tests, repair the defects, and verify the complete application.';
  const phase = planMode
    ? 'Plan mode is on. Inspect and save a concrete plan under .opencode/plans/. Run read-only tests only if the runtime permits them; otherwise record that the initial failing native test must run after approval and before edits. Do not edit implementation or tests before approval.'
    : 'Implementation is authorized. Pause after diagnosis and the initial failing tests to report the proposed changes; the next message will contain a requirement revision.';
  const nativeVerification = 'Capture this exact causal repair sequence in separate completed tool calls: successfully read `src/tasks.mjs` with native read first; after that read completes, run standalone `node --test test/tasks.test.mjs` with native bash and observe the initial failure; only then edit implementation when authorized; after the final edit, run that standalone native bash command again and verify it passes. Do not run the initial test before or concurrently with the source read. Preserve the real numeric exit status of each test call. Do not wrap those commands in ctx_execute or command chains. Already completed diagnosis need not be repeated after approval. Also run `npm test` for the full suite. ' + verificationScope;
  return Object.freeze({
    initial: `Work on Task Board in this repository. Read requirements/brief.txt and the attached priority-reference.png. Fix the two existing defects and implement persisted task priorities across the domain, JSON storage, HTTP API and UI. Preserve docs/user-notes.md exactly, including its uncommitted edit. Keep test/tasks.test.mjs unchanged and add regression tests in new files. No dependencies, commits, test deletion, or localStorage persistence. ${workflow} ${phase} ${nativeVerification}`,
    revision: 'Requirement revision 2: preserve creation order in the default task list; reject the previously proposed automatic priority sorting. Add an accessible Priority filter with All, High, Normal, and Low choices. Filter the visible list only; summary totals still cover all active tasks. Preserve priority through edits and server restarts, default legacy tasks to normal, and reject invalid priorities with HTTP 400. Keep High red, Normal amber, and Low blue with visible text. Update the current saved plan if planning. All earlier constraints still apply.',
    approve: 'The current revision 2 plan is approved. Implement it now, preserve the existing user edit, retain and extend meaningful tests, run the full test suite, perform HTTP API checks and verify restart persistence. Integrate every managed result exactly once. Report actual verification and any unfinished work. ' + nativeVerification,
    continue: 'Continue the current revision 2 task from authoritative repository, plan, todo, and managed-task records. Preserve all earlier constraints and user edits. Complete unfinished obligations, avoid repeating completed work or delegation, and verify the final application. Do not claim completion from a recap alone. ' + nativeVerification,
  });
};

export const createQaProjectFixture = ({ outputRoot = path.join(REPO_ROOT, '.cache/qa/projects'), runId = 'project', agent = 'builder', planMode = false } = {}) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(runId)) throw new Error('Invalid QA project runId');
  const prompts = createQaProjectPrompts({ agent, planMode });
  const root = path.resolve(outputRoot);
  const cache = path.join(realpathSync(REPO_ROOT), '.cache');
  const insideCache = (candidate) => { const relative = path.relative(cache, candidate); return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  if (!insideCache(root)) throw new Error('QA project output must be inside repository .cache');
  // Inspect the existing ancestor before mkdir so a symlink cannot create directories outside the cache.
  let ancestor = root;
  for (;;) { try { lstatSync(ancestor); break; } catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor); } }
  const target = path.resolve(realpathSync(ancestor), path.relative(ancestor, root));
  if (!insideCache(target)) throw new Error('QA project output may not escape repository .cache');
  mkdirSync(root, { recursive: true });
  if (!insideCache(realpathSync(root))) throw new Error('QA project output may not escape repository .cache');
  const evidenceDirectory = mkdtempSync(path.join(root, `${runId}-`));
  const fixtureRoot = path.join(evidenceDirectory, 'project');
  mkdirSync(fixtureRoot, { mode: 0o700 });
  try {
    const files = seedFiles();
    files['requirements/priority-reference.png'] = makePriorityReference();
    for (const [relative, content] of Object.entries(files)) { const target = path.join(fixtureRoot, relative); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content); }
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: fixtureRoot, encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, GIT_AUTHOR_DATE: '2026-09-05T00:00:00Z', GIT_COMMITTER_DATE: '2026-09-05T00:00:00Z' } });
      if (result.error || result.status !== 0) throw new Error(`QA fixture git ${args[0]} failed`);
      return result.stdout.trim();
    };
    git(['init', '-q', '--initial-branch=qa-task-board']);
    git(['add', '.']);
    git(['-c', 'user.name=DevRyan QA', '-c', 'user.email=qa@devryan.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Seed task board acceptance fixture']);
    writeFileSync(path.join(fixtureRoot, 'docs/user-notes.md'), files['docs/user-notes.md'] + '\nUser edit: keep the default task list in creation order; do not replace this note.\n');
    const manifest = captureFixtureManifest(fixtureRoot);
    const seed = { schemaVersion: 1, seedVersion: QA_PROJECT_SEED_VERSION, revision: git(['rev-parse', 'HEAD']), branch: 'qa-task-board', manifest,
      protectedPaths: [...QA_PROJECT_PROTECTED_PATHS], planPrefixes: [...QA_PROJECT_PLAN_PREFIXES] };
    const seedJson = JSON.stringify(seed, null, 2) + '\n';
    const seedManifestPath = path.join(evidenceDirectory, 'seed-manifest.json');
    writeFileSync(seedManifestPath, seedJson, { mode: 0o600 });
    const fixture = Object.freeze({ fixtureRoot, evidenceDirectory, seedManifestPath, seedManifestSha256: createHash('sha256').update(seedJson).digest('hex'), seed,
      attachments: Object.freeze([{ path: path.join(fixtureRoot, 'requirements/brief.txt'), mime: 'text/plain' }, { path: path.join(fixtureRoot, 'requirements/priority-reference.png'), mime: 'image/png' }]), prompts });
    const stats = lstatSync(fixtureRoot);
    ownedFixtures.set(fixture, { dev: stats.dev, ino: stats.ino });
    return fixture;
  } catch (error) { rmSync(evidenceDirectory, { recursive: true, force: true }); throw error; }
};

export const assertQaProjectFixtureOwned = (fixture) => {
  const identity = ownedFixtures.get(fixture);
  if (!identity) throw new Error('Unknown QA project fixture ownership');
  const stats = lstatSync(fixture.fixtureRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.dev !== identity.dev || stats.ino !== identity.ino
    || realpathSync(fixture.fixtureRoot) !== fixture.fixtureRoot) throw new Error('QA project fixture identity changed');
  if (createHash('sha256').update(readFileSync(fixture.seedManifestPath)).digest('hex') !== fixture.seedManifestSha256) throw new Error('QA project seed manifest changed');
};

export const removeQaProjectFixture = (fixture) => {
  assertQaProjectFixtureOwned(fixture);
  // Keep the external seed/evidence and remove only the newly allocated worktree.
  rmSync(fixture.fixtureRoot, { recursive: true, force: false });
  ownedFixtures.delete(fixture);
};
