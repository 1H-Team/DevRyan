import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildHarnessComparison } from './harness-comparison.mjs';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '../..');
const digest = value => createHash('sha256').update(value).digest('hex');
const fixture = { version: 1, tasks: 500, promptBytes: 2200, vectors: 10_000, dimensions: 64, limit: 10 };
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function measure(sourceRoot) {
  const load = relative => import(pathToFileURL(path.join(sourceRoot, relative)).href);
  const { compactManagedOrchestrationState } = await load('packages/orchestration-runtime/persistence.js');
  const { createHybridSearch, cosineSimilarity, mergeHybridResults } = await load('packages/bot-indexer/src/search.js');
  const { decodeEmbedding } = await load('packages/bot-indexer/src/embeddings.js');
  const input = { version: 1, tasks: Array.from({ length: fixture.tasks }, (_, i) => ({
    taskId: `task-${i}`, createdAt: i, finishedAt: i, sequence: i, status: 'completed',
    dispatchGroupId: null, priorTaskId: null, parentTaskId: null, prompt: 'x'.repeat(fixture.promptBytes),
  })), resultEnvelopes: [] };
  const maxBytes = Math.floor(Buffer.byteLength(JSON.stringify(input)) / 2);
  // Small independent retention oracle, excluded from the measured interval.
  const expected = { ...input, tasks: [...input.tasks] };
  while (Buffer.byteLength(JSON.stringify(expected)) > maxBytes) expected.tasks.shift();
  compactManagedOrchestrationState(input, { maxBytes, assumeOwnedInput: true });

  const runCase = async (id, operation) => {
    global.gc?.();
    const cpu = process.cpuUsage(), start = performance.now();
    const operations = await operation();
    const latencyMs = performance.now() - start, used = process.cpuUsage(cpu);
    global.gc?.();
    return { id, passed: true, metrics: { successRate: 1, latencyMs,
      cpuMs: (used.user + used.system) / 1000, retainedBytes: process.memoryUsage().heapUsed }, operations };
  };
  const ledger = await runCase('ledger-compaction', async () => {
    const stringify = JSON.stringify;
    let serializedBytes = 0, serializations = 0, result;
    JSON.stringify = (...args) => {
      const encoded = stringify(...args);
      if (encoded !== undefined) serializedBytes += Buffer.byteLength(encoded);
      serializations++;
      return encoded;
    };
    try { result = compactManagedOrchestrationState(input, { maxBytes, maxAgeMs: Infinity, assumeOwnedInput: true }); }
    finally { JSON.stringify = stringify; }
    assert.deepEqual(result.state, expected);
    assert.equal(result.serializedBytes, Buffer.byteLength(JSON.stringify(expected)));
    assert.equal(result.overLimit, false);
    return { serializedBytes, serializations, retainedRecords: result.state.tasks.length };
  });

  let decodedScalars = 0, offsetRows = 0;
  const rows = Array.from({ length: fixture.vectors }, (_, i) => {
    const embedding = Buffer.alloc(fixture.dimensions * 4);
    for (let d = 0; d < fixture.dimensions; d++) embedding.writeFloatLE(((i * 31 + d * 17) % 103) / 103, d * 4);
    const original = embedding.readFloatLE;
    embedding.readFloatLE = function (offset) { decodedScalars++; return original.call(this, offset); };
    return { namespace: 'bot:fixture', documentId: `doc-${String(i).padStart(6, '0')}`, ordinal: 0, embedding };
  });
  const query = Array.from({ length: fixture.dimensions }, (_, d) => d / fixture.dimensions);
  const fullSort = rows.map(row => ({ ...row, vectorScore: cosineSimilarity(query, decodeEmbedding(row.embedding)) }))
    .sort((a, b) => b.vectorScore - a.vectorScore || a.namespace.localeCompare(b.namespace)
      || a.documentId.localeCompare(b.documentId) || a.ordinal - b.ordinal).slice(0, 100);
  const expectedRanking = mergeHybridResults({ ftsResults: [], vectorResults: fullSort, limit: fixture.limit })
    .map(row => [row.documentId, row.score]);
  const store = {
    status: () => ({ state: 'ready', chunkCount: rows.length }), ftsSearch: () => [],
    vectorCandidates: (_ns, limit, offset) => { offsetRows += offset; return rows.slice(offset, offset + limit); },
    vectorCandidatesAfter: (_ns, limit, cursor) => {
      const index = cursor ? Number(cursor.documentId.slice(4)) + 1 : 0;
      return rows.slice(index, index + limit);
    },
  };
  const search = createHybridSearch({ store, embeddings: { embed: async () => [query], model: 'fixture' } });
  decodedScalars = 0;
  const vector = await runCase('vector-retrieval', async () => {
    const result = await search.search({ query: 'fixture', namespaces: ['bot:fixture'], limit: fixture.limit });
    assert.deepEqual(result.results.map(row => [row.documentId, row.score]), expectedRanking);
    return { decodedScalars, offsetRows, candidates: rows.length };
  });
  const sourceFiles = ['packages/orchestration-runtime/persistence.js', 'packages/bot-indexer/src/search.js', 'packages/bot-indexer/src/embeddings.js'];
  return { schemaVersion: 1, fixtureHash: digest(JSON.stringify(fixture)), protocolHash: digest(await readFile(script)),
    sourceHashes: Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, digest(await readFile(path.join(sourceRoot, file)))]))),
    runtime: digest(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model })),
    measurement: { cpu: 'process-cpu-ms', retained: 'whole-worker-heap-after-forced-gc', timing: 'descriptive-not-a-release-threshold' },
    cases: [ledger, vector] };
}

const execute = (sourceRoot, output) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--expose-gc', script, '--measure', sourceRoot, '--output', output], { stdio: ['ignore', 'ignore', 'pipe'] });
  let error = '';
  child.stderr.on('data', chunk => { error = (error + chunk).slice(-2000); });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve() : reject(new Error(`Resource benchmark failed (${code}): ${error}`)));
});

export async function main(argv) {
  if (argv.length !== 4 || !['--baseline', '--measure'].includes(argv[0]) || argv[2] !== '--output') {
    throw new Error('Usage: node scripts/perf/harness-resource-benchmark.mjs --baseline <checkout> --output <report.json>');
  }
  const sourceRoot = path.resolve(argv[1]), output = path.resolve(argv[3]);
  await mkdir(path.dirname(output), { recursive: true });
  if (argv[0] === '--measure') {
    await writeFile(output, `${JSON.stringify(await measure(sourceRoot), null, 2)}\n`, { mode: 0o600 });
    return 0;
  }
  const trials = { baseline: [], candidate: [] };
  for (let pair = 1; pair <= 3; pair++) {
    for (const side of pair % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
      const trialPath = `${output}.${side}-${pair}.json`;
      await execute(side === 'baseline' ? sourceRoot : root, trialPath);
      trials[side].push(JSON.parse(await readFile(trialPath, 'utf8')));
    }
  }
  const aggregate = runs => ({ ...runs[0], cases: runs[0].cases.map((entry, index) => ({ ...entry,
    passed: runs.every(run => run.cases[index].passed),
    metrics: Object.fromEntries(Object.keys(entry.metrics).map(key => [key, median(runs.map(run => run.cases[index].metrics[key]))])),
  })) });
  const baseline = aggregate(trials.baseline), candidate = aggregate(trials.candidate);
  const result = buildHarnessComparison({ baseline, candidate });
  // Stable operation counts gate PRs; noisy wall time/CPU/heap observations remain descriptive.
  result.resourceGate = candidate.cases.every((entry, index) => ['serializedBytes', 'decodedScalars', 'offsetRows'].every(key =>
    entry.operations[key] === undefined || entry.operations[key] <= baseline.cases[index].operations[key]));
  result.passed &&= result.resourceGate;
  result.trials = trials;
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ passed: result.passed, output, cases: result.deterministic.cases }));
  return result.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
