# Matched retrieval diagnostics procedure

> Historical — archived 2026-10-09; current contract: [QA runner](../../../QA.md) and `scripts/qa/compaction-retrieval-diagnostic.mjs`

Moved verbatim from `docs/QA.md`. The procedure is an opt-in paid study; it does not establish retention or natural-compaction acceptance.

The scenarios **compaction-retrieval-control** and **compaction-retrieval-compacted** investigate retrieval and inference after one manually requested native summary. They require live packaged Electron, Builder and Plan off. They do not establish retention, natural-compaction or automatic-continuation acceptance.

Generate the reviewed six-arm order (control/compacted, compacted/control, control/compacted):

~~~sh
node --input-type=module <<'JS'
import { mkdir, writeFile } from 'node:fs/promises';
import { createQaRetrievalDiagnosticMatrix } from './scripts/qa/compaction-retrieval-diagnostic.mjs';
await mkdir('.cache/qa', { recursive: true });
const config = createQaRetrievalDiagnosticMatrix({
  evidenceRoot: '.cache/qa/retrieval-study',
  providerId: 'xai', modelId: 'grok-4.6', timeoutMs: 1200000,
});
await writeFile('.cache/qa/retrieval-study.json', JSON.stringify(config, null, 2));
JS
DEVRYAN_QA_PACKAGE_EVIDENCE=/absolute/path/to/package-evidence.json \
  bun scripts/qa/run.mjs --config .cache/qa/retrieval-study.json
~~~

Freeze the candidate package, production source and all scripts before starting paid runs. Each arm starts with a fresh owned profile/project/session and the same attachments, diagnosis, revision-2 input and one 256-KiB ordinary audit batch. The runner verifies the saved revised plan, unchanged paused implementation, observed source read and initial native failed test, no prior compaction, and measured usage below the unchanged native threshold. It records differing model-generated plan hashes; mismatched or failed prerequisites remain visible as incomparable arms.

Only the compacted arm sends the actual composer command /compact. Both arms then receive exactly “Continue with the next permitted step from the current state.” A pending question stops the arm without a reply or repair. Question evidence must link the current root assistant and exact pending call; an unresolved historical/unmatched request is classified separately. Provider, native or permission failures remain separate from retrieval evidence. Every arm still receives the normal owned-session cleanup after its evidence and failure screenshot have been captured.

The per-arm retrieval-diagnostic.json preserves canonical summary, tool input/output, exact read/glob/claim ordering, question IDs, before/after saved plans, ordinary input hashes, profile/candidate identity and journal health. Any bounded text truncation is marked. Empty glob output alone is insufficient: a missing-path inference candidate requires a subsequent absence claim, the unchanged saved file, and no successful exact-path recovery. This is human-review triage; a candidate alone records **review-required**, not a proven functional or compaction-induced failure. Questions, changed paused files and repeated completed inspections still fail automated checks.

Aggregate all six records without dropping failed arms:

~~~sh
node --input-type=module <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { summarizeQaRetrievalStudy } from './scripts/qa/compaction-retrieval-diagnostic.mjs';
const root = '.cache/qa/retrieval-study';
const summary = JSON.parse(await readFile(path.join(root, 'summary.json'), 'utf8'));
const arms = [];
for (const run of summary.runs) {
  const result = JSON.parse(await readFile(path.join(run.output, 'result.json'), 'utf8'));
  let diagnostic = null;
  try { diagnostic = JSON.parse(await readFile(path.join(run.output, 'retrieval-diagnostic.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  arms.push({ id: result.cell.id, outcome: run.outcome, diagnostic });
}
await writeFile(path.join(root, 'paired-diagnostic.json'),
  JSON.stringify(summarizeQaRetrievalStudy(arms), null, 2));
JS
~~~

Inspect every captured PNG and the exact claim/read/question evidence. The pair report separates comparable and incomparable states, generic interruptions and compacted-only/control-only/both/neither retrieval candidates. It preserves differing plans and failed matrix outcomes. Its three acceptance flags always remain false, including when all observation checks pass. Human classification is required before attributing any loss to compaction or proposing a retrieval or memory change.
