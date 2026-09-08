// Explicit live opt-in. Uses an already prepared private runtime; tokens stay
// in memory. Every turn requires authoritative quota and a reserved margin.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { applyMeridianHttpHotfix } from '../../packages/web/server/lib/opencode/meridian-http-hotfix.js';
import { MERIDIAN_PREFIX_EDITS } from '../../packages/web/server/lib/opencode/meridian-passthrough-hotfix.js';
import { pinQaAgents } from './profile-preparation.mjs';
import { requireCacheDirectory, seedEditingFixture, editingPrompts, verifyEditingFixture, studyModel, studyEffort } from './claude-quota-fixture.mjs';
import { startClaudeQuotaRuntime } from './claude-quota-runtime.mjs';
import { startInteractiveClaude, nativeTranscriptFiles } from './claude-quota-interactive.mjs';
import { projectQuota, compareQuota, checkQuotaAdmission, readNativeAssistants, summarizeNativeAssistants } from './claude-quota-evidence.mjs';
import { gradeQaReasoningControls } from './reasoning-controls-evidence.mjs';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { checkClaudeCancellation } from './claude-quota-cancellation.mjs';
import { seedSustainedFixture, sustainedPrompts, sustainedFileHashes, verifySustainedFixture } from './claude-quota-sustained.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const recentQuotas = new Map();

export async function runClaudeQuotaWorkload({ preparedFile, installedModules, claudeExecutable, arm,
  baselineFile, quotaOrigin, outputRoot, referenceSession, cancellationCheck = false, workload = 'small', calibrationTurns }) {
  if (!['direct', 'control', 'candidate'].includes(arm)) throw new Error('Expected direct, control or candidate');
  if (!['small', 'sustained'].includes(workload) || (cancellationCheck && workload !== 'small')) throw new Error('Invalid workload selection');
  if (calibrationTurns !== undefined && (workload !== 'sustained' || !Number.isInteger(calibrationTurns)
    || calibrationTurns < 1 || calibrationTurns >= sustainedPrompts.length)) throw new Error('Invalid sustained calibration length');
  const fullPrompts = workload === 'sustained' ? sustainedPrompts : editingPrompts;
  const prompts = calibrationTurns === undefined ? fullPrompts : fullPrompts.slice(0, calibrationTurns);
  if (referenceSession && (!path.isAbsolute(referenceSession) || !referenceSession.endsWith('.jsonl'))) throw new Error('Reference session must be an explicitly authorized absolute JSONL path');
  const quotaUrl = new URL(quotaOrigin);
  if (quotaUrl.protocol !== 'http:' || quotaUrl.hostname !== '127.0.0.1' || quotaUrl.username || quotaUrl.password
    || quotaUrl.pathname !== '/' || quotaUrl.search || quotaUrl.hash) throw new Error('Quota origin must be explicit loopback HTTP');
  const parent = await requireCacheDirectory(outputRoot);
  const output = await fs.mkdtemp(path.join(parent, `${arm}-`));
  const { fixture: preparedFixture, profile } = JSON.parse(await fs.readFile(preparedFile, 'utf8'));
  const sanitizer = createDiagnosticSanitizer({ homeDir: profile.qaHome, worktreeRoots: [preparedFixture.workspace] });
  await requireCacheDirectory(preparedFixture.root);
  await requireCacheDirectory(profile.runtimeRoot);
  for (const directory of [profile.qaHome, profile.config, profile.claude]) {
    if (!path.resolve(directory).startsWith(`${path.resolve(profile.runtimeRoot)}${path.sep}`)) throw new Error('Prepared profile paths must remain inside their owned runtime');
    await requireCacheDirectory(directory);
  }
  if (profile.env.DEVRYAN_QA_HOME !== profile.qaHome || profile.env.CLAUDE_CONFIG_DIR !== profile.claude) throw new Error('Prepared profile environment does not match its owned paths');
  const fixture = { ...preparedFixture, root: output, workspace: path.join(output, 'workspace') };
  await requireCacheDirectory(fixture.workspace);
  const baseline = JSON.parse(await fs.readFile(baselineFile, 'utf8'));
  await requireCacheDirectory(path.dirname(path.resolve(baselineFile)));
  const controller = new AbortController();
  const onInterrupt = () => controller.abort(new Error('Quota study interrupted'));
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);
  const result = { arm, output, startedAt: Date.now(), model: studyModel, effort: studyEffort,
    kind: cancellationCheck ? 'cancellation-resume' : calibrationTurns === undefined ? 'paired-edit-workload' : 'editing-calibration', workload,
    requiredTurns: prompts.length, fullWorkloadTurns: fullPrompts.length,
    promptSha256: createHash('sha256').update(JSON.stringify(prompts)).digest('hex'),
    quotaBoundary: 'oauth-after-completed-work-and-reporting-delay',
    beforeTurnQuotaBoundary: 'after-previous-work-plus-reporting-delay; no-intervening-inference',
    quotaObservationReuseMs: 85_000,
    quotaResolutionPoints: 1, turns: [], passed: false, providerAttemptCount: null };
  const referenceRead = referenceSession ? await readNativeAssistants([referenceSession]) : null;
  const referenceBefore = referenceRead ? summarizeNativeAssistants(referenceRead.rows) : null;
  const referenceIds = referenceBefore?.requests.map(row => row.messageId) ?? [];
  let runtime;
  let interactive;
  let api;
  let sessionID;
  let sendWebPrompt;
  let waitWebTurn;
  const quota = async () => {
    const cached = recentQuotas.get(quotaUrl.origin);
    // Avoid bursts of OAuth usage refreshes at turn/arm boundaries. A reused
    // observation retains the provider's actual fetchedAt and freshness bound.
    if (cached && Date.now() - cached.at < result.quotaObservationReuseMs && Date.now() - cached.value.fetchedAt < 90_000) return cached.value;
    const value = projectQuota(await (await fetch(new URL('/v1/usage/quota', quotaUrl), {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
    })).json());
    recentQuotas.set(quotaUrl.origin, { at: Date.now(), value });
    return value;
  };
  const freshQuotaWhileIdle = async ({ after = 0 } = {}) => {
    for (let attempt = 0; ; attempt++) {
      controller.signal.throwIfAborted();
      try {
        const current = await quota();
        if (current.fetchedAt <= after) throw new Error('Quota observation predates the required measurement boundary');
        return current;
      }
      catch (error) {
        if (attempt >= 30 || !/Authoritative Claude quota is missing or stale|Claude quota has no primary windows|Quota observation predates/.test(error.message)) throw error;
        if (attempt === 0) console.log(JSON.stringify({ arm, state: 'awaiting-fresh-quota-model-idle' }));
        await delay(20_000);
      }
    }
  };
  const guard = async ({ idle = false, after = 0, minimumWindowRemainingMs = 0 } = {}) => {
    controller.signal.throwIfAborted();
    const current = await (idle ? freshQuotaWhileIdle({ after }) : quota());
    if (baseline.baseline.windows.five_hour.inactive === true && baseline.activatedFiveHourReset === undefined
      && current.windows.five_hour.inactive !== true) {
      const reset = current.windows.five_hour.resetsAt;
      if (!Number.isFinite(reset) || reset <= current.fetchedAt) throw new Error('The new quota window has no valid activation boundary');
      // A fresh zero/null observation means no window is open yet. Bind the
      // first real reset boundary once it appears, while preserving that raw
      // zero baseline; subsequent resets must never silently renew the budget.
      baseline.activatedFiveHourReset = reset;
      baseline.activationEvidence = current;
      const temporary = `${path.resolve(baselineFile)}.activation-${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(baseline, null, 2), { mode: 0o600 });
      await fs.rename(temporary, path.resolve(baselineFile));
      console.log(JSON.stringify({ state: 'quota-window-activated', reset, carriedConsumedPoints: baseline.carriedConsumedPoints ?? 0 }));
    }
    const admission = checkQuotaAdmission(baseline.baseline, current, {
      limitPoints: baseline.limitPoints, reservePoints: arm === 'candidate' ? baseline.finalHeadroomPoints : baseline.diagnosticReservePoints,
      carriedConsumedPoints: baseline.carriedConsumedPoints ?? 0,
      activatedFiveHourReset: baseline.activatedFiveHourReset,
      minimumWindowRemainingMs,
    });
    if (!admission.allowed) throw new Error(`Quota admission suspended: ${admission.reason}`);
    if (referenceSession) {
      const reference = await readNativeAssistants([referenceSession]);
      if (reference.gaps.length) throw new Error('Reference activity evidence is incomplete');
      const added = summarizeNativeAssistants(reference.rows, { excludeIds: referenceIds });
      if (added.observedResponseCount) throw new Error('Reference Claude activity contaminated the measurement window');
    }
    return current;
  };
  try {
    if (referenceRead?.gaps.length) throw new Error('Reference activity baseline is incomplete');
    result.before = await guard({ idle: true, after: result.startedAt,
      minimumWindowRemainingMs: workload === 'sustained' && calibrationTurns === undefined ? 60 * 60_000 : 0 });
    const { createPlatformCredentialStore } = await import(pathToFileURL(path.join(installedModules, '@rynfar/meridian/dist/cli-khhjyk04.js')).href);
    const credentials = await createPlatformCredentialStore().read();
    const access = credentials?.claudeAiOauth;
    const requiredAccessMinutes = workload === 'sustained' && calibrationTurns === undefined ? 60 : 20;
    if (!access?.accessToken || !Number.isFinite(access.expiresAt) || access.expiresAt < Date.now() + requiredAccessMinutes * 60_000) {
      throw new Error('Existing Claude access is unavailable or does not cover the workload deadline');
    }
    result.accessExpiresAt = access.expiresAt;
    result.claudeVersion = execFileSync(claudeExecutable, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
    // Only authored fixture files are reset. The isolated runtime and evidence
    // remain available for audit; installed user state is never modified.
    await fs.rm(path.join(fixture.workspace, 'ReviewStats.test.mjs'), { force: true });
    if (workload === 'sustained') await seedSustainedFixture(fixture.workspace);
    else await seedEditingFixture(fixture.workspace);
    if (arm === 'direct') {
      interactive = await startInteractiveClaude({ fixture, claudeExecutable, oauthToken: access.accessToken, signal: controller.signal });
      result.titleMode = 'explicit-benchmark-title';
    } else {
      profile.env.MERIDIAN_WORKDIR = fixture.workspace;
      const settingsPath = path.join(profile.env.OPENCHAMBER_DATA_DIR, 'settings.json');
      const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
      await fs.writeFile(settingsPath, JSON.stringify({ ...settings, lastDirectory: fixture.workspace,
        projects: [{ id: 'quota', path: fixture.workspace, label: 'Quota fixture' }], activeProjectId: 'quota' }));
      const patch = applyMeridianHttpHotfix({ configDirectory: profile.config });
      if (!patch.ok) throw new Error('Private runtime patch was rejected');
      const entry = path.join(profile.config, 'node_modules/@rynfar/meridian/dist/cli-wxk8xvd3.js');
      if (arm === 'control') {
        let source = await fs.readFile(entry, 'utf8');
        for (const [before, after] of MERIDIAN_PREFIX_EDITS) source = source.replace(after, before);
        await fs.writeFile(entry, source);
      }
      result.meridianSourceSha256 = createHash('sha256').update(await fs.readFile(entry)).digest('hex');
      const slimPath = path.join(profile.config, 'oh-my-opencode-slim.json');
      await fs.writeFile(slimPath, JSON.stringify(pinQaAgents(JSON.parse(await fs.readFile(slimPath, 'utf8')), {
        providerId: 'anthropic', modelId: studyModel, variant: studyEffort,
      }), null, 2));
      // Native Markdown agent defaults are a later configuration layer than
      // the base JSON file. Preserve the bundled instructions while pinning
      // the selected specialist's model/effort in this owned profile too.
      const designerFile = path.join(profile.config, 'agents/designer.md');
      const designerSource = await fs.readFile(designerFile, 'utf8');
      if (!/^model: .+$/m.test(designerSource) || !/^variant: .+$/m.test(designerSource)) throw new Error('Owned Designer frontmatter is incompatible');
      await fs.writeFile(designerFile, designerSource.replace(/^model: .+$/m, `model: anthropic/${studyModel}`).replace(/^variant: .+$/m, `variant: ${studyEffort}`));
      await fs.writeFile(path.join(profile.qaHome, '.devryan-qa-home'), 'owned QA home\n');
      profile.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ plugin: [pathToFileURL(path.resolve(import.meta.dirname, 'provider-observer.mjs')).href] });
      runtime = await startClaudeQuotaRuntime(profile, { oauthToken: access.accessToken, signal: controller.signal });
      let cookie = '';
      api = async (route, body, { method = body === undefined ? 'GET' : 'POST' } = {}) => {
        const url = new URL(route, runtime.origin);
        url.searchParams.set('directory', fixture.workspace);
        let response;
        try {
          response = await fetch(url, { method,
            headers: { cookie, 'content-type': 'application/json', 'X-DevRyan-CSRF': '1' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000) });
        } catch { throw new Error(`Owned DevRyan request failed or timed out: ${route}`); }
        if (!response.ok) throw new Error(`Owned DevRyan request failed: ${route} HTTP ${response.status}`);
        return response.status === 204 ? null : response.json();
      };
      // Fresh local profiles have no account control plane. If authentication
      // is enabled, use only its existing password-free fixture endpoint.
      let agents;
      try { agents = await api('/api/agent'); }
      catch (error) {
        if (!error.message.endsWith('HTTP 401')) throw error;
        const login = await fetch(new URL('/auth/agent-test-session', runtime.origin), { method: 'POST',
          headers: { 'content-type': 'application/json', 'X-DevRyan-CSRF': '1' }, body: JSON.stringify({ role: 'admin' }) });
        if (!login.ok) throw new Error(`Owned password-free login failed: HTTP ${login.status}`);
        cookie = login.headers.getSetCookie().map(header => header.split(';')[0]).join('; ');
        agents = await api('/api/agent');
      }
      const designer = agents.find(agent => agent.name === 'designer');
      if (designer?.mode !== 'subagent' || designer.model?.modelID !== studyModel) throw new Error('Owned Designer configuration does not match the study');
      result.agent = { name: designer.name, mode: designer.mode, model: designer.model, variant: designer.variant };
      const providers = await api('/api/provider');
      result.advertisedVariant = providers.all.find(provider => provider.id === 'anthropic')?.models?.[studyModel]?.variants?.[studyEffort];
      if (!result.advertisedVariant) throw new Error('Exact Opus/medium variant is unavailable in the owned runtime');
      const session = await api('/api/session', { title: 'DevRyan Claude quota fixture', permission: [{ permission: '*', pattern: '*', action: 'allow' }] });
      sessionID = session.id;
      result.sessionID = sessionID;
      await api(`/api/session/${sessionID}`, { title: 'Claude quota fixture' }, { method: 'PATCH' });
      if ((await api(`/api/session/${sessionID}`)).title !== 'Claude quota fixture') throw new Error('Owned benchmark title did not persist');
      result.titleMode = 'explicit-benchmark-title';
      sendWebPrompt = async text => {
        const oldIds = new Set((await api(`/api/session/${sessionID}/message`)).map(row => row.info.id));
        await api(`/api/session/${sessionID}/prompt_async`, {
          model: { providerID: 'anthropic', modelID: studyModel }, variant: studyEffort, agent: 'designer',
          parts: [{ type: 'text', text }],
        });
        return oldIds;
      };
      waitWebTurn = async oldIds => {
        const deadline = Date.now() + 10 * 60_000;
        let lastGuard = Date.now();
        for (;;) {
          controller.signal.throwIfAborted();
          if (Date.now() > deadline) throw new Error('Owned Designer workload timed out');
          const rows = await api(`/api/session/${sessionID}/message`);
          const fresh = rows.filter(row => !oldIds.has(row.info.id) && row.info.role === 'assistant');
          if (fresh.some(row => row.info.error)) throw new Error(`Owned Designer provider failed: ${fresh.find(row => row.info.error).info.error.name}`);
          const statuses = await api('/api/session/status');
          if (fresh.length && fresh.every(row => row.info.time?.completed) && (!statuses[sessionID] || statuses[sessionID].type === 'idle')) return;
          if (Date.now() - lastGuard > 30_000) { await guard(); lastGuard = Date.now(); }
          await delay(500);
        }
      };
    }
    console.log(JSON.stringify({ arm, output, state: 'ready', quota: result.before.windows.five_hour.usedPercent }));
    for (const [turn, prompt] of prompts.entries()) {
      // The preceding turn's delayed endpoint is already an immediately
      // preceding observation for this prompt. Reuse it while fresh instead
      // of requesting another OAuth refresh solely because a few milliseconds
      // passed while writing evidence. No inference occurs between these points.
      const priorWork = result.turns.at(-1)?.workCompletedAt;
      const before = await guard({ idle: true, after: priorWork === undefined ? result.startedAt : priorWork + 30_000 });
      const beforeHashes = workload === 'sustained' ? await sustainedFileHashes(fixture.workspace) : null;
      const startedAt = Date.now();
      if (interactive) await interactive.prompt(prompt, { onPoll: guard });
      else await waitWebTurn(await sendWebPrompt(prompt));
      const verification = workload === 'sustained'
        ? await verifySustainedFixture(fixture.workspace, { turn, beforeHashes })
        : await verifyEditingFixture(fixture.workspace, { turn });
      const workCompletedAt = Date.now();
      // Quota reporting has latency and integer resolution. Retain both fresh
      // observations instead of inferring cost from native token estimates.
      const immediate = await freshQuotaWhileIdle();
      await delay(30_000);
      const after = await guard({ idle: true, after: workCompletedAt + 30_000 });
      const evidence = { turn, startedAt, workCompletedAt, completedAt: Date.now(), before, immediate, after,
        quota: compareQuota(before, after, { completedAt: workCompletedAt, reportingDelayMs: 30_000 }), verification };
      result.turns.push(evidence);
      await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify({ arm, turn, verified: verification.passed, quota: after.windows.five_hour.usedPercent }));
      if (!verification.passed) throw new Error('Independent fixture verification failed');
    }
    if (cancellationCheck) {
      console.log(JSON.stringify({ arm, state: 'cancellation-check' }));
      result.cancellation = await checkClaudeCancellation({ interactive, api, sessionID, fixture,
        claudeDirectory: interactive?.claudeDirectory ?? profile.claude, guard, idleGuard: options => guard({ ...options, idle: true }), signal: controller.signal,
        sendWebPrompt, waitWebTurn });
    }
    result.after = result.cancellation?.after ?? result.turns.at(-1).after;
    result.quota = compareQuota(result.before, result.after, {
      completedAt: result.cancellation?.resumedWorkCompletedAt ?? result.turns.at(-1).workCompletedAt,
      reportingDelayMs: result.cancellation ? 0 : 30_000,
    });
    const native = await readNativeAssistants(await nativeTranscriptFiles(interactive?.claudeDirectory ?? profile.claude));
    result.native = summarizeNativeAssistants(native.rows, { since: result.startedAt });
    result.turns = result.turns.map(turn => ({ ...turn,
      native: summarizeNativeAssistants(native.rows, { since: turn.startedAt, until: turn.completedAt }),
    }));
    result.nativeGaps = native.gaps;
    if (runtime) {
      const currentSource = createHash('sha256').update(await fs.readFile(path.join(profile.config, 'node_modules/@rynfar/meridian/dist/cli-wxk8xvd3.js'))).digest('hex');
      if (currentSource !== result.meridianSourceSha256) throw new Error('Owned Meridian source changed during the workload');
      const telemetry = await (await fetch(`${runtime.meridianOrigin}/telemetry/requests?limit=1000`)).json();
      // This is one owned runtime and one admitted workload. Meridian's public
      // request projection has SDK IDs, but no OpenCode session-ID field.
      result.meridian = telemetry.filter(row => row.timestamp >= result.startedAt)
        .map(({ requestId, timestamp, sdkSessionId, model, requestModel, isResume, lineageType, status,
          totalDurationMs, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens }) => ({
          requestId, timestamp, sdkSessionId, model, requestModel, isResume, lineageType, status,
          totalDurationMs, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
        }));
      const rows = await api(`/api/session/${sessionID}/message`);
      const observations = (await fs.readFile(path.join(profile.runtimeRoot, 'provider-evidence.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      result.reasoningControls = gradeQaReasoningControls({ observations, sessionID,
        userMessageIDs: rows.filter(row => row.info.role === 'user').map(row => row.info.id),
        providerID: 'anthropic', modelID: studyModel, variant: studyEffort, advertisedVariant: result.advertisedVariant });
      result.opencode = rows.filter(row => row.info.role === 'assistant').map(row => ({
        id: row.info.id, modelID: row.info.modelID, providerID: row.info.providerID, tokens: row.info.tokens,
        tools: row.parts.filter(part => part.type === 'tool').map(part => ({ callID: part.callID, tool: part.tool, status: part.state?.status })),
      }));
    }
    result.passed = result.turns.length === prompts.length && result.turns.every(turn => turn.quota.valid && turn.verification.passed)
      && result.quota.valid && !result.nativeGaps.length
      && result.native.observedResponseCount > 0 && Object.keys(result.native.models).every(model => model === studyModel)
      && (!runtime || result.reasoningControls.passed);
    if (cancellationCheck && !result.cancellation?.passed) result.passed = false;
  } catch (error) {
    result.error = sanitizer.sanitizeText(error instanceof Error ? error.message : 'Quota workload failed');
    if (runtime) result.runtimeDiagnostics = runtime.logs().map(log => sanitizer.sanitizeText(log));
  } finally {
    if (sessionID && api) { try { await api(`/api/session/${sessionID}/abort`, {}); } catch { result.cleanupError = 'Owned session abort failed'; } }
    try { if (interactive) result.nativeCleanup = await interactive.close(); } catch { result.cleanupError = 'Owned interactive cleanup failed'; }
    try { if (runtime) result.runtimeCleanup = await runtime.close(); } catch { result.cleanupError = 'Owned runtime cleanup failed'; }
    if (!result.after) {
      try { result.after = await quota(); if (result.before) result.quota = compareQuota(result.before, result.after); }
      catch { result.quotaUnavailable = true; }
    }
    if (!result.native) {
      const native = await readNativeAssistants(await nativeTranscriptFiles(interactive?.claudeDirectory ?? profile.claude));
      result.native = summarizeNativeAssistants(native.rows, { since: result.startedAt });
      result.nativeGaps = native.gaps;
    }
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
    result.finishedAt = Date.now();
    if (result.cleanupError) result.passed = false;
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify({ arm, output, passed: result.passed, error: result.error, quota: result.quota }));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const result = await runClaudeQuotaWorkload(options);
  if (!result.passed) process.exitCode = 1;
}
