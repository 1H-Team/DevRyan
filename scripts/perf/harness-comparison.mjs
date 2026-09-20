import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { comparePairedReports } from '../agent-evals/paired.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const numeric = value => Number.isFinite(value) && value >= 0 ? value : null;
const sum = values => values.length && values.every(value => numeric(value) !== null)
  ? values.reduce((total, value) => total + value, 0) : null;
const mean = values => sum(values) === null ? null : sum(values) / values.length;
const observed = value => value?.observed > 0 && value.unknown === 0 ? numeric(value.total) : null;
const metricNames = ['successRate', 'inputTokens', 'outputTokens', 'retries', 'latencyMs', 'cpuMs', 'retainedBytes'];
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// A fixed numeric projection: raw prompts, identifiers, paths and tool output
// never enter the comparison artifact. Unknown observations remain null.
export function projectAgentMetrics(report) {
  const runs = report?.runs ?? [];
  const roots = runs.map(run => !run.harness?.evidence?.incomplete && run.harness?.evidence?.roots?.length === 1
    ? run.harness.evidence.roots[0] : null);
  const complete = runs.length > 0 && report.execution?.completedRuns === report.execution?.plannedRuns
    && report.execution.completedRuns === runs.length;
  return {
    successRate: complete ? runs.filter(run => run.status === 'passed').length / runs.length : null,
    inputTokens: complete ? sum(roots.map(root => observed(root?.usage?.input))) : null,
    outputTokens: complete ? sum(roots.map(root => observed(root?.usage?.output))) : null,
    // Managed retry dispositions are narrower than provider retries. Do not
    // relabel them as a complete retry measurement.
    retries: null,
    latencyMs: complete ? mean(roots.map(root => numeric(root?.objectiveDurationMs))) : null,
    cpuMs: null,
    retainedBytes: complete ? mean((report.resources?.processSampling?.runs ?? []).map(run => numeric(run.finalBytes))) : null,
  };
}

export function compareMetrics(baseline, candidate) {
  return Object.fromEntries(metricNames.map(name => {
    const before = numeric(baseline?.[name]), after = numeric(candidate?.[name]);
    return [name, { baseline: before, candidate: after,
      delta: before === null || after === null ? null : after - before,
      availability: before === null || after === null ? 'unavailable' : 'observed' }];
  }));
}

export function compareDeterministicReports(baseline, candidate) {
  const identityKeys = ['schemaVersion', 'fixtureHash', 'protocolHash', 'runtime'];
  const comparable = baseline?.schemaVersion === 1
    && ['fixtureHash', 'protocolHash', 'runtime'].every(key => isHash(baseline?.[key]))
    && identityKeys.every(key => baseline?.[key] !== undefined && baseline[key] === candidate?.[key]);
  const baselineCases = baseline?.cases ?? [], candidateCases = candidate?.cases ?? [];
  const membership = baselineCases.length > 0 && baselineCases.length === candidateCases.length
    && new Set(baselineCases.map(entry => entry.id)).size === baselineCases.length
    && new Set(candidateCases.map(entry => entry.id)).size === candidateCases.length
    && baselineCases.every(entry => candidateCases.some(other => other.id === entry.id));
  const cases = candidateCases.map(entry => {
    const before = baselineCases.find(other => other.id === entry.id);
    return { id: /^[a-z0-9-]{1,80}$/.test(entry.id) ? entry.id : 'invalid',
      passed: entry.passed === true, baselinePassed: before?.passed === true,
      metrics: compareMetrics(before?.metrics, entry.metrics),
      operations: Object.fromEntries(Object.entries(entry.operations ?? {}).filter(([key, value]) =>
        /^[a-zA-Z]{1,64}$/.test(key) && numeric(value) !== null).map(([key, value]) => {
        const baselineValue = numeric(before?.operations?.[key]);
        return [key, { baseline: baselineValue, candidate: value, delta: baselineValue === null ? null : value - baselineValue }];
      })) };
  });
  return { comparable: comparable && membership,
    passed: comparable && membership && cases.every(entry => entry.id !== 'invalid' && entry.passed && entry.baselinePassed),
    cases };
}

export function buildHarnessComparison({ baseline, candidate, agentPairs, factor, targetMetric } = {}) {
  if (!baseline || !candidate) throw new Error('comparison_reports_required');
  const deterministic = compareDeterministicReports(baseline, candidate);
  let agent = { verdict: 'unavailable', metrics: compareMetrics(null, null) };
  if (agentPairs !== undefined) {
    if (!Array.isArray(agentPairs) || ![3, 10].includes(agentPairs.length)
      || !['readOverlap', 'waitAny', 'compactResults', 'contextProjection', 'role'].includes(factor)
      || !['objectiveDurationMs', 'input', 'workspaceBarrierMs', 'resultConsumptionMs', 'toolExecutionMs', 'toolVolumeBytes'].includes(targetMetric)) {
      throw new Error('comparison_pairing_invalid');
    }
    const comparison = comparePairedReports({ pairs: agentPairs, factor, targetMetric, requiredPairs: agentPairs.length });
    agent = { verdict: comparison.verdict, reasons: comparison.reasons,
      expansionRequired: comparison.expansionRequired,
      pairs: agentPairs.map(pair => ({ metrics: compareMetrics(projectAgentMetrics(pair.baseline), projectAgentMetrics(pair.candidate)) })) };
  }
  return { schemaVersion: 1, sourceHashes: { baseline: hash(baseline), candidate: hash(candidate) },
    deterministic, agent, passed: deterministic.passed && (agentPairs === undefined || agent.verdict === 'canary-eligible'),
    canaryEligible: deterministic.passed && agent.verdict === 'canary-eligible',
    // Manual/natural native journeys and rollout review are separate prerequisites.
    nativeAcceptance: 'required-separately', nativePromotionEligible: false };
}

export async function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--config') throw new Error('comparison_config_required');
  const configPath = path.resolve(argv[1]);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config?.schemaVersion !== 1 || Object.keys(config).some(key => !['schemaVersion', 'baseline', 'candidate', 'output', 'agentPairs', 'factor', 'targetMetric'].includes(key))
    || !['baseline', 'candidate', 'output'].every(key => typeof config[key] === 'string' && config[key].trim())) throw new Error('comparison_config_invalid');
  const resolve = value => path.resolve(path.dirname(configPath), value);
  if (config.agentPairs !== undefined && (!Array.isArray(config.agentPairs)
    || !config.agentPairs.every(pair => pair && ['baseline', 'candidate'].every(key => typeof pair[key] === 'string' && pair[key].trim())))) {
    throw new Error('comparison_pairing_invalid');
  }
  const inputs = [configPath, resolve(config.baseline), resolve(config.candidate),
    ...(config.agentPairs ?? []).flatMap(pair => [resolve(pair.baseline), resolve(pair.candidate)])];
  const output = resolve(config.output);
  if (inputs.includes(output)) throw new Error('comparison_output_conflict');
  const read = async value => JSON.parse(await readFile(resolve(value), 'utf8'));
  const baseline = await read(config.baseline), candidate = await read(config.candidate);
  const agentPairs = config.agentPairs === undefined ? undefined : await Promise.all(config.agentPairs.map(async (pair, index) => ({
    index: index + 1, baseline: await read(pair.baseline), candidate: await read(pair.candidate),
  })));
  const result = buildHarnessComparison({ baseline, candidate, agentPairs, factor: config.factor, targetMetric: config.targetMetric });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return result.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('harness_comparison_failed'); process.exitCode = 1;
  });
}
