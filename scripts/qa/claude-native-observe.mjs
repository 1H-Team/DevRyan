// Explicitly opt-in, read-only observation of an already running Claude task.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareQuota, projectQuota, readNativeAssistants, summarizeNativeAssistants } from './claude-quota-evidence.mjs';

export async function observeNativeClaude({ sessionFile, quotaOrigin, output, since = Date.now(),
  intervalMs = 30_000, durationMs = 20 * 60_000, signal } = {}) {
  if (typeof sessionFile !== 'string' || !path.isAbsolute(sessionFile) || !sessionFile.endsWith('.jsonl')
    || typeof output !== 'string' || !Number.isFinite(since) || since < 0
    || !Number.isFinite(intervalMs) || intervalMs < 1000
    || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 2 * 60 * 60_000) {
    throw new Error('Expected an absolute native session file and bounded observation times');
  }
  const origin = new URL(quotaOrigin);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)
    || origin.username || origin.password || !origin.port) throw new Error('Quota origin must be an explicit loopback server');
  const root = path.resolve(import.meta.dirname, '../../.cache');
  const target = path.resolve(output);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Observation output must be inside repository .cache');
  await fs.mkdir(target, { recursive: true });
  const main = path.resolve(sessionFile);
  const children = main.replace(/\.jsonl$/, '') + '/subagents';
  const deadline = Date.now() + durationMs;
  let baseline;
  let latest;
  do {
    const files = [main];
    for (const entry of await fs.readdir(children, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.join(children, entry.name));
    }
    const evidence = await readNativeAssistants(files);
    const native = summarizeNativeAssistants(evidence.rows, { since });
    let quota;
    let quotaError;
    try {
      const response = await fetch(new URL('/v1/usage/quota', origin), { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`quota_http_${response.status}`);
      quota = projectQuota(await response.json());
      baseline ??= quota;
    } catch (error) { quotaError = error instanceof Error ? error.message : 'quota_unavailable'; }
    const { requests, ...summary } = native;
    latest = { at: Date.now(), since, native: summary, gaps: evidence.gaps, quota,
      quotaError, quotaDelta: baseline && quota ? compareQuota(baseline, quota) : null };
    await fs.appendFile(path.join(target, 'samples.ndjson'), `${JSON.stringify(latest)}\n`);
    await fs.writeFile(path.join(target, 'native-requests.json'), JSON.stringify(requests, null, 2));
    await fs.writeFile(path.join(target, 'latest.json'), JSON.stringify(latest, null, 2));
    console.log(JSON.stringify({ at: latest.at, responses: summary.observedResponseCount,
      cacheReadRatio: summary.cacheReadRatio, models: summary.models,
      quota: quota?.windows, quotaError }));
    if (signal?.aborted || Date.now() >= deadline) break;
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, intervalMs);
      signal?.addEventListener('abort', finish, { once: true });
    });
  } while (!signal?.aborted && Date.now() < deadline);
  return latest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const known = new Set(['--session', '--quota-origin', '--output', '--since', '--minutes']);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!known.has(args[index]) || !args[index + 1]) throw new Error('Expected --session FILE --quota-origin URL --output DIR [--since EPOCH_MS] [--minutes N]');
    values[args[index]] = args[index + 1];
  }
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  await observeNativeClaude({ sessionFile: values['--session'], quotaOrigin: values['--quota-origin'],
    output: values['--output'], since: values['--since'] ? Number(values['--since']) : Date.now(),
    durationMs: Number(values['--minutes'] ?? 20) * 60_000, signal: controller.signal });
}
