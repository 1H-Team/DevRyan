import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { CdpConnection, discoverPageTarget, evaluate } from '../../scripts/qa/cdp.mjs';
import { reservePort, startOwnedProcess } from '../../scripts/qa/process.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const requireElectron = createRequire(new URL('../../packages/electron/package.json', import.meta.url));
const outputRoot = path.join(root, '.cache/qa');
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
const output = await mkdtemp(path.join(outputRoot, 'reasoning-'));
const profile = path.join(output, 'profile');
const sanitizer = createDiagnosticSanitizer({ homeDir: process.env.HOME,
    pathMappings: [{ path: root, placeholder: '<REPOSITORY>' }] });
const sanitize = (text) => sanitizer.sanitizeText(String(text));
const evidence = {
    schemaVersion: 1,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    runtime: 'web-components-in-electron-chromium',
    scenario: 'reasoning', startedAt: new Date().toISOString(), outcome: 'failed',
    sourceHashes: {}, checks: [], screenshots: [], consoleErrors: [], cleanupErrors: [],
    visualReview: 'pending', liveProvider: 'not-run',
};
for (const file of ['ReasoningGroup.tsx', 'ReasoningPart.tsx']) {
    evidence.sourceHashes[file] = createHash('sha256').update(await readFile(path.join(root, 'packages/ui/src/components/chat/message/parts', file))).digest('hex');
}
let server;
let host;
let cdp;
let interrupted = false;
const onInterrupt = () => { interrupted = true; };
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onInterrupt);
const waitFor = async (expression) => {
    const started = performance.now();
    while (performance.now() - started < 30_000) {
        if (interrupted) throw new Error('Reasoning verification interrupted');
        host.check();
        if (await evaluate(cdp, expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Renderer condition did not settle: ${expression}`);
};
const check = async (name, action) => {
    const started = performance.now();
    console.log(JSON.stringify({ check: name, state: 'started' }));
    await action();
    evidence.checks.push({ name, outcome: 'passed', elapsedMs: performance.now() - started });
};
const setStage = async (stage) => {
    await evaluate(cdp, `window.__reasoningFixture.setStage(${JSON.stringify(stage)})`);
    await waitFor(`document.querySelector('output')?.dataset.stage === ${JSON.stringify(stage)}`);
};
const assertPage = async (expression, message) => assert.equal(await evaluate(cdp, expression), true, message);
const key = async (value, code, virtualKey) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code, windowsVirtualKeyCode: virtualKey });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code, windowsVirtualKeyCode: virtualKey });
};
const screenshot = async (name) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const filename = `${name}.png`;
    await writeFile(path.join(output, filename), Buffer.from(data, 'base64'));
    evidence.screenshots.push(filename);
};

try {
    server = await createServer({ configFile: path.join(root, 'tests/visual-reasoning/vite.config.ts'), server: { port: await reservePort() } });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const debugPort = await reservePort();
    host = startOwnedProcess(requireElectron('electron'), [
        path.join(root, 'scripts/qa/browser-shell.cjs'), `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profile}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    ], { cwd: root, env: { ...process.env, DEVRYAN_QA_ORIGIN: origin, ELECTRON_RUN_AS_NODE: '' } });
    cdp = await CdpConnection.connect((await discoverPageTarget(debugPort)).webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
        if (evidence.consoleErrors.length < 100) evidence.consoleErrors.push(sanitize(exceptionDetails.exception?.description ?? exceptionDetails.text));
    });
    cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
        if (type === 'error' && evidence.consoleErrors.length < 100) evidence.consoleErrors.push(sanitize(args.map((arg) => arg.value ?? arg.description).join(' ')));
    });
    await cdp.send('Page.bringToFront');
    await waitFor('Boolean(window.__reasoningFixture)');
    for (const mode of ['live', 'sorted']) {
        await evaluate(cdp, `window.__reasoningFixture.setMode(${JSON.stringify(mode)})`);
        await check(`${mode}: empty activity, keyboard promotion, and focus`, async () => {
            for (const stage of ['empty', 'whitespace']) {
                await setStage(stage);
                await assertPage("Boolean(document.querySelector('#reasoning-target [role=status]')) && !document.querySelector('#reasoning-target button')", 'Empty reasoning must be an accessible non-expandable status');
                await assertPage("document.querySelector('output').dataset.ownedStatus === 'true'", 'Mounted activity owns thinking status');
            }
            await screenshot(`${mode}-pending`);
            await evaluate(cdp, "document.querySelector('textarea').focus()");
            await setStage('first');
            await assertPage("document.activeElement === document.querySelector('textarea')", 'New content must not steal composer focus');
            await assertPage("document.querySelector('#reasoning-target button')?.getAttribute('aria-expanded') === 'false' && !document.querySelector('[data-reasoning-block-id]')", 'First content starts collapsed without mounted Markdown');
            await evaluate(cdp, "document.querySelector('#reasoning-target button').focus()");
            await key('Enter', 'Enter', 13);
            await waitFor("document.querySelector('[data-reasoning-block-id]')?.textContent.includes('First observation')");
            await assertPage("document.querySelector('#reasoning-target button').getAttribute('aria-expanded') === 'true'", 'Enter opens exactly once');
        });
        await check(`${mode}: appended parts, ended gap, completion, and cancellation`, async () => {
            await setStage('second');
            await waitFor("document.querySelectorAll('[data-reasoning-block-id]').length === 2");
            for (const stage of ['gap', 'complete', 'cancel']) {
                await setStage(stage);
                await assertPage("document.activeElement === document.querySelector('#reasoning-target button') && document.activeElement.getAttribute('aria-expanded') === 'true'", 'Appending or terminalizing content retains expansion and focus');
                await assertPage("Array.from(document.querySelectorAll('[data-reasoning-block-id]')).map(n => n.getAttribute('data-reasoning-block-id')).join(',') === 'reasoning-one,reasoning-two'", 'Visible reasoning retains source order');
            }
            await assertPage("document.querySelector('output').dataset.ownedStatus === 'false'", 'Cancellation releases active status ownership');
            await screenshot(`${mode}-expanded-cancelled`);
            await key(' ', 'Space', 32);
            await waitFor("document.querySelector('#reasoning-target button').getAttribute('aria-expanded') === 'false'");
            await assertPage("!document.querySelector('[data-reasoning-block-id]')", 'Space closes and unmounts Markdown');
            await setStage('empty-cancel');
            await assertPage("document.querySelector('#reasoning-target').children.length === 0", 'Empty cancelled reasoning leaves no status or control');
        });
    }
    await check('completed canonical reasoning survives reload and opens by pointer', async () => {
        await setStage('complete');
        const loaded = cdp.waitFor('Page.loadEventFired');
        await cdp.send('Page.reload');
        await loaded;
        await waitFor("Boolean(window.__reasoningFixture) && document.querySelector('output')?.dataset.stage === 'complete'");
        await assertPage("document.querySelector('#reasoning-target button').getAttribute('aria-expanded') === 'false' && document.querySelector('output').dataset.ownedStatus === 'false'", 'Reload starts completed reasoning collapsed with no active ownership');
        await evaluate(cdp, 'document.fonts.ready');
        await new Promise((resolve) => setTimeout(resolve, 250));
        const point = await evaluate(cdp, "(() => { const r = document.querySelector('#reasoning-target button').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()");
        await evaluate(cdp, "window.__fixturePointerEvents = []; for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, event => window.__fixturePointerEvents.push({ type, tag:event.target.tagName, text:event.target.textContent.slice(0, 100), x:event.clientX, y:event.clientY }), { capture:true });");
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
        evidence.pointerInput = { point, events: await evaluate(cdp, 'window.__fixturePointerEvents') };
        await waitFor("document.querySelectorAll('[data-reasoning-block-id]').length === 2");
        await assertPage("document.querySelector('#reasoning-target').textContent.includes('Verify the ordered update')", 'Reloaded reasoning retains final body');
    });
    for (const [width, height] of [[390, 844], [844, 390], [768, 1024]]) {
        for (const theme of ['light', 'dark']) {
            await check(`${width}x${height} ${theme}: responsive reasoning`, async () => {
                await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
                await evaluate(cdp, `window.__reasoningFixture.setTheme(${JSON.stringify(theme)})`);
                await assertPage('document.documentElement.scrollWidth <= innerWidth', 'Reasoning must not create horizontal viewport overflow');
                await screenshot(`${width}x${height}-${theme}`);
            });
        }
    }
    assert.deepEqual(evidence.consoleErrors, [], 'Component fixture must have no console errors');
    evidence.outcome = 'passed';
} catch (error) {
    evidence.error = sanitize(error.stack ?? error.message);
    if (cdp) {
        try {
            evidence.failureState = await evaluate(cdp, "({ stage: document.querySelector('output')?.outerHTML, reasoning: document.querySelector('#reasoning-target')?.outerHTML.slice(0, 8000) })");
            await screenshot('failure');
        } catch { /* The failed renderer may no longer be available. */ }
    }
} finally {
    cdp?.close();
    if (host) {
        try { await host.stop(); } catch (error) { evidence.cleanupErrors.push(sanitize(error.message)); }
        await writeFile(path.join(output, 'host.log'), sanitize(host.getLog()));
    }
    try { await server?.close(); } catch (error) { evidence.cleanupErrors.push(sanitize(error.message)); }
    try { await rm(profile, { force: true, recursive: true }); } catch (error) { evidence.cleanupErrors.push(sanitize(error.message)); }
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
    if (evidence.cleanupErrors.length) evidence.outcome = 'failed';
    evidence.finishedAt = new Date().toISOString();
    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify({ outcome: evidence.outcome, evidence: path.join(output, 'result.json'), error: evidence.error }));
process.exitCode = evidence.outcome === 'passed' ? 0 : 1;
