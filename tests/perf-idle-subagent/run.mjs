// Profiles the idle "Waiting for subagent output" chat view: frames drawn, main-thread
// time and renderer/GPU process CPU, with and without children streaming in the
// background. Production build of the shared UI in the development Electron Chromium.
//   node tests/perf-idle-subagent/run.mjs [--measure-ms 15000] [--label name]
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build, preview } from 'vite';
import { CdpConnection, discoverPageTarget, evaluate } from '../../scripts/qa/cdp.mjs';
import { reservePort, startOwnedProcess } from '../../scripts/qa/process.mjs';
import { createRunRoot, scratchParent } from '../../scripts/qa/run-root.mjs';

const { values: options } = parseArgs({ options: {
    'measure-ms': { type: 'string', default: '15000' },
    'warmup-ms': { type: 'string', default: '3000' },
    'trace-ms': { type: 'string', default: '5000' },
    label: { type: 'string', default: 'run' },
} });
const measureMs = Number(options['measure-ms']);
const warmupMs = Number(options['warmup-ms']);
const traceMs = Number(options['trace-ms']);
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtureRoot = path.join(root, 'tests/perf-idle-subagent');
const requireElectron = createRequire(new URL('../../packages/electron/package.json', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let server, host, cdp;
const run = createRunRoot({ parent: scratchParent('perf'), prefix: 'idle-subagent-', owner: 'idle-subagent-profile',
    onInterrupt: async () => { cdp?.close(); await host?.stop(); await server?.close(); } });
const output = run.dir;
const evidence = { label: options.label, outcome: 'failed', revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['status', '--porcelain', 'packages/ui/src'], { cwd: root, encoding: 'utf8' }).trim()),
    limitations: ['Synthetic sync store and fixture components; no runtime, provider or app shell',
        'Development Electron Chromium, not the packaged app'],
    measureMs, scenarios: {}, startedAt: new Date().toISOString() };

// Cumulative CPU seconds per process of the owned Electron tree, by Chromium process type.
const sampleProcessTree = (rootPid) => {
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time=,command='], { encoding: 'utf8' }).trim().split('\n').map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        if (!match) return null;
        const [, pid, ppid, time, command] = match;
        const parts = time.split(':').map(Number);
        const seconds = parts.reduce((total, part) => total * 60 + part, 0);
        return { pid: Number(pid), ppid: Number(ppid), seconds, command };
    }).filter(Boolean);
    const owned = new Set([rootPid]);
    for (let grew = true; grew;) {
        grew = false;
        for (const row of rows) if (!owned.has(row.pid) && owned.has(row.ppid)) { owned.add(row.pid); grew = true; }
    }
    const byType = {};
    for (const row of rows) {
        if (!owned.has(row.pid)) continue;
        const type = row.command.match(/--type=([\w-]+)/)?.[1] ?? 'browser';
        byType[type] = (byType[type] ?? 0) + row.seconds;
    }
    return byType;
};
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));

const measureWindow = async () => {
    const beforeCpu = sampleProcessTree(host.child.pid);
    const beforeMetrics = await metrics();
    const started = performance.now();
    await delay(measureMs);
    const wallSeconds = (performance.now() - started) / 1000;
    const afterCpu = sampleProcessTree(host.child.pid);
    const afterMetrics = await metrics();
    const cpuPercent = Object.fromEntries(Object.keys(afterCpu).map((type) => [type,
        Math.round(((afterCpu[type] - (beforeCpu[type] ?? 0)) / wallSeconds) * 1000) / 10]));
    const mainThread = Object.fromEntries(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].map((name) => [name,
        Math.round(((afterMetrics[name] - beforeMetrics[name]) / wallSeconds) * 1000) / 10]));
    return { wallSeconds, cpuPercent, mainThreadPercent: mainThread };
};

const traceFrames = async () => {
    const events = [];
    const unsubscribe = cdp.on('Tracing.dataCollected', ({ value }) => { for (const event of value) events.push(event); });
    await cdp.send('Tracing.start', { categories: 'disabled-by-default-devtools.timeline.frame,devtools.timeline', transferMode: 'ReportEvents' });
    await delay(traceMs);
    const complete = cdp.waitFor('Tracing.tracingComplete', 30_000);
    await cdp.send('Tracing.end');
    await complete;
    unsubscribe();
    const count = (name) => events.filter((event) => event.name === name && event.ph !== 'E').length;
    const seconds = traceMs / 1000;
    return {
        drawFramesPerSecond: Math.round((count('DrawFrame') / seconds) * 10) / 10,
        mainFramesPerSecond: Math.round((count('BeginMainThreadFrame') / seconds) * 10) / 10,
        paintsPerSecond: Math.round((count('Paint') / seconds) * 10) / 10,
    };
};

const runningAnimations = () => evaluate(cdp, `(() => {
    const counts = {};
    for (const animation of document.getAnimations()) {
        if (animation.playState !== 'running') continue;
        const name = animation.animationName ?? animation.transitionProperty ?? 'script';
        counts[name] = (counts[name] ?? 0) + 1;
    }
    return counts;
})()`);

try {
    const outDir = path.join(output, 'dist');
    await build({ configFile: path.join(fixtureRoot, 'vite.config.ts'), logLevel: 'warn', cacheDir: path.join(output, 'vite-cache'),
        build: { outDir, emptyOutDir: true, minify: true, sourcemap: false } });
    server = await preview({ configFile: path.join(fixtureRoot, 'vite.config.ts'), logLevel: 'warn',
        build: { outDir }, preview: { host: '127.0.0.1', port: await reservePort(), strictPort: true } });
    const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
    const debugPort = await reservePort();
    host = startOwnedProcess(requireElectron('electron'), [path.join(root, 'scripts/qa/browser-shell.cjs'),
        `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(output, 'profile')}`,
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    { cwd: root, env: { ...process.env, DEVRYAN_QA_ORIGIN: origin, ELECTRON_RUN_AS_NODE: '' } });
    cdp = await CdpConnection.connect((await discoverPageTarget(debugPort)).webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Performance.enable');
    await cdp.send('Page.bringToFront');
    for (let attempt = 0; !(await evaluate(cdp, 'Boolean(window.__idleFixture?.ready && document.querySelector("#status-row [role=status]"))')); attempt += 1) {
        host.check();
        if (attempt > 300) throw new Error('Fixture did not render');
        await delay(100);
    }
    for (const scenario of ['idle', 'children-streaming']) {
        if (scenario === 'children-streaming') await evaluate(cdp, 'window.__idleFixture.startStream()');
        await delay(warmupMs);
        const window = await measureWindow();
        const frames = await traceFrames();
        evidence.scenarios[scenario] = { ...window, ...frames, runningAnimations: await runningAnimations(),
            storeUpdates: await evaluate(cdp, 'window.__idleFixture.stats.storeUpdates') };
    }
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(output, 'idle-subagent.png'), Buffer.from(data, 'base64'));
    evidence.outcome = 'passed';
} catch (error) {
    evidence.error = String(error.stack ?? error.message);
} finally {
    cdp?.close();
    if (host) { try { await host.stop(); } catch (error) { evidence.cleanupError = String(error.message); } }
    try { await server?.close(); } catch (error) { evidence.cleanupError = String(error.message); }
    evidence.finishedAt = new Date().toISOString();
    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify({ outcome: evidence.outcome, label: evidence.label, scenarios: evidence.scenarios, error: evidence.error }, null, 2));
run.finish(evidence.outcome);
process.exitCode = evidence.outcome === 'passed' ? 0 : 1;
