import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const GUIDANCE_NAME = 'devryan-orchestration-guidance';

/** Experimental role only. Never rewrite the installed or packaged default. */
export function createCompactOrchestrator(source) {
  const sections = ['Subagent Prompt Template', 'Workflow', 'Parallel Delegation'];
  let prompt = source;
  const guidance = [];
  for (const name of sections) {
    const pattern = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`);
    const match = prompt.match(pattern);
    if (!match) throw new Error(`Missing source role section: ${name}`);
    guidance.push(`## ${name}\n\n${match[1]}`);
    // Keep admission and authority instructions in the persistent prefix.
    const retained = name === 'Subagent Prompt Template'
      ? match[1].split('\n\n').filter(paragraph => paragraph.startsWith('Skills routing:') || paragraph.startsWith('Approved-plan implementation startup:'))
      : [];
    const summary = name === 'Subagent Prompt Template'
      ? `Before drafting a specialist brief, load the native skill \`${GUIDANCE_NAME}\` once for its templates and checklist. If unavailable, include objective, current evidence, exact owned scope, dependencies, exclusions, named checks, and a terminal \`**Status:** complete\` or \`**Status:** blocked\` marker. Never paste accumulated transcripts. The persistent routing, permission, recovery, and review rules remain authoritative.`
      : name === 'Parallel Delegation'
        ? 'Parallelize only independently useful, disjoint scopes. Sequence dependencies and overlapping mutable work. Reconcile evidence and todos, then disposition every ordinary result before the next gated action. Synthetic wakes deliver existing work without extending authorization or resetting retries. Keep DevRyan as the sole automatic continuation owner.'
        : 'Understand the requested outcome and scope, choose direct or specialist execution, implement within authorization, integrate results, verify applicable checks, then finish. Planning-only requests stay read-only. Preserve the one late Oracle checkpoint and its direct-remediation closeout rule.';
    prompt = prompt.replace(pattern, `<${name}>\n${[summary, ...retained].join('\n\n')}\n</${name}>`);
  }
  const skill = `---\nname: ${GUIDANCE_NAME}\ndescription: Specialist brief templates and execution checklists for DevRyan Orchestrator; load before drafting a managed specialist assignment.\n---\n\n# Orchestrator procedures\n\nThese procedures supplement the persistent role. They do not grant permissions, change specialist ownership, reset recovery budgets, or override host barriers.\n\n${guidance.join('\n\n')}\n`;
  return { prompt, skill };
}

export async function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--output') throw new Error('Usage: node scripts/agent-evals/compact-orchestrator.mjs --output <repository-cache-directory>');
  const output = path.resolve(argv[1]), cache = path.join(root, '.cache');
  const relative = path.relative(cache, output);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Candidate output must be inside repository .cache');
  const source = await readFile(path.join(root, 'packages/web/server/default-config/agents/orchestrator.md'), 'utf8');
  const result = createCompactOrchestrator(source);
  await mkdir(path.join(output, 'skills', GUIDANCE_NAME), { recursive: true });
  await mkdir(path.join(output, 'agents'), { recursive: true });
  await writeFile(path.join(output, 'agents/orchestrator.md'), result.prompt, { mode: 0o600 });
  await writeFile(path.join(output, 'skills', GUIDANCE_NAME, 'SKILL.md'), result.skill, { mode: 0o600 });
  console.log(JSON.stringify({ promoted: false, sourceBytes: Buffer.byteLength(source), candidateBytes: Buffer.byteLength(result.prompt), guidanceBytes: Buffer.byteLength(result.skill) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
