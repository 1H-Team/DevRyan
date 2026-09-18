#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (name, fallback) => args[args.indexOf(name) + 1] && args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const seconds = Number(value('--seconds', '5700'));
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86_400) throw new Error('--seconds must be between 1 and 86400');
const output = path.resolve(value('--output', path.join(root, '.cache/crash-memory')));
if (!output.startsWith(`${root}${path.sep}`)) throw new Error('Fixture output must be inside the repository');
const source = path.resolve(value('--source', root));
if (source !== root && !source.startsWith(`${root}${path.sep}`)) throw new Error('Fixture source must be inside the repository');
const observeRefreshLoop = args.includes('--observe-refresh-loop');
const workload = value('--workload', 'history');
if (!['history', 'snapshots'].includes(workload)) throw new Error('Unknown fixture workload');
if (!process.versions.electron) {
  await fs.mkdir(output, { recursive: true });
  const require = createRequire(path.join(root, 'packages/electron/package.json'));
  const electron = require('electron');
  await Promise.all(['app_bound', 'service'].map(async (mode) => {
    const base = path.join(output, mode); await fs.mkdir(base, { recursive: true });
    const env = { PATH: process.env.PATH, HOME: base, TMPDIR: base, XDG_CONFIG_HOME: base,
      OPENCHAMBER_DATA_DIR: base, OPENCHAMBER_ELECTRON_DEV: '1', OPENCHAMBER_ELECTRON_USER_DATA_DIR: path.join(base, 'profile') };
    const child = spawn(electron, ['--js-flags=--expose-gc', fileURLToPath(import.meta.url), '--seconds', String(seconds), '--output', base, '--mode', mode,
      '--source', source, '--workload', workload, ...(observeRefreshLoop ? ['--observe-refresh-loop'] : [])], { cwd: root, env, stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (code !== 0) throw new Error(`${mode} memory fixture failed: ${code}`);
  }));
} else {
 void (async () => {
  const { app } = await import('electron');
  app.setPath('userData', path.join(output, 'profile'));
  await app.whenReady();
  if (typeof globalThis.gc !== 'function') throw new Error('Fixture requires exposed GC');
  const { createSessionChangeHost } = await import(pathToFileURL(path.join(source, 'packages/harness-runtime/lib/session-changes-host.js')).href);
  const { createRuntimeServiceCoordinator } = await import('../packages/electron/runtime-service.mjs');
  const v8 = await import('node:v8');
  const { Session } = await import('node:inspector');
  const inspector = new Session(); inspector.connect();
  const post = (method, params = {}) => new Promise((resolve, reject) => inspector.post(method, params, (e, r) => e ? reject(e) : resolve(r)));
  await post('HeapProfiler.startSampling', { samplingInterval: 32768 });
  const work = await fs.mkdtemp(path.join(output, 'fixture-'));
  const directory = path.join(work, 'repo'); await fs.mkdir(directory); execFileSync('git', ['init', '-q'], { cwd: directory });
  // Test-only sealing, never the workstation keychain or launchd registration.
  const coordinator = await createRuntimeServiceCoordinator({ dataDirectory: work, safeStorage: {
    isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString(),
  } });
  await coordinator.acquire({ mode: value('--mode', 'app_bound') });
  const ids = ['ses_root', 'ses_child1', 'ses_child2', 'ses_child3', 'ses_child4'];
  const bodies = new Map((workload === 'history' ? ids : []).map(id => [id, JSON.stringify([
    { info: { id: `msg_user${id}`, sessionID: id, role: 'user', time: { created: 1 } }, parts: [] },
    ...Array.from({ length: 80 }, (_, i) => ({ info: { id: `msg_${id}${i}`, sessionID: id, role: 'assistant', time: { created: i + 2 } }, parts: [{ type: 'text', text: 'synthetic fixture '.repeat(1024) }] })),
    { info: { id: `msg_edit${id}`, sessionID: id, role: 'assistant', time: { created: 100 } }, parts: [{ type: 'tool', tool: 'edit', callID: `call_${id}`, state: { status: 'completed', metadata: { filediff: { file: '../invalid.txt', before: null, after: 'synthetic\n' } } } }] },
  ])]));
  let events = 0, requests = 0, bytes = 0;
  const host = createSessionChangeHost({ dataDirectory: work, buildOpenCodeUrl: p => `http://fixture${p}`,
    publishEvent: () => { events++; }, fetchImpl: async raw => {
      requests++; const u = new URL(raw); const id = u.pathname.split('/')[2];
      if (u.pathname.endsWith('/message')) { const body = bodies.get(id); bytes += Buffer.byteLength(body); return new Response(body); }
      if (u.pathname.endsWith('/children')) return Response.json(id === ids[0] ? ids.slice(1).map(id => ({ id, parentID: ids[0] })) : []);
      return Response.json({ id, directory, ...(id !== ids[0] ? { parentID: ids[0] } : {}) });
    } });
  let scheduler;
  if (workload === 'snapshots') {
    const { createManagedTaskScheduler } = await import('../packages/orchestration-runtime/scheduler.js');
    scheduler = createManagedTaskScheduler({ executor: { start: async (_task, control) => {
      await control.markAccepted(); return { status: 'completed', recoverablePreview: 'synthetic snapshot '.repeat(3000) };
    } } });
    for (let index = 0; index < 60; index++) {
      const task = await scheduler.submit({ idempotencyKey: `fixture-${index}`, rootSessionId: 'ses_root', directory,
        mode: 'orchestrator', dispatchGroupId: 'msg_fixture', providerId: 'fixture', modelId: 'fixture', agent: 'oracle',
        label: `Synthetic ${index}`, prompt: `Synthetic ${index} ${'x'.repeat(128 * 1024)}` });
      await scheduler.waitForTask(task.taskId);
    }
  }
  const samples = []; const started = Date.now(); let baselineEvents, transientHeapPeak = 0;
  try {
    do {
      if (scheduler) {
        const snapshots = Array.from({ length: 8 }, () => scheduler.getSnapshot());
        for (const snapshot of snapshots) { bytes += Buffer.byteLength(JSON.stringify(snapshot)); requests++; }
        transientHeapPeak = Math.max(transientHeapPeak, process.memoryUsage().heapUsed);
        snapshots.length = 0;
      } else {
        const results = await Promise.all(Array.from({ length: 8 }, () => host.handleRequest('GET', `/api/openchamber/session/ses_root/changes?directory=${encodeURIComponent(directory)}`)));
        if (results.some(r => r.status !== 200)) throw new Error('Fixture summary failed');
        transientHeapPeak = Math.max(transientHeapPeak, process.memoryUsage().heapUsed);
      }
      if (baselineEvents === undefined) baselineEvents = events;
      else if (events !== baselineEvents && !observeRefreshLoop) throw new Error('Unchanged summary generated a refresh loop');
      globalThis.gc();
      const m = process.memoryUsage();
      samples.push({ elapsedMs: Date.now() - started, heapUsed: m.heapUsed, rss: m.rss, external: m.external,
        heapLimit: v8.getHeapStatistics().heap_size_limit, events, requests, bytes, transientHeapPeak,
        ledgerBytes: scheduler?.getDiagnostics().serializedBytes ?? null, reads: host.getReadDiagnostics?.() ?? null });
      await fs.writeFile(path.join(output, 'progress.json'), JSON.stringify(samples.at(-1)));
      if (Date.now() - started >= seconds * 1000) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(10_000, seconds * 1000 - (Date.now() - started))));
    } while (true);
    const middle = samples.slice(2, Math.max(3, Math.floor(samples.length / 3)));
    const recent = samples.slice(-Math.max(1, Math.floor(samples.length / 3)));
    const mean = rows => rows.reduce((n,r) => n+r.heapUsed,0)/rows.length;
    const retainedGrowth = middle.length ? mean(recent)-mean(middle) : 0;
    const passed = retainedGrowth < 16*1024*1024;
    const { profile } = await post('HeapProfiler.stopSampling');
    await fs.writeFile(path.join(output, 'allocations.heapprofile'), JSON.stringify(profile));
    await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({ passed, mode: value('--mode','app_bound'), electron: process.versions.electron,
      seconds, retainedGrowth, retentionAssessed: samples.length >= 6, syntheticOnly: true, source, workload, quiescent: events === baselineEvents, samples }, null, 2));
    console.log(JSON.stringify({ mode: value('--mode','app_bound'), passed, samples: samples.length, retainedGrowth, events, requests }));
    if (!passed) throw new Error('Retained heap growth exceeded 16 MiB');
  } finally {
    inspector.disconnect(); await scheduler?.shutdown(); await host.drain(); await coordinator.release(); await fs.rm(work, { recursive: true, force: true });
    app.quit();
  }
 })().catch(async (error) => { console.error(error); (await import('electron')).app.exit(1); });
}
