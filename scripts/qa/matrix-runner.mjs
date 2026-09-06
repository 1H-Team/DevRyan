import { mkdir, readFile, writeFile, rename, rm, readdir, stat, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { resolveSessionPlanRevision } from '../../packages/web/server/lib/plans/routes.js';
import { CdpConnection, discoverPageTarget, evaluate } from './cdp.mjs';
import { reservePort, startOwnedProcess } from './process.mjs';
import { createQaUiDriver } from './ui-driver.mjs';
import { expandQaMatrix, loadQaMatrixConfig } from './matrix-config.mjs';
import { createQaProjectFixture, removeQaProjectFixture } from './project-fixture.mjs';
import { gradeQaProject } from './acceptance-graders.mjs';
import { captureQaArtifactIdentity, captureQaSourceIdentity, preserveQaProject, sanitizeQaResult, validateQaScreenshotFilename } from './artifact-evidence.mjs';
import { loadQaPackagedArtifact } from './packaged-artifact.mjs';
import { gradeQaReasoningControls, projectReasoningOptions } from './reasoning-controls-evidence.mjs';
import { waitForQaHostReady } from './host-readiness.mjs';
import { effectiveQaSelectionIsReady, initialBootstrapSnapshotExpression, reloadQaInitialBootstrap } from './initial-bootstrap.mjs';
import { assertQaSubmittedPlanMode, findQaSubmittedUser, findQaTurnAssistants, findQaCompletedTurnAssistant } from './submitted-turn.mjs';
import { createQaTerminalPermissionGuard } from './terminal-permission.mjs';
import { readQaSavedPlanRevision, requireQaCompactionPlanSource } from './compaction-approval.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const requireElectron = createRequire(new URL('../../packages/electron/package.json', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runQaMatrixCell(cell) {
  const fixture = createQaProjectFixture({ outputRoot: cell.evidenceDirectory, runId: cell.runId, agent: cell.agent, planMode: cell.planMode });
  const runtimeRoot = path.join(fixture.evidenceDirectory, 'runtime');
  const capturedScreenshots = [];
  const evidence = { schemaVersion: 1, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    cell, startedAt: new Date().toISOString(), outcome: 'failed', checks: [], screenshots: capturedScreenshots, consoleErrors: [], cleanupErrors: [],
    seedManifestSha256: fixture.seedManifestSha256, visualReview: 'pending', physicalDevice: 'not-run' };
  const sanitizer = createDiagnosticSanitizer({ homeDir: process.env.HOME, pathMappings: [{ path: fixture.evidenceDirectory, placeholder: '<QA_RUN>' }, { path: root, placeholder: '<REPOSITORY>' }] });
  const sanitize = value => sanitizer.sanitizeText(String(value));
  const owned = [];
  let cdp, profile, ui, artifactDirectory, artifactIdentity, sourceIdentity, runnerIdentity, packaged, advertisedVariant;
  let interrupted = false;
  const runDeadline = Date.now() + cell.timeoutMs;
  const interrupt = () => { interrupted = true; };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const checkAlive = () => {
    if (interrupted) throw new Error('QA interrupted');
    if (Date.now() > runDeadline) throw new Error('QA cell exceeded its timeout');
    for (const child of owned) child.check();
  };
  const start = (binary, args, env) => { const child = startOwnedProcess(binary, args, { cwd: root, env }); owned.push(child); return child; };
  const screenshot = async name => {
    const filename = validateQaScreenshotFilename(`${name}.png`);
    await delay(250);
    await evaluate(cdp, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(fixture.evidenceDirectory, filename), Buffer.from(data, 'base64'));
    capturedScreenshots.push(filename);
  };
  const check = async (name, action) => {
    console.log(JSON.stringify({ run: cell.runId, check: name, state: 'started' }));
    const started = performance.now();
    try { const detail = await action(); evidence.checks.push({ name, outcome: 'passed', elapsedMs: performance.now() - started, ...(detail ? { detail } : {}) }); return detail; }
    catch (error) { evidence.checks.push({ name, outcome: 'failed', elapsedMs: performance.now() - started, error: sanitize(error.message) }); throw error; }
  };
  const api = async (route, options = {}) => {
    const result = await evaluate(cdp, `fetch(${JSON.stringify(route)},${JSON.stringify({ ...options, headers: { 'content-type': 'application/json', 'x-opencode-directory': fixture.fixtureRoot, 'X-DevRyan-CSRF': '1', ...options.headers } })}).then(async r=>({status:r.status,body:await r.json().catch(()=>null)}))`);
    if (result.status < 200 || result.status >= 300) {
      const routeName = route.split('?')[0].replace(/\/(?:ses|msg)_[^/]+/g, '/:id');
      const detail = typeof result.body?.error === 'string' ? `: ${sanitize(result.body.error).slice(0, 240)}` : '';
      throw new Error(`QA API ${routeName}: HTTP ${result.status}${detail}`);
    }
    return result.body;
  };
  let sessionID;
  let nativeAgent = cell.agent;
  const readProviderObservation = async () => {
    try { return (await readFile(path.join(runtimeRoot, 'provider-evidence.ndjson'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const messages = () => api(`/api/session/${sessionID}/message?directory=${encodeURIComponent(fixture.fixtureRoot)}`);
  const waitTurn = async ({ previousIds, text, selectUser, startedAt, onTurnObservation }) => {
    const observationStart = startedAt;
    const terminalPermissionGuard = createQaTerminalPermissionGuard();
    await ui.waitFor('created canonical session', async () => {
      sessionID = await evaluate(cdp, `new URL(location.href).searchParams.get('session')`);
      return /^ses_[a-zA-Z0-9]+$/.test(sessionID || '');
    });
    const rows = await ui.waitFor('authoritative completed turn', async () => {
      const observations = await readProviderObservation();
      const sessionError = observations.find(row => row.kind === 'native.session.error' && row.sessionID === sessionID && row.at >= observationStart);
      if (sessionError) throw new Error(`Native session failed before completing the turn: ${sessionError.errorName || 'unknown'}`);
      const rows = await messages();
      const submitted = selectUser ? selectUser(rows) : findQaSubmittedUser(rows, previousIds, text);
      if (!submitted) return false;
      if (!selectUser) assertQaSubmittedPlanMode(submitted, cell.planMode);
      const assistants = findQaTurnAssistants(rows, previousIds, submitted.info.id);
      const failure = assistants.find(row => row.info.error);
      if (failure) throw new Error(`Provider turn failed: ${failure.info.error.name || 'unknown'}`);
      const status = await api(`/api/session/status?directory=${encodeURIComponent(fixture.fixtureRoot)}`);
      const denial = terminalPermissionGuard({ rows, previousIds, submittedUser: submitted, sessionID, status, observations });
      if (denial) {
        evidence.terminalPermissionDenial = denial;
        throw new Error(`QA terminal permission rejected: ${denial.requestID} (${denial.callID})`);
      }
      await onTurnObservation?.({ rows, submitted, assistants, status, observations, sessionID });
      if (findQaCompletedTurnAssistant({ rows, previousIds, submittedUser: submitted, sessionID, status })) return rows;
      await delay(400);
      return false;
    }, cell.timeoutMs);
    const submitted = selectUser ? selectUser(rows) : findQaSubmittedUser(rows, previousIds, text);
    const user = submitted.info;
    const expectedVariant = cell.variant === null ? '' : cell.variant;
    const canonicalVariant = user.model?.variant ?? user.variant;
    if (user.model?.providerID !== cell.providerId || user.model?.modelID !== cell.modelId || user.agent !== nativeAgent || (canonicalVariant ?? '') !== expectedVariant) {
      throw new Error('Canonical turn differs from the pinned provider/model/agent/variant');
    }
    evidence.sessionID = sessionID;
    evidence.turns ||= [];
    evidence.turns.push({ userMessageID: user.id, agent: user.agent, model: user.model, variant: canonicalVariant ?? null,
      planMode: assertQaSubmittedPlanMode(submitted, selectUser ? false : cell.planMode),
      assistants: findQaTurnAssistants(rows, previousIds, user.id).map(row => ({ id: row.info.id, finish: row.info.finish, tokens: row.info.tokens,
        reasoning: row.parts.filter(p => p.type === 'reasoning').map(p => ({ id: p.id, length: (p.text || '').length, time: p.time })),
        tools: row.parts.filter(p => p.type === 'tool').map(p => ({ id: p.id, callID: p.callID, tool: p.tool, status: p.state?.status })) })) });
    return rows;
  };
  const sendTurn = async (text, { onTurnObservation } = {}) => {
    const previousIds = new Set(sessionID ? (await messages()).map(row => row.info.id) : []);
    const startedAt = Date.now();
    await ui.send(text);
    return waitTurn({ previousIds, text, startedAt, onTurnObservation });
  };
  let readSavedRevision;
  const captureSavedPlan = async (name, request) => {
    const userMessageID = request?.userMessageID;
    if (request && (typeof userMessageID !== 'string' || !userMessageID)) {
      throw new Error('An exact Plan capture requires its canonical user request');
    }
    const session = await api(`/api/session/${sessionID}?directory=${encodeURIComponent(fixture.fixtureRoot)}`);
    if (userMessageID && (session.id !== sessionID || session.directory !== fixture.fixtureRoot)) {
      throw new Error('The saved Plan session storage identity changed');
    }
    const rows = await messages();
    const candidates = userMessageID
      ? [requireQaCompactionPlanSource(rows, { sessionID, userMessageID })]
      : rows.filter(row => row.info?.role === 'assistant' && row.info.time?.completed).toReversed();
    let saved;
    await ui.waitFor('canonical saved plan revision', async () => {
      for (const row of candidates) {
        const identity = { sessionId: sessionID, sourceMessageId: row.info.id, directory: fixture.fixtureRoot,
          sessionCreated: session.time.created, sessionSlug: session.slug };
        try {
          const result = await readSavedRevision(identity);
          if (userMessageID) requireQaCompactionPlanSource(rows, { sessionID, userMessageID, content: result.content });
          saved = { ...result, sourceMessageID: row.info.id }; return true;
        } catch (error) { if (!/HTTP 404(?:$|:)/.test(error.message)) throw error; }
      }
      return false;
    });
    const evidencePath = path.join(fixture.evidenceDirectory, `${name}.md`);
    await writeFile(evidencePath, saved.content, { mode: 0o600 });
    const captured = { path: evidencePath, sha256: createHash('sha256').update(saved.content).digest('hex'), sourceMessageID: saved.sourceMessageID, canonicalPath: saved.canonicalPath,
      revision: saved.identity, ...(userMessageID ? { userMessageID } : {}) };
    evidence.plans ||= [];
    evidence.plans.push(captured);
    return captured;
  };
  try {
    sourceIdentity = await captureQaSourceIdentity(root);
    await writeFile(path.join(fixture.evidenceDirectory, 'source-provenance.json'), JSON.stringify(sourceIdentity, null, 2));
    runnerIdentity = await captureQaArtifactIdentity(path.join(root, 'scripts'));
    await writeFile(path.join(fixture.evidenceDirectory, 'runner-provenance.json'), JSON.stringify(runnerIdentity, null, 2));
    if (cell.transport === 'live') {
      const { prepareQaProfile, assertQaSelectedProviderDuration } = await import('./profile-preparation.mjs');
      profile = await prepareQaProfile({ runtimeRoot, workspace: fixture.fixtureRoot, providerId: cell.providerId, modelId: cell.modelId, variant: cell.variant });
      evidence.profile = profile.evidence;
      evidence.credentialAdmission = assertQaSelectedProviderDuration(cell.providerId, profile.evidence.credentials, cell.timeoutMs);
    } else {
      const { prepareQaFixtureProfile } = await import('./fixture-scenarios.mjs');
      profile = await prepareQaFixtureProfile({ runtimeRoot, workspace: fixture.fixtureRoot, cell });
    }
    evidence.profile = profile.evidence;
    // The directory depends only on the prepared profile and owned fixture.
    // Fixed filename inputs resolve that scope before any returned API identity.
    const ownedPlansRoot = (await resolveSessionPlanRevision({ dataDirectory: profile.env.OPENCHAMBER_DATA_DIR,
      directory: fixture.fixtureRoot, sessionCreated: 1, sessionSlug: 'qa-scope', sourceMessageID: 'qa-scope', path })).directory;
    readSavedRevision = identity => readQaSavedPlanRevision(api, identity, ownedPlansRoot);
    if (cell.runtime === 'electron') {
      packaged = await loadQaPackagedArtifact({ root, evidencePath: process.env.DEVRYAN_QA_PACKAGE_EVIDENCE });
      artifactDirectory = packaged.artifactDirectory;
      evidence.package = { electronVersion: packaged.evidence.electronVersion, archiveSha256: packaged.evidence.archiveSha256,
        sourceSha256: packaged.evidence.source?.sha256, excludedAcceptance: packaged.evidence.excludedAcceptance };
      await writeFile(path.join(fixture.evidenceDirectory, 'package-provenance.json'), JSON.stringify(packaged.evidence, null, 2));
    } else artifactDirectory = await realpath(path.resolve(root, process.env.DEVRYAN_QA_DIST_DIR || 'packages/web/dist'));
    if (!artifactDirectory.startsWith(`${root.replace(/\/$/, '')}${path.sep}`)) throw new Error('QA artifact directory must be inside this repository');
    artifactIdentity = await captureQaArtifactIdentity(artifactDirectory);
    await writeFile(path.join(fixture.evidenceDirectory, 'artifact-provenance.json'), JSON.stringify(artifactIdentity, null, 2));
    evidence.artifactDirectory = sanitize(artifactDirectory);
    const manifest = await readFile(path.join(artifactDirectory, '.vite/manifest.json'));
    evidence.artifactManifestSha256 = createHash('sha256').update(manifest).digest('hex');
    const port = await reservePort();
    const debugPort = await reservePort();
    const env = { ...process.env, ...profile.env, DEVRYAN_QA_RUNTIME: cell.runtime, OPENCHAMBER_PORT: String(port), OPENCHAMBER_DIST_DIR: artifactDirectory };
    delete env.ELECTRON_RUN_AS_NODE;
    const flags = [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile.env.OPENCHAMBER_ELECTRON_USER_DATA_DIR}`, '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'];
    if (cell.runtime === 'electron') start(packaged.binary, flags, env);
    else start('node', [profile.bootstrapPath], env);
    await check('initial managed runtime readiness', () => waitForQaHostReady({
      ...(cell.runtime === 'web' ? { origin: `http://127.0.0.1:${port}` } : { debugPort }), checkAlive,
    }));
    if (cell.runtime === 'web') {
      start(requireElectron('electron'), [...flags, 'scripts/qa/browser-shell.cjs'], { ...env, DEVRYAN_QA_ORIGIN: `http://127.0.0.1:${port}` });
    }
    const target = await discoverPageTarget(debugPort);
    cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
    ui = createQaUiDriver(cdp, { checkAlive });
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
    const onError = text => { if (evidence.consoleErrors.length < 100) evidence.consoleErrors.push(sanitize(text)); };
    cdp.on('Runtime.exceptionThrown', e => onError(e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text));
    cdp.on('Runtime.consoleAPICalled', e => { if (e.type === 'error') onError(e.args.map(a => a.value ?? a.description ?? '').join(' ')); });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `if(location.protocol==='http:'&&location.hostname==='127.0.0.1')for(const p of ['anonymous','local-admin'])localStorage.setItem('devryan.user.'+p+':lastDirectory',${JSON.stringify(fixture.fixtureRoot)});` });
    await ui.waitExpression('candidate origin', `location.protocol==='http:' && location.hostname==='127.0.0.1'`, 90000);
    await check('initial application and catalog bootstrap', () => reloadQaInitialBootstrap({
      cdp, cell, directory: fixture.fixtureRoot, cellDeadline: runDeadline, checkAlive,
      record: async bootstrap => {
        evidence.initialBootstrap = bootstrap;
        await writeFile(path.join(fixture.evidenceDirectory, 'initial-bootstrap.json'), JSON.stringify(bootstrap, null, 2));
      },
    }));
    await cdp.send('Page.bringToFront');
    evidence.inspection = { app: await evaluate(cdp, 'location.origin'), cdp: `http://127.0.0.1:${debugPort}` };
    console.log(JSON.stringify({ run: cell.runId, output: fixture.evidenceDirectory, inspection: evidence.inspection }));
    await check('candidate provider and managed runtime readiness', async () => {
      const health = await ui.waitFor('OpenCode readiness', async () => { const h = await api('/api/health'); return h.isOpenCodeReady ? h : false; }, 120000);
      if (cell.transport === 'live' && health.openCodeVersion !== '1.18.29') throw new Error('Candidate OpenCode version does not match the pinned runtime');
      evidence.runtimeVersion = health.openCodeVersion;
      if (packaged) {
        const host = JSON.parse(await readFile(path.join(runtimeRoot, 'packaged-host.json'), 'utf8'));
        if (host.isPackaged !== true) throw new Error('Electron acceptance is not running the packaged application');
        evidence.packagedHost = host;
        await writeFile(path.join(fixture.evidenceDirectory, 'packaged-host.json'), JSON.stringify(host, null, 2));
      }
      const catalog = await api('/api/provider');
      const provider = catalog.all?.find(p => p.id === cell.providerId);
      if (!provider?.models?.[cell.modelId] || !catalog.connected?.includes(cell.providerId)) throw new Error('Pinned model access is unavailable');
      evidence.modelName = provider.models[cell.modelId].name;
      if (cell.variant !== null && !Object.hasOwn(provider.models[cell.modelId].variants ?? {}, cell.variant)) throw new Error('Pinned effort is not advertised by the configured adapter');
      evidence.advertisedVariants = Object.keys(provider.models[cell.modelId].variants ?? {});
      advertisedVariant = cell.variant === null ? null : provider.models[cell.modelId].variants[cell.variant];
      evidence.advertisedVariantControls = projectReasoningOptions(advertisedVariant);
      const agents = await api('/api/agent');
      const visibleAgents = agents.filter(agent => !agent.hidden);
      nativeAgent = cell.agent === 'builder' && !visibleAgents.some(agent => agent.name === 'builder') ? 'build' : cell.agent;
      if (!visibleAgents.some(agent => agent.name === nativeAgent)) throw new Error('Pinned primary agent is unavailable');
      evidence.nativeAgent = nativeAgent;
      if (cell.transport === 'live') {
        const toolIDs = await api('/api/experimental/tool/ids');
        if (!Array.isArray(toolIDs) || !toolIDs.every(id => typeof id === 'string')
          || !toolIDs.includes('devryan_task')) throw new Error('Native managed orchestration plugin is not registered');
        evidence.nativeToolInventory = toolIDs;
      }
      if (cell.transport === 'fixture') {
        const configCatalog = await api(`/api/config/agents?directory=${encodeURIComponent(fixture.fixtureRoot)}`);
        evidence.fixtureConfigAgentPins = ['builder','orchestrator'].map(name => {
          const agent = configCatalog.agents?.find(entry => entry.name === name);
          if (agent?.model?.providerID !== cell.providerId || agent.model.modelID !== cell.modelId || agent.variant !== 'low') {
            throw new Error(`Fixture config-agent ${name} did not receive its pinned model and Low fallback`);
          }
          return { name:agent.name, model:agent.model, variant:agent.variant, source:agent.source, overrides:agent.overrides };
        });
      }
    });
    await check('browser loaded the recorded candidate artifact', async () => {
      const mainEntry = JSON.parse(manifest)['index.html'];
      if (!mainEntry?.isEntry || typeof mainEntry.file !== 'string') throw new Error('Candidate manifest has no main entry module');
      const entries = [mainEntry];
      evidence.servedEntries = [];
      for (const entry of entries) {
        const sha256 = createHash('sha256').update(await readFile(path.join(artifactDirectory, entry.file))).digest('hex');
        const loaded = await evaluate(cdp, `(async()=>{const script=[...document.scripts].find(s=>new URL(s.src,location.href).pathname===${JSON.stringify('/' + entry.file)});if(!script)return null;const response=await fetch(script.src,{cache:'no-store'});if(!response.ok)return null;const hash=await crypto.subtle.digest('SHA-256',await response.arrayBuffer());return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');})()`);
        if (loaded !== sha256) throw new Error('Loaded UI entry differs from the recorded candidate artifact');
        evidence.servedEntries.push({ file: entry.file, sha256 });
      }
    });
    await check('new session and primary agent selection', async () => {
      await ui.click({ text: 'New Chat' });
      await ui.waitExpression('new composer', `Boolean(document.querySelector('textarea'))`);
      const agentTrigger = 'button:has(.model-controls__agent-label)';
      await ui.click({ selector: agentTrigger });
      await ui.waitExpression('primary agent menu opened', `Boolean(document.querySelector(${JSON.stringify(agentTrigger + '[aria-expanded="true"]')})) && [...document.querySelectorAll('[role="menuitem"]')].some(e=>e.innerText?.trim()==='Builder')`);
      await ui.click({ selector: '[role="menuitem"]', text: cell.agent === 'builder' ? 'Builder' : 'Orchestrator' });
      await ui.waitExpression('selected primary agent committed', `[...document.querySelectorAll('.model-controls__agent-label')].some(e=>e.innerText.trim()===${JSON.stringify(cell.agent === 'builder' ? 'Builder' : 'Orchestrator')}&&e.closest('button')&&!e.closest('button').disabled&&e.getBoundingClientRect().width>0)`);
      await ui.waitFor('exact provider, model and primary agent selected before send', async () => {
        evidence.effectiveSelection = await evaluate(cdp, initialBootstrapSnapshotExpression(cell));
        return effectiveQaSelectionIsReady(evidence.effectiveSelection, cell, nativeAgent);
      });
      await ui.click({ selector: 'button.model-controls__variant-trigger' });
      const variantLabel = cell.variant === null ? 'Default' : cell.variant.charAt(0).toUpperCase() + cell.variant.slice(1);
      await ui.click({ selector: '[role="menuitem"]', text: variantLabel });
      await ui.waitExpression('pinned thinking control', `[...document.querySelectorAll('.model-controls__variant-trigger')].some(e=>e.innerText.trim()===${JSON.stringify(variantLabel)})`);
      if (cell.planMode) { await ui.type(''); await ui.key('Tab', { code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9 }); }
      await ui.click({ selector: agentTrigger });
      await ui.waitExpression('orthogonal Plan toggle', `[...document.querySelectorAll('[aria-pressed]')].some(e=>e.innerText?.trim().startsWith('Plan')&&e.getAttribute('aria-pressed')===${JSON.stringify(String(cell.planMode))})`);
      await ui.key('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 });
      evidence.selection = { agent: cell.agent, variant: cell.variant, planMode: cell.planMode, observedInControls: true };
      await screenshot('configured-composer');
    });
    if (cell.transport === 'fixture') {
      const { runQaFixtureScenario } = await import('./fixture-scenarios.mjs');
      evidence.fixtureScenario = await runQaFixtureScenario({ cell, fixture: profile.fixture, projectFixture: fixture, cdp, ui, api, check, screenshot, runDeadline });
      evidence.fixture = profile.fixture.getState();
    } else if (cell.scenarioId === 'core-journey') {
      const revealResponse = async (text, messageID) => {
        const row = `[data-message-id="${messageID}"]`;
        const expand = `${row} button[aria-label="Expand Plan"]`;
        if (await evaluate(cdp, `Boolean(document.querySelector(${JSON.stringify(expand)}))`)) {
          await ui.click({ selector: expand });
        }
        await ui.revealText(text, row);
      };
      await check('live send and visible response', async () => {
        await sendTurn('This is a Coding Agents UI acceptance check. Do not use tools or change files. Reply with exactly: DevRyan live QA ready.');
        await revealResponse('DevRyan live QA ready.', evidence.turns.at(-1).assistants.at(-1).id);
      });
      await check('reload retains one canonical user turn', async () => {
        const id = evidence.turns[0].userMessageID;
        await ui.reload();
        await ui.waitExpression('restored canonical row', `[...document.querySelectorAll('[data-message-id]')].filter(e=>e.dataset.messageId===${JSON.stringify(id)}).length===1`);
        await revealResponse('DevRyan live QA ready.', evidence.turns[0].assistants.at(-1).id);
      });
      await check('cancel an actual live generation', async () => {
        await ui.send('Do not use tools or edit files. Write 250 numbered one-line test cases for task-board event ordering, priorities and persistence. Start immediately and continue the list without a preamble.');
        await ui.waitExpression('live stop control', `[...document.querySelectorAll('button')].some(e=>e.getAttribute('aria-label')==='Stop Generating'&&!e.disabled)`);
        await ui.waitFor('canonical in-progress assistant', async () => {
          const rows = await messages();
          const user = rows.filter(row => row.info?.role === 'user').at(-1);
          const parameters = (await readProviderObservation()).some(row => row.kind === 'chat.params'
            && row.sessionID === sessionID && row.messageID === user?.info.id);
          return parameters && rows.some(row => row.info?.role === 'assistant' && row.info.parentID === user?.info.id && !row.info.time?.completed);
        });
        await screenshot('live-before-cancel');
        await ui.click({ label: 'Stop Generating' });
        await ui.waitFor('canonical cancellation settles', async () => {
          const status = await api(`/api/session/status?directory=${encodeURIComponent(fixture.fixtureRoot)}`);
          return !status[sessionID] || status[sessionID].type === 'idle';
        });
        const rows = await ui.waitFor('canonical aborted assistant finalization', async () => {
          const rows = await messages();
          const user = rows.filter(row => row.info?.role === 'user').at(-1);
          return rows.some(row => row.info?.parentID === user?.info.id && row.info.time?.completed
            && row.info.error?.name === 'MessageAbortedError') ? rows : false;
        });
        const user = rows.filter(row => row.info?.role === 'user').at(-1);
        const assistants = rows.filter(row => row.info?.parentID === user.info.id);
        evidence.cancellation = { userMessageID: user.info.id, assistants: assistants.map(row => ({ messageID: row.info.id,
          completed: row.info.time?.completed ?? null, errorName: row.info.error?.name ?? null })) };
        if (!assistants.some(row => row.info.error?.name === 'MessageAbortedError')) throw new Error('Live cancellation has no canonical abort evidence');
      });
      await check('live reconnect and continuation without duplication', async () => {
        const previousRows = await messages();
        const before = previousRows.filter(row => row.info?.role === 'user').length;
        const previousIds = new Set(previousRows.map(row => row.info.id));
        const text = 'Continue this UI acceptance check. Do not use tools or change files. Write 60 numbered one-line test cases for optimistic task updates, then finish with the exact line: DevRyan reconnect complete.';
        const startedAt = Date.now();
        await ui.send(text);
        await ui.waitExpression('generation before network interruption', `[...document.querySelectorAll('button')].some(e=>e.getAttribute('aria-label')==='Stop Generating'&&!e.disabled)`);
        evidence.networkInterruption = { startedAt: Date.now(), offlineMs: 1500 };
        await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await delay(1500);
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await waitTurn({ previousIds, text, startedAt });
        await revealResponse('DevRyan reconnect complete.', evidence.turns.at(-1).assistants.at(-1).id);
        const userIDs = (await messages()).filter(row => row.info?.role === 'user').map(row => row.info.id);
        if (userIDs.length !== before + 1 || new Set(userIDs).size !== userIDs.length) throw new Error('Reconnect duplicated canonical user messages');
        await ui.reload();
        await revealResponse('DevRyan reconnect complete.', evidence.turns.at(-1).assistants.at(-1).id);
        await ui.waitExpression('unique visible canonical rows', `(()=>{const rows=[...document.querySelectorAll('[data-message-id]')].map(e=>e.dataset.messageId);return new Set(rows).size===rows.length;})()`);
      });
    } else if (cell.scenarioId === 'project-work') {
      await check('seeded independent failures', async () => {
        const baseline = gradeQaProject({ fixture, phase: 'baseline' }); evidence.projectBaseline = baseline;
        const resultFor = id => baseline.checks.find(item => item.id === id)?.passed;
        if (resultFor('project.independent-probe-completed') !== true
          || resultFor('project.summary') !== false || resultFor('project.monotonic-events') !== false
          || resultFor('project.user-edit-and-requirements') !== true || resultFor('project.original-tests-retained') !== true) {
          throw new Error('Seed no longer reproduces the expected defects');
        }
      });
      if (cell.projectCompaction === 'manual') {
        const { runQaProjectManualCompaction } = await import('./project-compaction.mjs');
        await runQaProjectManualCompaction({ cell, projectFixture: fixture, cdp, ui, api, check, screenshot, runDeadline,
          sendTurn, messages, getSessionID: () => sessionID, captureSavedPlan, readSavedRevision, readProviderObservation, nativeAgent,
          record: result => { Object.assign(evidence, result); } });
      } else {
        await check('initial diagnosis and attached requirements', async () => { await ui.attach(fixture.attachments.map(a => a.path)); await sendTurn(fixture.prompts.initial); });
        if (cell.planMode) {
          const savedPlan = await captureSavedPlan('plan-revision-1');
          const grade = gradeQaProject({ fixture, phase: 'plan', savedPlan }); evidence.initialPlanGrade = grade;
          if (!grade.passed) throw new Error('Initial planning changed implementation or failed to persist');
        }
        await screenshot('diagnosis');
        await check('mid-task requirement revision', async () => { await sendTurn(fixture.prompts.revision); });
        await screenshot('revised-task');
        if (cell.planMode) {
          await check('saved revised plan preserves implementation', async () => {
            const savedPlan = await captureSavedPlan('plan-revision-2');
            const grade = gradeQaProject({ fixture, phase: 'plan', savedPlan }); evidence.planGrade = grade;
            if (!grade.passed || savedPlan.sha256 === evidence.plans[0].sha256) throw new Error('Revised plan acceptance failed');
            const content = await readFile(savedPlan.path, 'utf8');
            if (!/creation order/i.test(content) || !/priority filter/i.test(content)) throw new Error('Latest plan omits revision 2 requirements');
          });
          await check('approve the current plan through its UI card', async () => {
            const previousIds = new Set((await messages()).map(row => row.info.id));
            const current = evidence.plans.at(-1);
            const selector = `[data-plan-source-message-id=${JSON.stringify(current.sourceMessageID)}] button`;
            await ui.reveal(selector, 'Implement Plan', { scrollContainer: '[data-scrollbar="chat"]', direction: 'up' });
            const startedAt = Date.now();
            await ui.click({ selector, text: 'Implement Plan' });
            const { findQaPlanApprovalUser } = await import('./compaction-scenarios.mjs');
            await waitTurn({ previousIds, startedAt, selectUser: rows => findQaPlanApprovalUser(rows, previousIds,
              { sessionID, sourceMessageID: current.sourceMessageID, cell, nativeAgent }) });
          });
        } else {
          await check('approved revision implementation', async () => { await sendTurn(fixture.prompts.approve); });
        }
      }
      await check('independent project behavior and preservation', async () => {
        const grade = evidence.projectGrade ?? gradeQaProject({ fixture, phase: 'implemented' }); evidence.projectGrade = grade;
        if (!grade.passed) throw new Error('Independent project acceptance failed');
      });
    } else if (['compaction-retrieval-control', 'compaction-retrieval-compacted'].includes(cell.scenarioId)) {
      const { runQaRetrievalDiagnostic } = await import('./compaction-retrieval-diagnostic.mjs');
      evidence.purpose = 'manual-summary-retrieval-diagnostic';
      evidence.retentionAcceptance = false;
      evidence.naturalCompactionAcceptance = false;
      evidence.automaticContinuationAcceptance = false;
      evidence.retrievalDiagnostic = await runQaRetrievalDiagnostic({ cell, projectFixture: fixture, ui, api, check, screenshot,
        sendTurn, messages, getSessionID: () => sessionID, readProviderObservation, nativeAgent, sanitize,
        nativeOutputTokenMax: profile.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX,
        identity: { sourceSha256: sourceIdentity.sha256, runnerSha256: runnerIdentity.sha256,
          artifactSha256: artifactIdentity.sha256, packageArchiveSha256: packaged.evidence.archiveSha256,
          fixtureSeedSha256: fixture.seedManifestSha256,
          profileSha256: createHash('sha256').update(JSON.stringify(profile.evidence.fingerprints)).digest('hex') },
        record: diagnostic => { evidence.retrievalDiagnostic = diagnostic; } });
    } else if (cell.scenarioId === 'compaction-manual') {
      const { runQaManualCompaction } = await import('./compaction-scenarios.mjs');
      evidence.compaction = await runQaManualCompaction({ cell, projectFixture: fixture, cdp, ui, api, check, screenshot, runDeadline,
        sendTurn, messages, getSessionID: () => sessionID, captureSavedPlan, readSavedRevision,
        readProviderObservation, nativeAgent });
    } else if (cell.scenarioId === 'compaction-natural') {
      const { runQaNaturalCompaction } = await import('./natural-compaction-scenarios.mjs');
      evidence.compaction = await runQaNaturalCompaction({ cell, projectFixture: fixture, cdp, ui, api, check, screenshot,
        sendTurn, messages, getSessionID: () => sessionID, captureSavedPlan, readSavedRevision, readProviderObservation, nativeAgent,
        nativeOutputTokenMax: profile.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX });
    } else throw new Error(`Scenario ${cell.scenarioId} has not completed its live UI adapter`);
    if (cell.transport === 'live' && ['project-work', 'compaction-manual', 'compaction-natural'].includes(cell.scenarioId)) {
      const { captureQaTaskEvidence } = await import('./live-task-evidence.mjs');
      await check('canonical task execution and disposition evidence', async () => {
        evidence.taskExecution = await captureQaTaskEvidence({ api, rootSessionID: sessionID, directory: fixture.fixtureRoot,
          agent: cell.agent, planMode: cell.planMode, requireProjectWork: true });
        if (!evidence.taskExecution.passed) throw new Error('Canonical task execution or disposition acceptance failed');
      });
      const { reviewQaProjectBrowser } = await import('./project-browser.mjs');
      evidence.projectBrowser = await reviewQaProjectBrowser({ fixture, appCdp: cdp, debugPort, check, sanitize, checkAlive });
      await cdp.send('Page.bringToFront');
    }
    await screenshot('completed');
    evidence.diagnostics = await api('/api/diagnostics/status');
    if (evidence.diagnostics.gapRecords > 0 || evidence.diagnostics.lastError) throw new Error('Diagnostic evidence has a gap or write error');
    if (cell.transport === 'live') {
      const observation = await readProviderObservation();
      if (!observation.some(row => row.kind === 'chat.params' && row.sessionID === sessionID)
        || owned.some(child => child.getLog().includes('DEVRYAN_QA_OBSERVER_GAP'))) throw new Error('Effective provider-option evidence is incomplete');
      evidence.reasoningControls = gradeQaReasoningControls({ observations: observation,
        userMessageIDs: [...(evidence.turns ?? []).map(turn => turn.userMessageID), evidence.cancellation?.userMessageID,
          ...(evidence.compaction?.submittedUserMessageIDs ?? []),
          ...(evidence.retrievalDiagnostic?.submittedUserMessageIDs ?? [])].filter(Boolean),
        sessionID, providerID: cell.providerId, modelID: cell.modelId, variant: cell.variant, advertisedVariant });
      if (!evidence.reasoningControls.passed) throw new Error('Observed native reasoning controls differ from the selected intent');
    }
    evidence.sourceDrift = (await captureQaSourceIdentity(root)).sha256 !== sourceIdentity.sha256;
    if (evidence.sourceDrift) throw new Error('Candidate production source changed during the QA cell');
    evidence.runnerDrift = (await captureQaArtifactIdentity(path.join(root, 'scripts'))).sha256 !== runnerIdentity.sha256;
    if (evidence.runnerDrift) throw new Error('QA runner source changed during the QA cell');
    if ((await captureQaArtifactIdentity(artifactDirectory)).sha256 !== artifactIdentity.sha256) throw new Error('Served artifact changed during the QA cell');
    if (packaged) await loadQaPackagedArtifact({ root, evidencePath: packaged.evidencePath });
    const expectedMarkers = (evidence.fixtureScenario?.expectedFailures ?? []).map(failure => failure.message).filter(Boolean);
    evidence.unexpectedConsoleErrors = evidence.consoleErrors.filter(error => !expectedMarkers.some(marker => error.includes(marker)));
    if (evidence.unexpectedConsoleErrors.length) throw new Error('Unexpected renderer errors captured');
    evidence.outcome = 'passed';
  } catch (error) {
    evidence.error = sanitize(error.message);
    if (cdp) {
      await screenshot('failure').catch(() => {});
      evidence.controlsAtFailure = await ui?.inspectControls().catch(() => []);
      evidence.diagnostics = await api('/api/diagnostics/status').catch(() => ({ unavailable: true }));
    }
  } finally {
    if (sessionID && cdp) {
      try {
        const { cleanupQaSessionTree } = await import('./live-task-evidence.mjs');
        evidence.sessionCleanup = await cleanupQaSessionTree({ api, rootSessionID: sessionID, directory: fixture.fixtureRoot,
          knownSessionIds: evidence.taskExecution?.sessionIDs ?? [] });
        if (!evidence.sessionCleanup.complete) evidence.cleanupErrors.push('Canonical session tree cleanup was incomplete');
      } catch (error) { evidence.cleanupErrors.push(sanitize(error.message)); }
    }
    const holdMs = Number(process.env.DEVRYAN_QA_HOLD_MS || 0);
    if (Number.isSafeInteger(holdMs) && holdMs > 0 && holdMs <= 300000 && cdp) {
      console.log(JSON.stringify({ run: cell.runId, inspectionHoldMs: holdMs, output: fixture.evidenceDirectory }));
      const until = Date.now() + holdMs;
      while (!interrupted && Date.now() < until) await delay(100);
    }
    cdp?.close();
    for (const child of owned.toReversed()) { try { await child.stop(); } catch (error) { evidence.cleanupErrors.push(sanitize(error.message)); } }
    try { await profile?.close?.(); } catch (error) { evidence.cleanupErrors.push(sanitize(error.message)); }
    // The wrapper can exit while its separately detached native runtime lives
    // on. Audit retained OS identities before archiving/removing its profile.
    for (const child of owned) {
      try { await child.auditStopped(); } catch (error) { evidence.cleanupErrors.push(sanitize(error.message)); }
    }
    evidence.ownedProcessCleanup = owned.map(child => child.getCleanupEvidence());
    await writeFile(path.join(fixture.evidenceDirectory, 'process-logs.json'), JSON.stringify(owned.map(child => sanitize(child.getLog())), null, 2));
    if (profile) {
      try { await rename(path.join(profile.env.OPENCHAMBER_DATA_DIR, 'harness/journal'), path.join(fixture.evidenceDirectory, 'journal')); } catch (error) { if (error.code !== 'ENOENT') evidence.cleanupErrors.push(sanitize(error.message)); }
      try {
        const observation = await readFile(path.join(runtimeRoot, 'provider-evidence.ndjson'), 'utf8');
        await writeFile(path.join(fixture.evidenceDirectory, 'provider-evidence.ndjson'), observation, { mode: 0o600 });
        evidence.providerObservation = 'captured';
      } catch (error) {
        evidence.providerObservation = error.code === 'ENOENT' ? 'unavailable' : 'read-failed';
      }
      const logDirectory = path.join(profile.env.XDG_DATA_HOME, 'opencode/log');
      evidence.nativeLogs = [];
      try {
        const entries = await readdir(logDirectory, { withFileTypes: true });
        let totalBytes = 0;
        for (const entry of entries.filter(entry => entry.isFile() && entry.name.endsWith('.log')).sort((a,b)=>a.name.localeCompare(b.name))) {
          const file = path.join(logDirectory, entry.name);
          const size = (await stat(file)).size;
          if (size > 4 * 1024 * 1024 || totalBytes + size > 16 * 1024 * 1024) {
            evidence.nativeLogs.push({ file: entry.name, state: 'unavailable-size-limit', bytes: size }); continue;
          }
          totalBytes += size;
          const destination = `native-${entry.name}`;
          await writeFile(path.join(fixture.evidenceDirectory, destination), sanitize(await readFile(file, 'utf8')), { mode: 0o600 });
          evidence.nativeLogs.push({ file: destination, state: 'captured', bytes: size });
        }
      } catch (error) { evidence.nativeLogs.push({ state: error.code === 'ENOENT' ? 'unavailable' : 'read-failed' }); }
      try {
        const ledger = JSON.parse(await readFile(path.join(profile.env.OPENCHAMBER_DATA_DIR, 'orchestration/ledger.json'), 'utf8'));
        await writeFile(path.join(fixture.evidenceDirectory, 'managed-ledger.json'), JSON.stringify(sanitizer.sanitizeExportValue(ledger), null, 2), { mode: 0o600 });
        evidence.managedLedger = 'captured';
      } catch (error) { evidence.managedLedger = error.code === 'ENOENT' ? 'unavailable' : 'read-failed'; }
    }
    if (!evidence.cleanupErrors.length) {
      try { await rm(runtimeRoot, { recursive: true, force: true }); } catch (error) { evidence.cleanupErrors.push(sanitize(error.message)); }
    }
    try {
      const diff = execFileSync('git', ['diff', '--binary'], { cwd: fixture.fixtureRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      await writeFile(path.join(fixture.evidenceDirectory, 'project.diff'), sanitize(diff));
      evidence.projectArchive = await preserveQaProject({ fixture, sanitize });
    } catch (error) { evidence.cleanupErrors.push(sanitize(error.message)); }
    if (evidence.outcome === 'passed' && !evidence.cleanupErrors.length) removeQaProjectFixture(fixture);
    if (evidence.cleanupErrors.length) evidence.outcome = 'failed';
    evidence.finishedAt = new Date().toISOString();
    await writeFile(path.join(fixture.evidenceDirectory, 'integrity.json'), JSON.stringify({ revision: evidence.revision,
      seedManifestSha256: fixture.seedManifestSha256, artifactManifestSha256: evidence.artifactManifestSha256 ?? null,
      sourceSha256: sourceIdentity?.sha256 ?? null, artifactSha256: artifactIdentity?.sha256 ?? null,
      runnerSha256: runnerIdentity?.sha256 ?? null,
      packageArchiveSha256: packaged?.evidence.archiveSha256 ?? null,
      plans: evidence.plans?.map(plan => ({ sourceMessageID: plan.sourceMessageID, sha256: plan.sha256 })) ?? [],
    }, null, 2));
    await writeFile(path.join(fixture.evidenceDirectory, 'result.json'), JSON.stringify(sanitizeQaResult(evidence, sanitizer, capturedScreenshots), null, 2));
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  console.log(JSON.stringify({ run: cell.runId, outcome: evidence.outcome, error: evidence.error, output: fixture.evidenceDirectory }));
  return { runId: cell.runId, outcome: evidence.outcome, visualReview: evidence.visualReview, interrupted, error: evidence.error, output: fixture.evidenceDirectory };
}

export async function runQaMatrix(configPath) {
  const config = loadQaMatrixConfig(configPath);
  const runs = expandQaMatrix(config);
  await mkdir(config.evidenceRoot, { recursive: true });
  const summary = { schemaVersion: 1, planned: runs.length, completed: 0, outcome: 'running', runs: [] };
  for (const cell of runs) {
    summary.runs.push(await runQaMatrixCell(cell)); summary.completed += 1;
    await writeFile(path.join(config.evidenceRoot, 'summary.json'), JSON.stringify(summary, null, 2));
    if (summary.runs.at(-1).interrupted) break;
  }
  summary.outcome = summary.completed === summary.planned && summary.runs.every(run => run.outcome === 'passed') ? 'passed' : 'failed';
  summary.visualReview = 'pending';
  await writeFile(path.join(config.evidenceRoot, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}
