// Observational rollout: the immutable release DMG on a disposable macOS runner.
// No paid model requests, source repackaging or access to an installed profile.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRunRoot, scratchParent } from './run-root.mjs';
import { reservePort, startOwnedProcess } from './process.mjs';
import { qaPlatformEnvironment } from './launch-environment.mjs';

const execute = promisify(execFile);
export function gradeFinalDmgSmoke({ prerequisites, ready, composer, toolRoundTrip, screenshot, stopped }) {
  const failures = Object.entries({ prerequisites, ready, composer, toolRoundTrip, screenshot, stopped }).filter(([, passed]) => passed !== true).map(([name]) => name);
  return { passed: failures.length === 0, failures };
}

export async function smokeFinalDmg({ dmg, report, timeoutMs = 120000 }) {
  if (!path.isAbsolute(dmg || '') || !path.isAbsolute(report || '') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10000 || timeoutMs > 180000) throw new Error('Absolute --dmg and --report paths and a bounded timeout are required');
  const evidence = { schemaVersion: 1, kind: 'release-final-dmg-smoke', sourceRevision: process.env.GITHUB_SHA ?? null,
    runID: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    prerequisites: false, ready: false, composer: false, toolRoundTrip: false, screenshot: false, stopped: false, phase: 'prerequisites', observational: true };
  let root, app, cdp, provider, mounted = false;
  try {
    // A local invocation must never register a production app or inspect a user's keychain.
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('disposable_runner_required');
    const consoleUser = (await execute('/usr/bin/stat', ['-f', '%u', '/dev/console'], { timeout: 5000 })).stdout.trim();
    await execute('/bin/launchctl', ['print', `gui/${process.getuid()}`], { timeout: 5000, maxBuffer: 1024 * 1024 });
    if (consoleUser !== String(process.getuid())) throw new Error('gui_console_unavailable');
    evidence.prerequisites = true;
    root = createRunRoot({ parent: scratchParent('release-dmg-smoke'), owner: 'release-final-dmg-smoke', onInterrupt: async () => {
      cdp?.close();
      try { await app?.stop(); } finally {
        await provider?.close().catch(() => {});
        if (mounted) await execute('/usr/bin/hdiutil', ['detach', path.join(root.dir, 'mount'), '-force'], { timeout: 15000 }).catch(() => {});
        await fs.mkdir(path.dirname(report), { recursive: true });
        await fs.writeFile(report, JSON.stringify({ ...evidence, passed: false, phase: 'interrupted', failures: ['interrupted'] }, null, 2) + '\n');
      }
    } });
    const home = path.join(root.dir, 'home'), workspace = path.join(root.dir, 'workspace'), mount = path.join(root.dir, 'mount');
    for (const directory of [home, workspace, mount]) await fs.mkdir(directory, { recursive: true });
    evidence.dmgSha256 = createHash('sha256').update(await fs.readFile(dmg)).digest('hex');
    evidence.phase = 'mount';
    await execute('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], { timeout: 30000 });
    mounted = true;
    const port = await reservePort(), debugPort = await reservePort();
    const { createRuntimeUiProvider, runtimeUiConfiguration, runtimeUiToolPrompt, runtimeUiTuple } = await import('./native-backend-ui-diagnostic.mjs');
    provider = await createRuntimeUiProvider({ generation: 2, directory: workspace, packetDelayMs: 0 });
    const configuration = runtimeUiConfiguration(provider.baseURL);
    const configDirectory = path.join(home, '.config/opencode');
    await fs.mkdir(configDirectory, { recursive: true });
    // Ordinary imported custom-provider configuration, not a QA runtime hook.
    await fs.writeFile(path.join(configDirectory, 'opencode.json'), JSON.stringify(configuration));
    await fs.mkdir(path.join(workspace, 'src'));
    await fs.writeFile(path.join(workspace, 'src/tasks.mjs'), 'export const tasks = [];\n');
    const data = path.join(home, '.config/devryan');
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ desktopLocalPort: port, desktopLanAccessEnabled: false,
      enableBackgroundBots: false, productionBotsRuntimeMode: 'disabled', lastDirectory: workspace,
      defaultAgent: 'builder', defaultModel: `${runtimeUiTuple.providerID}/${runtimeUiTuple.modelID}` }));
    const env = { ...qaPlatformEnvironment(), HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'), TMPDIR: root.dir,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: root.dir };
    await execute('/usr/bin/git', ['init', '--quiet', '--initial-branch=main', '--template='], { cwd: workspace, env, timeout: 10000 });
    evidence.phase = 'first-ready';
    app = startOwnedProcess(path.join(mount, 'DevRyan.app/Contents/MacOS/DevRyan'),
      [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(home, 'electron-profile')}`, '--use-mock-keychain'], { cwd: workspace, env });
    const { CdpConnection, evaluate } = await import('./cdp.mjs');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      app.check();
      try {
        if (!cdp) {
          const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
          const target = targets.find(row => row.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(row.url) && row.webSocketDebuggerUrl);
          if (target) cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
        }
        if (cdp) {
          const observed = await evaluate(cdp, `(async()=>{const r=await fetch('/api/health');const h=await r.json();return {ready:r.ok&&h.isOpenCodeReady===true,
            composer:[...document.querySelectorAll('[contenteditable="true"],textarea')].some(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0;})};})()`, { timeoutMs: 5000 });
          evidence.ready = observed?.ready === true; evidence.composer = observed?.composer === true;
          if (evidence.ready && evidence.composer) break;
        }
      } catch { cdp?.close(); cdp = null; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (evidence.ready && evidence.composer) {
      evidence.phase = 'tool-round-trip';
      const sessionID = await evaluate(cdp, `(async()=>{const q='?directory='+encodeURIComponent(${JSON.stringify(workspace)});
        const headers={'content-type':'application/json','x-devryan-csrf':'1'};
        const created=await fetch('/api/session'+q,{method:'POST',headers,body:'{}'});
        if(!created.ok)throw Error('fixture_session_refused');const session=await created.json();
        const sent=await fetch('/api/session/'+encodeURIComponent(session.id)+'/prompt_async'+q,{method:'POST',headers,
          body:JSON.stringify({agent:'builder',variant:'high',model:${JSON.stringify({ providerID: runtimeUiTuple.providerID, modelID: runtimeUiTuple.modelID })},parts:[{type:'text',text:${JSON.stringify(runtimeUiToolPrompt)}}]})});
        if(!sent.ok)throw Error('fixture_prompt_refused');return session.id;})()`, { timeoutMs: 10000 });
      const toolDeadline = Date.now() + 60000;
      while (Date.now() < toolDeadline) {
        app.check(); provider.check();
        const completed = await evaluate(cdp, `(async()=>{const r=await fetch('/api/session/'+encodeURIComponent(${JSON.stringify(sessionID)})+'/message?directory='+encodeURIComponent(${JSON.stringify(workspace)}));
          if(!r.ok)return false;const rows=await r.json();const parts=rows.flatMap(row=>row.parts??[]);
          return ['read','write'].every(tool=>parts.some(p=>p.type==='tool'&&p.tool===tool&&p.state?.status==='completed'))
            && rows.some(row=>row.info?.role==='assistant'&&row.info?.time?.completed&&row.parts?.some(p=>p.type==='text'&&p.text?.includes('DevRyan tools complete.')));})()`, { timeoutMs: 5000 });
        if (completed) {
          evidence.toolRoundTrip = await fs.readFile(path.join(workspace, 'runtime-ui-proof.txt'), 'utf8').catch(() => '') === 'DevRyan actual backend publication\n';
          if (evidence.toolRoundTrip) break;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      evidence.providerRequests = provider.observations.length;
      if (!evidence.toolRoundTrip) evidence.errorCode = 'fixture_tool_round_trip_incomplete';
      evidence.phase = 'screenshot';
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, { timeoutMs: 5000 });
      await fs.mkdir(path.dirname(report), { recursive: true });
      await fs.writeFile(path.join(path.dirname(report), 'first-ready.png'), Buffer.from(shot.data, 'base64'));
      evidence.screenshot = true;
    }
  } catch (error) {
    evidence.errorCode = ['disposable_runner_required', 'gui_console_unavailable'].includes(error.message) ? error.message
      : evidence.phase === 'tool-round-trip' ? 'fixture_tool_round_trip_failed' : `release_dmg_${evidence.phase.replaceAll('-', '_')}_failed`;
  } finally {
    cdp?.close();
    evidence.lastPhase = evidence.phase;
    evidence.phase = 'cleanup';
    try { if (app) { await app.stop(); evidence.stopped = true; } } catch { evidence.cleanupFailed = true; }
    try { await provider?.close(); } catch { evidence.cleanupFailed = true; }
    if (mounted) { try { await execute('/usr/bin/hdiutil', ['detach', path.join(root.dir, 'mount'), '-force'], { timeout: 15000 }); } catch { evidence.cleanupFailed = true; } }
    Object.assign(evidence, gradeFinalDmgSmoke(evidence));
    if (evidence.cleanupFailed) { evidence.passed = false; evidence.failures.push('cleanup'); }
    evidence.phase = 'complete';
    await fs.mkdir(path.dirname(report), { recursive: true });
    await fs.writeFile(report, JSON.stringify(evidence, null, 2) + '\n');
    root?.finish(evidence.passed ? 'passed' : 'failed');
  }
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--dmg' || args[2] !== '--report') throw new Error('Usage: release-final-dmg-smoke.mjs --dmg <absolute DMG> --report <absolute JSON>');
  const result = await smokeFinalDmg({ dmg: args[1], report: args[3] });
  process.stdout.write(JSON.stringify({ passed: result.passed, failures: result.failures }) + '\n');
  process.exitCode = result.passed ? 0 : 1;
}
