import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ownedQaDirectory, cacheStudyStorage, readCacheAttempts } from './cache-study.mjs';
import { qualifiedEfficiencyRoute } from '../../packages/shared-runtime/lib/cache-efficiency-policy.js';
import { titleScreenCases, gradeTitleScreen, TITLE_SCREEN_RUBRIC } from './cache-efficiency-experiments.mjs';
import { writeFileAtomic, withCrossProcessFileLock } from '../../packages/harness-runtime/lib/atomic-file.js';

const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const hash = value => createHash('sha256').update(value).digest('hex');
const readWire = async root => {
  const file = path.join(root, 'cache-wire.ndjson');
  try {
    if ((await fs.stat(file)).size > 9 * 1024 * 1024) throw new Error('Wire evidence limit');
    return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
// Completion can lag send(), but no new arm starts while observed attempts are
// unsettled. A qualified host must also await all workflow helpers before return.
async function reconcile({ root, study, route, phase, runID, armID, before, wireOffset, expectedEffort, wait }) {
  for (let elapsed = 0; elapsed <= 10_000; elapsed += 100) {
    const allAttempts = await readCacheAttempts(root), allRows = await readWire(root);
    const attempts = allAttempts.slice(before), rows = allRows.slice(wireOffset);
    if (rows.some(row => row.type === 'gap' || row.gap) || attempts.some(attempt => attempt.studyID !== study.id
      || attempt.routeID !== route.id || attempt.phase !== phase)) return null;
    const dispatches = rows.filter(row => row.type === 'dispatch');
    const terminals = rows.filter(row => row.type === 'response');
    if (dispatches.some(row => row.runID !== runID || row.armID !== armID)) return null;
    if (attempts.length && attempts.every(attempt => dispatches.filter(row => row.reservation?.attemptID === attempt.attemptID).length === 1
      && terminals.filter(row => row.usageObservation?.attemptID === attempt.attemptID).length === 1)) {
      if (dispatches.length !== attempts.length || terminals.length !== attempts.length) return null;
      const expectedModel = route.qualification.responseModel ?? route.model;
      if (terminals.some(row => (row.usageObservation.status === 'complete' || row.usageObservation.responseModel !== null)
        && row.usageObservation.responseModel !== expectedModel)
        || expectedEffort && dispatches.some(row => row.signature?.reasoningEffort !== expectedEffort)) return null;
      return { attempts: attempts.length, requestErrors: terminals.filter(row => row.usageObservation.status !== 'complete').length,
        attributableRequestErrors: terminals.filter(row => row.usageObservation.status === 'failed'
          && [400, 422].includes(row.statusCode) && row.effortError === true).length,
        nextAttempt: allAttempts.length, nextWire: allRows.length };
    }
    if (elapsed < 10_000) await wait(100);
  }
  return null;
}

// Host integration remains a prerequisite: send must use the existing workflow
// through the qualified observer and await helpers. Grade receives opaque IDs,
// source and output only; it cannot see arm, effort, usage or latency metadata.
export async function runCachePairs({ runtimeRoot, home, routeID, runtimeVersion, phase = 'aa', send, grade, now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const root = await ownedQaDirectory(runtimeRoot, home);
  if (!root) throw new Error('Owned cache study required');
  if (!['aa', 'title'].includes(phase) || typeof send !== 'function') throw new Error('Invalid paired cache run');
  const { study, ledgerRoot } = await cacheStudyStorage(root);
  const route = study.routes.find(candidate => candidate.id === routeID);
  // runtimeVersion must be supplied from the running host, not copied here from
  // the study manifest. Operator transport evidence remains a prerequisite.
  const selection = { provider: route?.provider, model: route?.model, runtimeVersion };
  const candidateEffort = efforts.find(effort => route?.qualification?.verifiedTitleEfforts?.includes(effort));
  if (!qualifiedEfficiencyRoute(route, selection) || route.qualification.redirectsBlocked !== true
    || phase === 'title' && (route.provider !== 'xai' || route.experiments?.titleEffort !== true || !candidateEffort || candidateEffort === route.qualification.baselineEffort
      || !efforts.includes(route.qualification.baselineEffort) || typeof grade !== 'function')) return { status: 'observability_only', pairs: [] };
  return withCrossProcessFileLock(path.join(ledgerRoot, 'cache-pairs.lock'), async () => {
    const marker = path.join(ledgerRoot, 'cache-pairs-' + routeID + '-' + phase + '.json');
    const handle = await fs.open(marker, 'wx', 0o600);
    await handle.close();
    const runID = randomUUID(), seed = randomUUID();
    const cases = phase === 'title' ? titleScreenCases(seed).map(item => ({ ...item, text: item.text.replaceAll(seed, randomUUID()) }))
      : Array.from({ length: 6 }, (_, i) => {
        const code = 'KEY_' + randomUUID();
        return { id: 'aa-' + i, text: Array.from({ length: 192 }, (_, n) => 'Item ' + n + ': category ' + code + '; weight ' + n % 7 + '.').join('\n') + '\nReturn only the category of item 42.' };
      });
    const result = { version: 1, runID, routeID, phase, status: 'incomplete',
      rubricHash: phase === 'title' ? hash(JSON.stringify(TITLE_SCREEN_RUBRIC)) : null,
      armOrder: cases.map((item, index) => ({ id: item.id, order: phase === 'title' && index % 2 ? ['candidate', 'control'] : ['control', 'candidate'] })), pairs: [] };
    await writeFileAtomic(marker, JSON.stringify(result));
    const samples = [], grades = new Map();
    let before = (await readCacheAttempts(root)).length, wireOffset = (await readWire(root)).length;
    try {
      for (const [caseIndex, item] of cases.entries()) {
        const pair = { id: item.id, sourceHash: hash(item.text), requestedGapMs: 2000 };
        result.pairs.push(pair);
        for (const [index, arm] of result.armOrder[caseIndex].order.entries()) {
          if (index) {
            const remaining = 2000 - (now() - pair.completedAt);
            if (remaining > 0) await wait(remaining);
            pair.actualGapMs = now() - pair.completedAt;
          }
          const armID = randomUUID();
          const context = { runID, armID, routeID, phase, order: index ? 'warm' : 'first',
            titleEffortEnabled: phase === 'title' && arm === 'candidate', runtimeVersion };
          await writeFileAtomic(path.join(root, 'cache-context.json'), JSON.stringify(context));
          const verdict = await send({ route, text: item.text, arm, experiment: context.titleEffortEnabled, context });
          const evidence = await reconcile({ root, study, route, phase, runID, armID, before, wireOffset, wait,
            expectedEffort: phase === 'title' ? arm === 'candidate' ? candidateEffort : route.qualification.baselineEffort : null });
          if (!evidence) { result.reason = 'wire_evidence_incomplete'; break; }
          before = evidence.nextAttempt; wireOffset = evidence.nextWire;
          pair[arm] = { order: context.order, valid: typeof verdict?.valid === 'boolean' ? verdict.valid : null,
            qualityAccepted: phase === 'aa' && typeof verdict?.qualityAccepted === 'boolean' ? verdict.qualityAccepted : null,
            attempts: evidence.attempts, requestErrors: evidence.requestErrors, attributableRequestErrors: evidence.attributableRequestErrors,
            repairs: Number.isSafeInteger(verdict?.repairs) && verdict.repairs >= 0 ? verdict.repairs : null };
          if (phase === 'title' && typeof verdict?.output === 'string') {
            const id = randomUUID(); samples.push({ id, source: item.text, output: verdict.output }); grades.set(id, pair[arm]);
          }
          if (!index) pair.completedAt = now();
        }
        await writeFileAtomic(marker, JSON.stringify(result));
        if (result.reason) break;
        if (pair.control.requestErrors > 0 || pair.candidate.requestErrors > pair.candidate.attributableRequestErrors) {
          result.reason = 'transport_error'; break;
        }
        if (pair.candidate.attributableRequestErrors > 0 || pair.candidate.valid === false || Number.isSafeInteger(pair.control.repairs)
          && Number.isSafeInteger(pair.candidate.repairs) && pair.candidate.repairs > pair.control.repairs) {
          result.status = 'rejected'; break;
        }
        if (pair.control.requestErrors > 0 || pair.control.valid !== true) { result.reason = 'control_failed'; break; }
      }
      if (!result.reason && result.status !== 'rejected') {
        if (phase === 'title' && samples.length === 16) {
          const ratings = await grade({ rubric: TITLE_SCREEN_RUBRIC, samples: samples.sort((a, b) => a.id.localeCompare(b.id)) });
          if (!Array.isArray(ratings) || ratings.length !== 16 || new Set(ratings.map(rating => rating.id)).size !== 16
            || ratings.some(rating => !grades.has(rating.id) || typeof rating.accepted !== 'boolean')) result.reason = 'grading_incomplete';
          else for (const rating of ratings) grades.get(rating.id).qualityAccepted = rating.accepted;
        }
        result.status = phase === 'title' ? gradeTitleScreen(result.pairs)
          : result.pairs.length === 6 && result.pairs.every(pair => ['control', 'candidate'].every(arm => pair[arm]?.valid === true
            && pair[arm]?.qualityAccepted === true && pair[arm]?.requestErrors === 0)) ? 'not_rejected' : 'incomplete';
      }
    } catch (error) {
      result.status = 'incomplete'; result.reason = error?.code === 'CACHE_ATTEMPT_CAP' ? 'attempt_cap' : 'run_failure';
    } finally {
      await writeFileAtomic(path.join(root, 'cache-context.json'), JSON.stringify({ runID, routeID, phase, closed: true }));
      // Cursors are continuous, including the final tail. Closing context stops
      // new observed admission; already reserved work may still need to settle.
      for (let elapsed = 0; elapsed <= 10_000; elapsed += 100) {
        const tailAttempts = (await readCacheAttempts(root)).slice(before), tailRows = (await readWire(root)).slice(wireOffset);
        if (!tailAttempts.length && !tailRows.length) break;
        result.status = 'incomplete'; result.reason ??= 'late_attempts';
        if (tailAttempts.every(attempt => tailRows.some(row => row.type === 'response' && row.usageObservation?.attemptID === attempt.attemptID))) break;
        if (elapsed < 10_000) await wait(100);
      }
    }
    await writeFileAtomic(marker, JSON.stringify(result));
    return result;
  });
}
