// Repository-only QA ownership and durable HTTP-attempt admission. Never used by
// a production transport. Reservations are spent even if dispatch fails/aborts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { withCrossProcessFileLock, writeFileAtomic } from '../../packages/harness-runtime/lib/atomic-file.js';
import { isLoopbackCacheOrigin } from '../../packages/shared-runtime/lib/cache-efficiency-policy.js';

const qaRoot = fileURLToPath(new URL('../../.cache/qa/', import.meta.url));
const inside = (parent, child) => child.startsWith(parent + path.sep);
const hasLiveRoute = study => study.routes.some(route => !isLoopbackCacheOrigin(route.origin));
const routeIdentity = route => JSON.stringify(['id', 'provider', 'model', 'auth', 'transport', 'origin', 'path'].map(key => route[key]));
export async function ownedQaDirectory(runtimeRoot, home) {
  if (!runtimeRoot || !home) return null;
  const [base, root, ownedHome] = await Promise.all([fs.realpath(qaRoot), fs.realpath(runtimeRoot), fs.realpath(home)]);
  if (!inside(base, root) || !inside(root, ownedHome)
    || (await fs.readFile(path.join(ownedHome, '.devryan-qa-home'), 'utf8')) !== 'owned QA home\n') throw new Error('Cache QA requires an owned isolated directory');
  return root;
}
export function validateStudy(value) {
  if (value?.version !== 1 || !Array.isArray(value.routes) || value.routes.length < 1 || value.routes.length > 4) throw new Error('Invalid cache study');
  const names = new Set(), targets = new Set();
  for (const route of value.routes) {
    const target = new URL(route.origin);
    const key = JSON.stringify([route.origin, route.path, route.model]);
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(route.id) || names.has(route.id) || targets.has(key)
      || !/^[a-zA-Z0-9_.:/-]{1,200}$/.test(route.model)
      || target.origin !== route.origin || target.username || target.password
      || !(target.protocol === 'https:' || target.protocol === 'http:' && isLoopbackCacheOrigin(route.origin))
      || !['/v1/responses', '/responses', '/backend-api/codex/responses', '/v1/chat/completions', '/chat/completions', '/v1/messages'].includes(route.path)
      || !['openai', 'anthropic', 'xai'].includes(route.provider)
      || !['responses', 'chat_completions', 'messages'].includes(route.transport)
      || !['api_key', 'oauth', 'unknown'].includes(route.auth)) throw new Error('Invalid cache study route');
    names.add(route.id); targets.add(key);
  }
  return value;
}
export async function initializeCacheCampaign({ campaignRoot, home, routes, runtimeVersion }) {
  const root = await ownedQaDirectory(campaignRoot, home);
  if (!root) throw new Error('Owned cache campaign required');
  const campaign = validateStudy({ version: 1, id: randomUUID(), routes, runtimeVersion });
  const handle = await fs.open(path.join(root, 'cache-campaign.json'), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(campaign)); await handle.sync(); } finally { await handle.close(); }
  return campaign;
}
export async function cacheStudyStorage(root, studyInput) {
  const study = studyInput ?? validateStudy(JSON.parse(await fs.readFile(path.join(root, 'cache-study.json'), 'utf8')));
  if (!study.campaignRoot) {
    if (hasLiveRoute(study)) throw new Error('Live cache studies require a shared parent campaign ledger');
    return { study, budget: study, ledgerRoot: root };
  }
  const [base, campaignRoot, profileRoot] = await Promise.all([fs.realpath(qaRoot), fs.realpath(study.campaignRoot), fs.realpath(root)]);
  if (!inside(base, campaignRoot) || !inside(campaignRoot, profileRoot)) throw new Error('Campaign must own this disposable profile');
  const budget = validateStudy(JSON.parse(await fs.readFile(path.join(campaignRoot, 'cache-campaign.json'), 'utf8')));
  if (study.campaignID !== budget.id || study.runtimeVersion !== budget.runtimeVersion
    || study.routes.some(route => !budget.routes.some(candidate => routeIdentity(candidate) === routeIdentity(route)))) throw new Error('Cache campaign identity mismatch');
  return { study, budget, ledgerRoot: campaignRoot };
}
export async function initializeCacheStudy({ runtimeRoot, home, routes, runtimeVersion, campaignRoot }) {
  const root = await ownedQaDirectory(runtimeRoot, home);
  if (!root) throw new Error('Owned QA profile required');
  const study = validateStudy({ version: 1, id: randomUUID(), routes, runtimeVersion });
  if (campaignRoot) {
    study.campaignRoot = await fs.realpath(campaignRoot);
    const campaign = JSON.parse(await fs.readFile(path.join(study.campaignRoot, 'cache-campaign.json'), 'utf8'));
    study.campaignID = campaign.id;
  }
  await cacheStudyStorage(root, study);
  // Exclusive create: restarting a study must never reset its allowance.
  const handle = await fs.open(path.join(root, 'cache-study.json'), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(study)); await handle.sync(); } finally { await handle.close(); }
  return study;
}
export async function reserveCacheAttempt(root, routeID, phase, now = Date.now) {
  if (!['aa', 'title'].includes(phase)) throw new Error('Invalid cache study phase');
  const { study, budget, ledgerRoot } = await cacheStudyStorage(root);
  return withCrossProcessFileLock(path.join(ledgerRoot, 'cache-attempts.lock'), async () => {
    if (!study.routes.some(route => route.id === routeID)) throw new Error('Unregistered cache route');
    const file = path.join(ledgerRoot, 'cache-attempts.json');
    let ledger;
    try { ledger = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; ledger = { version: 1, studyID: budget.id, attempts: [] }; }
    if (ledger.studyID !== budget.id || !Array.isArray(ledger.attempts) || ledger.attempts.length > 160
      || ledger.attempts.some(attempt => !budget.routes.some(route => route.id === attempt.routeID) || !['aa', 'title'].includes(attempt.phase))) throw new Error('Invalid attempt ledger');
    const routeAttempts = ledger.attempts.filter(attempt => attempt.routeID === routeID);
    if (ledger.attempts.length >= 160 || routeAttempts.length >= 40
      || routeAttempts.filter(attempt => attempt.phase === phase).length >= (phase === 'aa' ? 16 : 24)) {
      throw Object.assign(new Error('Cache study attempt cap reached; result incomplete'), { code: 'CACHE_ATTEMPT_CAP' });
    }
    const attempt = { attemptID: randomUUID(), ordinal: ledger.attempts.length + 1, studyID: study.id, routeID, phase, reservedAt: now() };
    ledger.attempts.push(attempt);
    await writeFileAtomic(file, JSON.stringify(ledger));
    return attempt;
  });
}
export async function readCacheAttempts(root) {
  const { budget, ledgerRoot } = await cacheStudyStorage(root);
  try {
    const ledger = JSON.parse(await fs.readFile(path.join(ledgerRoot, 'cache-attempts.json'), 'utf8'));
    if (ledger.studyID !== budget.id || !Array.isArray(ledger.attempts) || ledger.attempts.length > 160) throw new Error('Invalid attempt ledger');
    return ledger.attempts;
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
