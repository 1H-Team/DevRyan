// Run with Bun: imports the production TypeScript reducer directly.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { applyDirectoryEvent } from '../../packages/ui/src/sync/event-reducer.ts';
import { INITIAL_STATE } from '../../packages/ui/src/sync/types.ts';

const percentile = (values, fraction) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const scenarios = [];
for (const sessionCount of [1, 4]) {
  for (const historySize of [50, 500, 2000]) {
    for (const kind of ['delta', 'snapshot']) {
      const state = structuredClone(INITIAL_STATE);
      const events = [];
      for (let index = 0; index < sessionCount; index += 1) {
        const sessionID = `ses_bench_${index}`;
        const messages = Array.from({ length: historySize }, (_, messageIndex) => ({
          id: `msg_${index}_${messageIndex}`, sessionID, role: 'assistant', time: { created: messageIndex + 1 },
        }));
        const messageID = messages.at(-1).id;
        const part = { id: `prt_${index}`, messageID, sessionID, type: 'text', text: '' };
        state.message[sessionID] = messages;
        state.session_status[sessionID] = { type: 'busy' };
        state.part[messageID] = [part];
        events.push(kind === 'delta'
          ? { type: 'message.part.delta', properties: { messageID, partID: part.id, field: 'text', delta: 'x' } }
          : { type: 'message.part.updated', properties: { part: { ...part, text: 'snapshot' } } });
      }
      // Match the pipeline's authoritative message-to-session callback.
      const sessionByMessage = new Map(Object.entries(state.message).map(([id, messages]) => [messages.at(-1).id, id]));
      const callbacks = { resolveSessionIDForMessage: (id) => sessionByMessage.get(id) };
      const batch = () => {
        for (let index = 0; index < 100; index += 1) applyDirectoryEvent(state, events[index % events.length], callbacks);
      };
      for (let index = 0; index < 10; index += 1) batch();
      const samples = [];
      for (let index = 0; index < 50; index += 1) {
        const start = performance.now();
        batch();
        samples.push((performance.now() - start) / 100);
      }
      scenarios.push({ sessionCount, historySize, kind, samples: samples.length, eventsPerSample: 100,
        p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95),
        minMs: Math.min(...samples), maxMs: Math.max(...samples) });
    }
  }
}
console.log(JSON.stringify({ schemaVersion: 1, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  reducerSha256: createHash('sha256').update(readFileSync(new URL('../../packages/ui/src/sync/event-reducer.ts', import.meta.url))).digest('hex'),
  runtime: Bun.version, scope: 'reducer only; excludes rendering, network, and provider latency', scenarios }, null, 2));
