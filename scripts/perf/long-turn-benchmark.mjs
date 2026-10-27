// Paired development-mode MessageList commits with a lightweight leaf probe.
// This is a focused regression signal, not a substitute for an Electron run.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = spawnSync('bun', ['test', 'packages/ui/src/components/chat/MessageList.longTurn.test.tsx', '--test-name-pattern', 'matched growing-turn render benchmark'],
  { cwd: root, env: { ...process.env, DEVRYAN_LONG_TURN_BENCH: '1' }, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
if (run.status !== 0) { process.stderr.write(run.stdout + run.stderr); process.exitCode = 1; }
else {
  const match = run.stdout.match(/DEVRYAN_LONG_TURN_SAMPLES (\[[^\n]+\])/);
  if (!match) throw new Error('benchmark_samples_missing');
  const pairs = JSON.parse(match[1]);
  const median = values => { const sorted = [...values].sort((a, b) => a - b); const i = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2; };
  const baselineMedianMs = median(pairs.map(pair => pair.baseline));
  const candidateMedianMs = median(pairs.map(pair => pair.candidate));
  const everyPairFaster = pairs.every(pair => pair.candidate < pair.baseline);
  const improvementPercent = 100 * (baselineMedianMs - candidateMedianMs) / baselineMedianMs;
  console.log(JSON.stringify({ workload: '200, 400, 800 growing assistant tool messages; mounted MessageList with lightweight ChatMessage probe',
    pairs, baselineMedianMs, candidateMedianMs, improvementPercent, everyPairFaster,
    passesFocusedThreshold: improvementPercent >= 5 && everyPairFaster,
    qualification: 'unqualified: lightweight leaf probe; full native browser rendering not measured' }, null, 2));
}
