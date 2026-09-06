import { projectReasoningOptions } from './reasoning-controls-evidence.mjs';
import { appendFile, readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cacheRoot = fileURLToPath(new URL('../../.cache/', import.meta.url));
const LIMIT = 8 * 1024 * 1024;
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(value) ? value : null;
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const digest = value => typeof value === 'string' ? { bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') } : null;


export default async function QaProviderObserver() {
  const runtimeRoot = process.env.DEVRYAN_QA_RUNTIME_ROOT;
  const home = process.env.DEVRYAN_QA_HOME;
  if (!runtimeRoot || !home) throw new Error('QA observation requires an owned isolated runtime');
  const canonicalRoot = await realpath(runtimeRoot);
  if (!canonicalRoot.startsWith(cacheRoot) || !home.startsWith(`${canonicalRoot}${path.sep}`)
    || (await readFile(path.join(home, '.devryan-qa-home'), 'utf8')) !== 'owned QA home\n') {
    throw new Error('QA observation root is not owned');
  }
  const output = path.join(canonicalRoot, 'provider-evidence.ndjson');
  let bytes = await stat(output).then(s => s.size).catch(error => { if (error.code === 'ENOENT') return 0; throw error; });
  let warned = false;
  const record = async (kind, value) => {
    const line = JSON.stringify({ schemaVersion: 1, at: Date.now(), kind, ...value }) + '\n';
    if (bytes + Buffer.byteLength(line) > LIMIT) {
      if (!warned) { warned = true; console.error('DEVRYAN_QA_OBSERVER_GAP: evidence byte limit'); }
      return;
    }
    bytes += Buffer.byteLength(line);
    try { await appendFile(output, line, { mode: 0o600 }); }
    catch { if (!warned) { warned = true; console.error('DEVRYAN_QA_OBSERVER_GAP: evidence write failed'); } }
  };
  await record('observer.ready', { maximumBytes: LIMIT });
  return {
    'chat.message': async (input, output) => record('chat.message', {
      sessionID: id(input.sessionID), messageID: id(input.messageID ?? output.message?.id), agent: id(input.agent),
      providerID: id(input.model?.providerID), modelID: id(input.model?.modelID),
      variant: input.variant === '' ? '' : id(input.variant), variantPresent: Object.hasOwn(input, 'variant') && input.variant !== undefined,
    }),
    'chat.params': async (input, output) => record('chat.params', {
      sessionID: id(input.sessionID), messageID: id(input.message?.id), agent: id(input.agent),
      providerID: id(input.model?.providerID), modelID: id(input.model?.id),
      modelLimits: { context: numeric(input.model?.limit?.context), input: numeric(input.model?.limit?.input), output: numeric(input.model?.limit?.output) },
      options: projectReasoningOptions(output.options), maxOutputTokens: numeric(output.maxOutputTokens),
      stage: 'native-chat-params-after-configured-plugins-before-adapter',
    }),
    'experimental.session.compacting': async (input, output) => record('native.compacting', {
      sessionID: id(input.sessionID), context: (output.context ?? []).map(digest), promptOverride: digest(output.prompt),
    }),
    'experimental.compaction.autocontinue': async (input, output) => record('native.compaction.autocontinue', {
      sessionID: id(input.sessionID), messageID: id(input.message?.id), overflow: input.overflow === true, enabled: output.enabled !== false,
    }),
    event: async ({ event }) => {
      if (event?.type === 'permission.asked') await record('native.permission.asked', {
        sessionID: id(event.properties?.sessionID), requestID: id(event.properties?.id),
        messageID: id(event.properties?.tool?.messageID), callID: id(event.properties?.tool?.callID),
      });
      if (event?.type === 'permission.replied') await record('native.permission.replied', {
        sessionID: id(event.properties?.sessionID), requestID: id(event.properties?.requestID),
        reply: ['once', 'always', 'reject'].includes(event.properties?.reply) ? event.properties.reply : null,
      });
      if (event?.type === 'session.compacted') await record('native.session.compacted', { sessionID: id(event.properties?.sessionID) });
      if (event?.type === 'session.error') await record('native.session.error', {
        sessionID: id(event.properties?.sessionID), errorName: id(event.properties?.error?.name),
      });
    },
  };
}
