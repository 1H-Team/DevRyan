import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { CdpConnection, discoverPageTarget, evaluate } from '../../scripts/qa/cdp.mjs';
import { reservePort, startOwnedProcess } from '../../scripts/qa/process.mjs';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const requireElectron = createRequire(new URL('../../packages/electron/package.json', import.meta.url));
await mkdir(path.join(root, '.cache/qa'), { recursive: true });
const output = await mkdtemp(path.join(root, '.cache/qa/chat-improvements-'));
const profile = path.join(output, 'profile');
const downloads = path.join(output, 'downloads');
await mkdir(downloads);
const sanitizer = createDiagnosticSanitizer({ homeDir: process.env.HOME, pathMappings: [{ path: root, placeholder: '<REPOSITORY>' }] });
const sanitize = (value) => sanitizer.sanitizeText(String(value));
const evidence = { runtime: 'production-web-components-in-electron-chromium', outcome: 'failed',
    checks: [], consoleErrors: [], cleanupErrors: [], sourceHashes: {}, screenshots: [],
    limitations: ['Synthetic sync context; no installed app or provider', 'Clipboard permission and storage simulated in renderer; system clipboard untouched', 'Development Chromium host; packaged native Electron not checked'],
    startedAt: new Date().toISOString() };
for (const file of ['sync/user-message-history.ts', 'sync/sync-context.tsx', 'components/chat/message/MessageBody.tsx',
    'components/chat/message/parts/ToolPart.tsx', 'components/chat/message/parts/toolDiffPreview.ts', 'lib/messages/messageCopyText.ts',
    'components/chat/message/parts/tool-activity/targets.ts', 'components/chat/message/parts/RawPatchFallback.tsx',
    'components/chat/message/parts/toolDiffDownload.ts', 'components/chat/message/parts/toolPartDiffEntries.ts', 'components/chat/message/questionContext.ts']) {
    evidence.sourceHashes[file] = createHash('sha256').update(await readFile(path.join(root, 'packages/ui/src', file))).digest('hex');
}
let server, host, cdp;
const waitFor = async (expression) => {
    const start = performance.now();
    while (performance.now() - start < 45_000) {
        host.check();
        if (await evaluate(cdp, expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 75));
    }
    throw new Error(`Condition did not settle: ${expression}`);
};
const check = async (name, action) => {
    console.log(JSON.stringify({ name, status: 'started' }));
    await action(); evidence.checks.push({ name, outcome: 'passed' });
};
const page = async (expression, message) => assert.equal(await evaluate(cdp, expression), true, message);
const screenshot = async (name) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(output, name + '.png'), Buffer.from(data, 'base64'));
    evidence.screenshots.push(name + '.png');
};
try {
    server = await createServer({ configFile: path.join(root, 'tests/visual-chat-improvements/vite.config.ts'), server: { port: await reservePort() } });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const debugPort = await reservePort();
    host = startOwnedProcess(requireElectron('electron'), [path.join(root, 'scripts/qa/browser-shell.cjs'),
        `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    { cwd: root, env: { ...process.env, DEVRYAN_QA_ORIGIN: origin, ELECTRON_RUN_AS_NODE: '' } });
    cdp = await CdpConnection.connect((await discoverPageTarget(debugPort)).webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Page.bringToFront');
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => evidence.consoleErrors.push(sanitize(exceptionDetails.exception?.description ?? exceptionDetails.text)));
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await waitFor('Boolean(window.__chatFixture)');
    await check('bounded real tool previews bypass rich renderer', async () => {
        await waitFor("document.querySelectorAll('[data-tool-diff-truncated]').length === 3");
        await page("[...document.querySelectorAll('[data-tool-diff-truncated] pre')].every(n => n.textContent.length <= 262144 && n.textContent.split(/\\r\\n|\\r|\\n/).length <= 2000)", 'Preview bounds');
        evidence.initialSourceOperations = await evaluate(cdp, '({...window.__chatFixture.sourceOperations})');
        assert.deepEqual(evidence.initialSourceOperations, { split: 0, replace: 0, trim: 0 }, 'No whole-source processing before preview guards');
        await page('(globalThis.__fixtureRichDiffCalls ?? 0) === 0', 'Oversized inputs must never invoke the rich renderer');
        await page("!document.querySelector('#patch [data-diff], #patch diff-container') && !document.querySelector('#patch').textContent.includes('FULL SOURCE TAIL')", 'Full source must not enter rich DOM');
    });
    await check('exact full source download and object URL release', async () => {
        await evaluate(cdp, "document.querySelector('#patch [data-tool-diff-truncated] button').click()");
        const source = await evaluate(cdp, 'window.__chatFixture.sources.huge');
        const file = path.join(downloads, 'DevRyan-tool-diff.patch');
        for (let count = 0; count < 100; count += 1) {
            try { if (await readFile(file, 'utf8') === source) break; } catch { /* Download is pending. */ }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(await readFile(file, 'utf8'), source);
        await waitFor('window.__chatFixture.urls.revoked.length === window.__chatFixture.urls.created.length');
        await rm(file);
        await evaluate(cdp, "document.querySelector('#write [data-tool-diff-truncated] button').click()");
        const content = await evaluate(cdp, 'window.__chatFixture.sources.write');
        const lines = content.replace(/\r\n/g, '\n').split('\n');
        const expected = ['--- /dev/null', '+++ b/fixture/new.txt', `@@ -0,0 +1,${lines.length} @@`, lines.map((line) => `+${line}`).join('\n')].join('\n');
        for (let count = 0; count < 100; count += 1) {
            try { if (await readFile(file, 'utf8') === expected) break; } catch { /* Download is pending. */ }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(await readFile(file, 'utf8'), expected);
        await waitFor('window.__chatFixture.urls.revoked.length === window.__chatFixture.urls.created.length');
    });
    await check('rich renderer failure uses bounded raw fallback', async () => {
        await evaluate(cdp, "window.__chatFixture.setDiffStage('error')");
        await waitFor("document.querySelector('#patch pre')?.textContent.includes('fixture-renderer-error')");
        await page("!document.querySelector('#patch [data-tool-diff-truncated]') && globalThis.__fixtureRichDiffCalls > 0", 'Normal patch error fallback remains raw and untruncated');
        await evaluate(cdp, "window.__chatFixture.setDiffStage('oversized')");
        await waitFor("Boolean(document.querySelector('#patch [data-tool-diff-truncated]'))");
    });
    await check('question explanation visible once while pending, answered, failed and after late arrival', async () => {
        for (const stage of ['pending', 'answered', 'failed', 'delayed', 'pending', 'similar', 'plan']) {
            await evaluate(cdp, `window.__chatFixture.setStage(${JSON.stringify(stage)})`);
            await waitFor(`document.querySelector('#stage').dataset.stage === ${JSON.stringify(stage)}`);
            if (['delayed', 'similar'].includes(stage)) {
                await page("!document.querySelector('#question').textContent.includes('Context before the question.')", 'Ordinary unfinished text stays deferred');
            } else {
                await waitFor("document.querySelector('#question').textContent.includes('Context before the question.')");
                await page("document.querySelector('#question').textContent.split('Context before the question.').length === 2", 'Explanation appears once');
            }
        }
        await page("document.querySelectorAll('#question [data-plan-source-message-id]').length === 1", 'Question exception preserves one plan card');
        await evaluate(cdp, "window.__chatFixture.setMode('live'); window.__chatFixture.setStage('pending')");
        await waitFor("document.querySelector('#question').textContent.includes('Context before the question.')");
        await page("document.querySelector('#question').textContent.split('Context before the question.').length === 2", 'Live context appears once');
        await evaluate(cdp, "window.__chatFixture.setMode('sorted')");
        await waitFor("document.querySelector('#stage').dataset.stage === 'pending'");
    });
    await check('clipboard abstraction preserves Markdown and reports denied copy', async () => {
        await evaluate(cdp, "document.querySelector('#copy').click()");
        await waitFor("document.querySelector('#copy-result').textContent === 'Copied'");
        await page('window.__chatFixture.clipboard() === window.__chatFixture.sources.markdown', 'Markdown exact copy');
        await evaluate(cdp, "window.__chatFixture.denyCopy(true); document.querySelector('#copy').click()");
        await waitFor("document.querySelector('#copy-result').textContent === 'Copy failed'");
    });
    await check('history has zero commits across 120 separately flushed assistant updates', async () => {
        const before = await evaluate(cdp, '({...window.__chatFixture.counts})');
        await evaluate(cdp, "document.querySelector('#composer textarea').focus()");
        for (let index = 0; index < 120; index += 1) {
            await evaluate(cdp, `window.__chatFixture.stream(${index})`);
        }
        const after = await evaluate(cdp, '({...window.__chatFixture.counts})');
        evidence.renderCounts = { updates: 120, historyCommits: after.history - before.history, broadBaselineCommits: after.broad - before.broad };
        assert.equal(evidence.renderCounts.historyCommits, 0);
        assert.equal(evidence.renderCounts.broadBaselineCommits, 120);
        await page("document.querySelector('#composer textarea').value === 'Draft stays here' && document.activeElement === document.querySelector('#composer textarea')", 'Draft and focus retained');
        await evaluate(cdp, 'window.__chatFixture.editUser()');
        await waitFor("document.querySelector('#composer output').textContent === 'Edited prompt'");
        await evaluate(cdp, "document.querySelector('#composer textarea').focus()");
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
        await waitFor("document.querySelector('#composer textarea').value === 'Edited prompt'");
        await evaluate(cdp, "window.__chatFixture.setDirectory('/other')");
        await waitFor("document.querySelector('#composer output').textContent === 'Other directory'");
        await evaluate(cdp, "window.__chatFixture.setSession('deleted')");
        await waitFor("document.querySelector('#composer output').textContent === ''");
    });
    await screenshot('desktop-composer');
    await evaluate(cdp, "document.querySelector('h1').scrollIntoView({ block: 'start', behavior: 'instant' })");
    await screenshot('desktop-preview');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page('document.documentElement.scrollWidth <= innerWidth', 'No mobile viewport overflow');
    await evaluate(cdp, "document.querySelector('h1').scrollIntoView({ block: 'start', behavior: 'instant' })");
    await screenshot('mobile-preview');
    evidence.expectedRendererErrors = evidence.consoleErrors.filter((message) => message.includes('Deliberate fixture diff renderer failure'));
    assert.deepEqual(evidence.consoleErrors.filter((message) => !message.includes('Deliberate fixture diff renderer failure')), []);
    evidence.outcome = 'passed';
} catch (error) {
    evidence.error = sanitize(error.stack ?? error.message);
    if (cdp) {
        try { evidence.failureText = sanitize(await evaluate(cdp, 'document.body.innerText.slice(0, 3000)')); await screenshot('failure'); } catch { /* Host unavailable. */ }
    }
} finally {
    cdp?.close();
    if (host) { try { await host.stop(); } catch (error) { evidence.cleanupErrors.push(sanitize(error.message)); } }
    try { await server?.close(); } catch (error) { evidence.cleanupErrors.push(sanitize(error.message)); }
    try { await rm(profile, { recursive: true, force: true }); } catch (error) { evidence.cleanupErrors.push(sanitize(error.message)); }
    if (evidence.cleanupErrors.length) evidence.outcome = 'failed';
    evidence.finishedAt = new Date().toISOString();
    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify({ outcome: evidence.outcome, evidence: path.join(output, 'result.json'), error: evidence.error }));
process.exitCode = evidence.outcome === 'passed' ? 0 : 1;
