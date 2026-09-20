import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createLoopbackOpenCodeFixture } from '../perf/loopback-opencode-fixture.mjs';
import { reservePort, startOwnedProcess } from './process.mjs';
import { CdpConnection, discoverPageTarget, evaluate } from './cdp.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(root, 'packages/electron/package.json'));
const electron = require('electron');
// Only repository-local artifacts are accepted; this runner never uses installed-app state.
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  if (!['--baseline', '--electron'].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error('Usage: node scripts/qa/settings-loading.mjs [--baseline <repository-local-web-build> | --electron <repository-local-QA-binary>]');
  }
}
const readOption = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const localPath = async value => {
  const resolved = await fs.realpath(path.resolve(root, value));
  if (!resolved.startsWith(root + path.sep)) throw new Error('Settings QA artifacts must be inside the repository');
  return resolved;
};
const baseline = readOption('--baseline') ? await localPath(readOption('--baseline')) : null;
const nativeBinary = readOption('--electron') ? await localPath(readOption('--electron')) : null;
if (nativeBinary && baseline) throw new Error('Use the web run for baseline comparison; the packaged run verifies its own shipped UI');
const runtime = nativeBinary ? 'electron' : 'web';
await fs.mkdir(path.join(root, '.cache/settings-loading'), { recursive: true });
const output = await fs.mkdtemp(path.join(root, `.cache/settings-loading/${runtime}-`));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const candidates = [...(baseline ? [['before', baseline]] : []), ['after', path.join(root, 'packages/web/dist')]];
for (const [label, dist] of candidates) {
  const own = path.join(output, label);
  const home = path.join(own, 'home'), data = path.join(own, 'data'), workspace = path.join(own, 'workspace'), profile = path.join(own, 'profile');
  await Promise.all([home, data, workspace, profile].map(dir => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(path.join(home, '.devryan-qa-home'), 'settings fixture');
  await fs.writeFile(path.join(own, 'credentials.env.json'), '{}');
  execFileSync('git', ['init', '--quiet', workspace]);
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ lastDirectory: workspace, messageStreamTransport: 'sse',
    projects: [{ id: 'settings-fixture', path: workspace, label: 'Settings fixture' }], activeProjectId: 'settings-fixture', productionBotsRuntimeMode: 'disabled' }));
  const fixture = await createLoopbackOpenCodeFixture({ directory: workspace });
  const port = await reservePort(), debugPort = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, OPENCHAMBER_DATA_DIR: data,
    OPENCHAMBER_DIST_DIR: dist, OPENCHAMBER_PORT: String(port), OPENCHAMBER_ELECTRON_USER_DATA_DIR: profile,
    OPENCODE_HOST: fixture.origin, OPENCODE_SKIP_START: 'true', OPENCHAMBER_SKIP_OPENCODE_START: 'true',
    DEVRYAN_QA_RUNTIME_ROOT: own, DEVRYAN_QA_HOME: home, DEVRYAN_QA_RUNTIME: runtime,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'),
    NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1', DEVRYAN_QA_BACKGROUND: '1' };
  const processes = [];
  let cdp;
  const until = async (label, fn, timeout = 60000) => {
    const start = Date.now();
    while (!(await fn())) { processes.forEach(p => p.check()); if (Date.now() - start > timeout) throw new Error(`Timeout ${label}`); await wait(100); }
  };
  try {
    console.log(JSON.stringify({ label, state: 'starting', output: own }));
    const flags = [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'];
    if (nativeBinary) {
      processes.push(startOwnedProcess(nativeBinary, flags, { cwd: root, env }));
    } else {
      processes.push(startOwnedProcess(process.execPath, ['scripts/qa/isolated-host.mjs'], { cwd: root, env }));
      await until('server', () => fetch(origin + '/api/health').then(r => r.ok, () => false));
      processes.push(startOwnedProcess(electron, [...flags, 'scripts/qa/browser-shell.cjs'],
        { cwd: root, env: { ...env, DEVRYAN_QA_ORIGIN: origin } }));
    }
    const target = await discoverPageTarget(debugPort);
    cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    const errors = [];
    cdp.on('Runtime.exceptionThrown', e => errors.push(e.exceptionDetails.exception?.description ?? e.exceptionDetails.text));
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.requestIdleCallback=()=>0; window.cancelIdleCallback=()=>{};
      for(const principal of ['anonymous','local-admin']) {
        localStorage.setItem('devryan.user.'+principal+':lastDirectory',${JSON.stringify(workspace)});
        localStorage.setItem('devryan.user.'+principal+':ui-store',JSON.stringify({version:20,state:{settingsPage:'shortcuts'}}));
      }
    ` });
    if (nativeBinary) await until('Electron loopback origin', async () => /^http:\/\/127\.0\.0\.1:\d+/.test(await evaluate(cdp, 'location.href')));
    for (const [width, height] of (nativeBinary ? [[1280, 800]] : [[1280, 800], [390, 844]])) {
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 500 });
      const loaded = cdp.waitFor('Page.loadEventFired');
      await cdp.send('Page.reload');
      await loaded;
      await until('app', () => evaluate(cdp, 'Boolean(document.querySelector("textarea"))'));
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 200, downloadThroughput: 1_000_000, uploadThroughput: 1_000_000 });
      for (const temperature of ['cold', 'warm']) {
        await evaluate(cdp, `(() => {
          const start=performance.now(); window.settingsTiming={start,frame:null,content:null,fullFallback:false};
          const observe=()=>{
            const frame=document.querySelector('[data-settings-view]');
            if(frame&&window.settingsTiming.frame===null)requestAnimationFrame(()=>{window.settingsTiming.frame??=performance.now()-start});
            if(frame&&[...frame.querySelectorAll('h3')].some(e=>e.textContent.includes('Keyboard Shortcuts'))&&window.settingsTiming.content===null)
              requestAnimationFrame(()=>{window.settingsTiming.content??=performance.now()-start});
            if(!frame&&[...document.querySelectorAll('[role=status]')].some(e=>e.textContent.trim()==='Loading...'))window.settingsTiming.fullFallback=true;
          };
          window.settingsObserver=new MutationObserver(observe); window.settingsObserver.observe(document.body,{subtree:true,childList:true});
          window.dispatchEvent(new KeyboardEvent('keydown',{key:',',code:'Comma',metaKey:true,bubbles:true}));observe();
        })()`);
        await wait(70);
        if (temperature === 'cold') {
          const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
          await fs.writeFile(path.join(own, `${width}-cold.png`), Buffer.from(image.data, 'base64'));
        }
        await until('shortcuts content', () => evaluate(cdp, 'window.settingsTiming.content!==null'));
        const timing = await evaluate(cdp, `(() => {
          window.settingsObserver.disconnect();const t=window.settingsTiming;
          const scripts=performance.getEntriesByType('resource').filter(e=>e.startTime>=t.start&&new URL(e.name).pathname.endsWith('.js'));
          const modules=scripts.filter(e=>!new URL(e.name).pathname.includes('/worker-'));
          return {...t,scriptRequests:scripts.length,scriptBytes:scripts.reduce((sum,e)=>sum+e.encodedBodySize,0),
            moduleRequests:modules.length,moduleBytes:modules.reduce((sum,e)=>sum+e.encodedBodySize,0),scripts:scripts.map(e=>new URL(e.name).pathname)};
        })()`);
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        await fs.writeFile(path.join(own, `${width}-${temperature}-ready.png`), Buffer.from(screenshot.data, 'base64'));
        results.push({ label, runtime, width, temperature, ...timing }); console.log(JSON.stringify(results.at(-1)));
        if (label === 'after' && timing.fullFallback) throw new Error('Settings replaced the frame with a loading screen');
        await evaluate(cdp, `window.dispatchEvent(new KeyboardEvent('keydown',{key:',',code:'Comma',metaKey:true,bubbles:true}))`);
        await until('closed', () => evaluate(cdp, '!document.querySelector("[data-settings-view]")'));
      }
    }
    await fs.writeFile(path.join(own, 'browser-errors.json'), JSON.stringify(errors, null, 2));
  } catch(error) {
    console.error(error.message);
    if(cdp) {
      await fs.writeFile(path.join(own,'failure-body.txt'),await evaluate(cdp,'document.body.innerText'));
      const screenshot=await cdp.send('Page.captureScreenshot',{format:'png'});
      await fs.writeFile(path.join(own,'failure.png'),Buffer.from(screenshot.data,'base64'));
    }
    throw error;
  } finally {
    cdp?.close();
    for (const [index,p] of processes.entries()) await fs.writeFile(path.join(own,`process-${index}.log`),p.getLog());
    for(const p of processes.reverse()) await p.stop();
    await fixture.close();
    await fs.writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2));
  }
}
console.log(JSON.stringify({ output, results, targetFrameMs: 100, idlePreloading: 'disabled to exercise cold entry' }));
