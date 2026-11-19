#!/usr/bin/env node
// The closure check over the product recording (package C0d): records the
// product families of the port map from the product's own tests (the family
// command, set up for the product), then replays every case against the
// TypeScript modules in file order and alone (replay.mjs). Planted
// differences in copies of the product modules (PRODUCT_PLANTS) must each be
// caught by a named check. Writes only into scratch.
//
//   node scripts/client-conformance/replay-product.mjs [--from=<directory of containers>] [--modes=file,isolated] [--families=a,b] [--json=<file>] [--plants[=a,b]] [--keep-artifacts]
//
// Without --from it records first (two recordings, compared byte for byte, as
// the family command does); a recording that is not clean (its exit code is
// not 0) makes the closure inconclusive. With --plants it also runs the
// planted differences (all, or those named) against the same recording, in
// file order only (a planted difference is deterministic: a case alone adds
// nothing), and prints for each whether its named check caught it. Exit
// codes: as replay.mjs; with --plants, 1 also when a planted difference is
// not caught.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordFamilies } from './family-run.mjs';
import { loadCensus } from './census.mjs';
import { PRODUCT_CENSUS, PRODUCT_PORT_MAP, PRODUCT_SETUP, UI_DIR } from './product.mjs';
import { loadPortMap } from './port-map.mjs';
import { createScratch, EXIT, parseOptions, REPOSITORY_ROOT } from './record.mjs';
import { formatCase, judgeReplay, MODES, planContainers, readContainerDir, readRecording, replayPlanned, reportLines, summarize } from './replay.mjs';
import { typescriptEngine } from './engine.mjs';

const SYNC = 'packages/ui/src/sync';
const LIB = 'packages/ui/src/lib';
/**
 * Planted differences in copies of product modules (design file 29 §4.5,
 * mutants 1 to 6, then this package's own): `file` (repository-relative) is
 * loaded with `anchor` (which must occur exactly once) replaced; `families`
 * are replayed; `expect` is the named check (and kind, and family) that must
 * report it in some case. The file itself is never written.
 */
export const PRODUCT_PLANTS = Object.freeze([
  // Design mutants 1 to 6.
  { name: 'design-1-part-delta-limit-in-utf8-bytes', origin: 'design 1', file: `${SYNC}/part-delta.ts`, families: ['part-delta', 'reducer'],
    anchor: '  if (value.length > MAX_JAMMED_DUPLICATE_SCAN_LENGTH) {', replacement: '  if (Buffer.byteLength(value) > MAX_JAMMED_DUPLICATE_SCAN_LENGTH) {',
    expect: { check: 'result', kind: 'value', family: 'part-delta' } },
  // No part-delta case holds non-ASCII whitespace where part-delta trims (its four trims were each planted): the
  // ASCII-only trim is planted where a recorded case has it, session-working's finish (C0d report, coverage gaps).
  { name: 'design-2-ascii-only-trim', origin: 'design 2 (landed: session-working; part-delta has no such case)', file: `${SYNC}/session-working.ts`, families: ['session-working'],
    anchor: '  const normalized = finish.trim().toLowerCase()\n', replacement: '  const normalized = finish.replace(/^[ \\t\\n\\r]+|[ \\t\\n\\r]+$/g, "").toLowerCase()\n',
    expect: { check: 'result', kind: 'value', family: 'session-working' } },
  { name: 'design-3-reducer-key-moved-to-end', origin: 'design 3', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: '        ...existing,\n        [props.field]: nextValue,', replacement: '        ...Object.fromEntries(Object.entries(existing).filter(([key]) => key !== props.field)),\n        [props.field]: nextValue,',
    expect: { check: 'after', kind: 'key-order', family: 'reducer' } },
  { name: 'design-4-reducer-undefined-as-null', origin: 'design 4', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: 'partDeltaNoParts(props.messageID, props.partID)\n        return {\n          changed: false,\n          materialization: { type: "incomplete-session-snapshot", sessionID, ',
    replacement: 'partDeltaNoParts(props.messageID, props.partID)\n        return {\n          changed: false,\n          materialization: { type: "incomplete-session-snapshot", sessionID: sessionID ?? null, ',
    expect: { check: 'result', kind: 'undefined-null', family: 'reducer' } },
  { name: 'design-5-reducer-clones-one-field-too-many', origin: 'design 5', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: '      draft.todo[props.sessionID] = props.todos\n', replacement: '      draft.todo[props.sessionID] = props.todos\n      draft.session_status = { ...draft.session_status }\n',
    expect: { check: 'change-set', family: 'reducer' } },
  { name: 'design-6-provisional-time-plus-one', origin: 'design 6 (landed: the reducer\'s provisional message, not optimistic)', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: 'const created = getPartStartTime(part) ?? Date.now()', replacement: 'const created = getPartStartTime(part) ?? Date.now() + 1',
    expect: { check: 'after', kind: 'time-oracle', family: 'reducer' } },
  // This package's own.
  { name: 'reducer-mutates-parts-in-place', origin: 'C0d', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: '      // Create new Part object + new array so React detects the change\n      const next = [...parts]', replacement: '      // Create new Part object + new array so React detects the change\n      const next = parts',
    expect: { check: 'change-set', family: 'reducer' } },
  { name: 'reducer-kept-branch-replaced-by-equal-copy', origin: 'C0d', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: '      if (draft.vcs?.branch === props.branch) return false\n', replacement: '      if (draft.vcs?.branch === props.branch) { draft.vcs = { ...draft.vcs }; return false }\n',
    expect: { check: 'change-set', family: 'reducer' } },
  { name: 'reducer-todo-callback-dropped', origin: 'C0d', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: '      callbacks?.onSetSessionTodo?.(props.sessionID, props.todos)\n      return true', replacement: '      return true',
    expect: { check: 'effects', kind: 'missing', family: 'reducer' } },
  { name: 'reducer-todo-callback-gets-a-copy', origin: 'C0d', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: '      callbacks?.onSetSessionTodo?.(props.sessionID, props.todos)\n      return true', replacement: '      callbacks?.onSetSessionTodo?.(props.sessionID, [...props.todos])\n      return true',
    expect: { check: 'effects', kind: 'identity', family: 'reducer' } },
  { name: 'reducer-abort-guard-answer-ignored', origin: 'C0d', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: '      const status = filteredStatus\n', replacement: '      const status = props.status\n',
    expect: { check: 'after', kind: 'members', family: 'reducer' } },
  { name: 'reducer-extra-clock-read', origin: 'C0d', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: 'const created = getPartStartTime(part) ?? Date.now()', replacement: 'const created = getPartStartTime(part) ?? (Date.now(), Date.now())',
    expect: { check: 'halt', kind: 'unanswered', family: 'reducer' } },
  { name: 'reducer-guard-cleared-twice', origin: 'C0d', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: '      const props = event.properties as { sessionID: string }\n      clearAbortGuard(props.sessionID)\n      const status = { type: "idle" } as const\n      if (areSessionStatusesEqual(draft.session_status[props.sessionID], status)) {\n        return false\n      }\n      draft.session_status[props.sessionID] = status\n      return true\n    }\n\n    case "session.error"',
    replacement: '      const props = event.properties as { sessionID: string }\n      clearAbortGuard(props.sessionID)\n      clearAbortGuard(props.sessionID)\n      const status = { type: "idle" } as const\n      if (areSessionStatusesEqual(draft.session_status[props.sessionID], status)) {\n        return false\n      }\n      draft.session_status[props.sessionID] = status\n      return true\n    }\n\n    case "session.error"',
    expect: { check: 'halt', kind: 'unanswered', family: 'reducer' } },
  { name: 'part-delta-full-frame-floor-off-by-one', origin: 'C0d', file: `${SYNC}/part-delta.ts`, families: ['part-delta'],
    anchor: 'const MIN_FULL_FRAME_DUPLICATE_LENGTH = 32', replacement: 'const MIN_FULL_FRAME_DUPLICATE_LENGTH = 33',
    expect: { check: 'result', kind: 'value', family: 'part-delta' } },
  { name: 'part-delta-jammed-scan-limit-off-by-one', origin: 'C0d', file: `${SYNC}/part-delta.ts`, families: ['part-delta'],
    anchor: 'const MAX_JAMMED_DUPLICATE_SCAN_LENGTH = 2_048', replacement: 'const MAX_JAMMED_DUPLICATE_SCAN_LENGTH = 2_047',
    expect: { check: 'result', kind: 'value', family: 'part-delta' } },
  { name: 'message-fetch-limit-off-by-one', origin: 'C0d', file: `${SYNC}/message-fetch.ts`, families: ['message-fetch'],
    anchor: '  return Math.floor(limit)\n', replacement: '  return Math.floor(limit) + 1\n',
    expect: { check: 'result', kind: 'value', family: 'message-fetch' } },
  { name: 'message-order-tie-reversed', origin: 'C0d', file: `${SYNC}/message-order.ts`, families: ['message-order'],
    anchor: 'return timeDelta === 0 ? compareIDs(left.id, right.id) : timeDelta', replacement: 'return timeDelta === 0 ? compareIDs(right.id, left.id) : timeDelta',
    expect: { check: 'result', kind: 'value', family: 'message-order' } },
  { name: 'session-diff-stats-parse-int', origin: 'C0d', file: `${LIB}/sessionDiffStats.ts`, families: ['session-diff-stats'],
    anchor: '    const parsed = Number(value)\n', replacement: '    const parsed = Number.parseInt(value, 10)\n',
    expect: { check: 'result', kind: 'value', family: 'session-diff-stats' } },
  { name: 'tool-status-keeps-hyphens', origin: 'C0d', file: `${LIB}/toolStatus.ts`, families: ['tool-status'],
    anchor: ".replace(/[\\s_-]+/g, '')", replacement: ".replace(/[\\s_]+/g, '')",
    expect: { check: 'result', kind: 'value', family: 'tool-status' } },
  { name: 'session-working-finish-case-kept', origin: 'C0d', file: `${SYNC}/session-working.ts`, families: ['session-working'],
    anchor: '  const normalized = finish.trim().toLowerCase()\n', replacement: '  const normalized = finish.trim()\n',
    expect: { check: 'result', kind: 'value', family: 'session-working' } },
  { name: 'tool-output-equal-part-copied', origin: 'C0d', file: `${SYNC}/tool-output.ts`, families: ['tool-output'],
    anchor: '  return JSON.stringify(restored) === JSON.stringify(existing) ? existing : restored\n', replacement: '  return restored\n',
    expect: { check: 'result', kind: 'identity', family: 'tool-output' } },
  { name: 'revert-failed-transaction-still-hides', origin: 'C0d', file: `${SYNC}/revert-transactions.ts`, families: ['revert-transactions'],
    anchor: '  if (transaction?.status !== "failed" && transaction?.hiddenMessageIDs?.has(messageID)) {', replacement: '  if (transaction?.hiddenMessageIDs?.has(messageID)) {',
    expect: { check: 'result', kind: 'value', family: 'revert-transactions' } },
  { name: 'optimistic-copies-where-it-mutated', origin: 'C0d', file: `${SYNC}/optimistic.ts`, families: ['optimistic'],
    anchor: '      messages.splice(0, messages.length, ...inserted)\n', replacement: '      draft.message[input.sessionID] = inserted\n',
    expect: { check: 'change-set', family: 'optimistic' } },
  { name: 'materialization-order-reversed', origin: 'C0d', file: `${SYNC}/materialization.ts`, families: ['materialization'],
    anchor: '.sort((left, right) => compareMessagesChronologically(left.info, right.info))', replacement: '.sort((left, right) => compareMessagesChronologically(right.info, left.info))',
    expect: { check: 'result', kind: 'value', family: 'materialization' } },
  // C0d fix (the review's S3): a port call moved three macrotasks later is a difference of the cases that make it, and
  // contained to them: no case of the unit is lost (`contained`: none inconclusive).
  { name: 'reducer-todo-callback-three-jobs-later', origin: 'C0d fix', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: '      callbacks?.onSetSessionTodo?.(props.sessionID, props.todos)\n      return true', replacement: '      setImmediate(() => setImmediate(() => setImmediate(() => callbacks?.onSetSessionTodo?.(props.sessionID, props.todos))))\n      return true',
    expect: { check: 'effects', kind: 'missing', family: 'reducer' }, contained: true },
]);

/** The planted copy's source (`anchor` exactly once), or an error naming the plant. */
export function plantedSource(plant, root = REPOSITORY_ROOT) {
  const file = path.join(root, plant.file);
  const source = readFileSync(file, 'utf8');
  const occurrences = source.split(plant.anchor).length - 1;
  if (occurrences !== 1) throw new Error(`planted difference ${plant.name}: its anchor occurs ${occurrences} times in ${plant.file}`);
  return { module: file, source: source.replace(plant.anchor, () => plant.replacement) };
}

/** Whether `result` (a replay of the plant's families) holds the difference the plant must cause. */
export function plantCaught(plant, result) {
  const { check, kind, family } = plant.expect;
  return result.cases.some((kase) => (!family || kase.family === family) && Object.values(kase.modes).some((entry) => entry.outcome === 'different'
    && entry.differences.some((difference) => difference.check === check && (kind === undefined || difference.kind === kind))));
}

/**
 * Runs each plant (all, or `only`) against the containers of `directory`:
 * a copy written into `workDir` for the record, its families replayed in file
 * order with the copy loaded in place of the module; `parallel` plants at a
 * time, each on an engine of its own. Resolves, in list order,
 * `[{ plant, caught, differences, inconclusive, error? }]`.
 */
export async function runProductPlants({ directory, workDir, only = null, plants = PRODUCT_PLANTS, concurrency, parallel = 3 }) {
  const portMap = loadPortMap(PRODUCT_PORT_MAP, { root: REPOSITORY_ROOT });
  const list = plants.filter((plant) => !only || only.includes(plant.name));
  const containers = readContainerDir(directory);
  const results = new Array(list.length);
  const run = async (plant) => {
    try {
      const planted = plantedSource(plant);
      const copy = path.join(workDir, 'plants', plant.name, plant.file);
      mkdirSync(path.dirname(copy), { recursive: true });
      writeFileSync(copy, planted.source);
      const planned = planContainers(containers, portMap, { families: plant.families });
      const result = await replayPlanned(planned, { engine: typescriptEngine({ cwd: UI_DIR }), modes: ['file'], plants: [planted], concurrency });
      const differences = result.cases.filter((kase) => kase.outcome === 'different').map(formatCase);
      const inconclusive = [...planned.problems, ...result.problems].map((problem) => problem.detail).concat(result.cases.filter((kase) => kase.outcome === 'inconclusive').map(formatCase));
      // A contained plant must leave every case judged: one it loses would hide the cases after it.
      const caught = plantCaught(plant, result) && (!plant.contained || inconclusive.length === 0);
      return { plant, caught, differences, inconclusive };
    } catch (error) {
      return { plant, caught: false, differences: [], inconclusive: [], error: String(error?.stack ?? error) };
    }
  };
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, list.length)) }, async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      results[index] = await run(list[index]);
    }
  }));
  return results;
}

/** The families a product closure must judge: those asked for, or every family of the map the census does not waive as untested. */
export function requiredFamilies(portMap, families = null) {
  const waived = new Set(loadCensus(PRODUCT_CENSUS).families.map((item) => item.family));
  return (families ?? portMap.families.map((family) => family.name)).filter((name) => !waived.has(name));
}

/** Records the product families into `out` (scratch); resolves the family command's `{ code, report }`. */
export async function recordProduct({ workDir, out, families = null }) {
  return recordFamilies({ setup: PRODUCT_SETUP, runs: 2, families, workDir, out, parallel: PRODUCT_SETUP.parallel });
}

export async function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  const usage = 'usage: replay-product.mjs [--from=<directory of containers>] [--modes=file,isolated] [--families=a,b] [--json=<file>] [--plants[=a,b]] [--concurrency=N] [--keep-artifacts]';
  const parsed = parseOptions(argv, { flags: ['keep-artifacts', 'plants'], values: ['from', 'modes', 'families', 'json', 'plants', 'concurrency'] });
  if (parsed.error || parsed.positionals.length) { error(`${parsed.error ?? 'no positional arguments'}\n${usage}`); return EXIT.usage; }
  const { options } = parsed;
  const modes = options.modes ? options.modes.split(',').filter(Boolean) : [...MODES];
  if (modes.length === 0 || modes.some((mode) => !MODES.includes(mode))) { error(`--modes takes ${MODES.join(', ')}\n${usage}`); return EXIT.usage; }
  const families = options.families ? options.families.split(',').filter(Boolean) : null;
  const plantNames = options.plants === undefined ? null : options.plants === '' || options.plants === true ? [] : String(options.plants).split(',').filter(Boolean);
  for (const name of plantNames ?? []) if (!PRODUCT_PLANTS.some((plant) => plant.name === name)) { error(`--plants: no planted difference ${name}\n${usage}`); return EXIT.usage; }
  const concurrency = options.concurrency !== undefined ? Number(options.concurrency) : undefined;
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) { error(`--concurrency must be a positive integer\n${usage}`); return EXIT.usage; }
  const scratch = createScratch('client-conformance-replay-product', { keepArtifacts: options['keep-artifacts'] === true });
  let status = 'failed';
  try {
    let directory = options.from ? path.resolve(options.from) : null;
    const recordingProblems = [];
    if (!directory) {
      directory = path.join(scratch.dir, 'containers');
      const recorded = await recordProduct({ workDir: path.join(scratch.dir, 'record'), out: directory, families });
      log(`recording: exit ${recorded.code}; ${recorded.report.cases} cases, ${recorded.report.steps} steps (${recorded.report.outcomes.recorded} recorded, ${recorded.report.outcomes.unrecordable} unrecordable, ${recorded.report.outcomes.inconclusive} inconclusive), ${recorded.report.unstableCases.length} unstable, ${recorded.report.files} files`);
      if (recorded.code !== EXIT.pass) recordingProblems.push({ check: 'recording', detail: `the product recording exited ${recorded.code}: ${[...recorded.report.incomplete.map((entry) => entry.detail), ...recorded.report.failures.map((entry) => entry.detail)].slice(0, 5).join('; ')}` });
    }
    const portMap = loadPortMap(PRODUCT_PORT_MAP, { root: REPOSITORY_ROOT });
    // The directory must be what its recording's manifest lists (manifest.mjs), whether recorded here or given.
    const recording = readRecording(directory, portMap, { families });
    const planned = planContainers(recording.list, portMap, { families });
    const result = await replayPlanned(planned, { engine: typescriptEngine({ cwd: UI_DIR }), modes, concurrency });
    result.problems.unshift(...recordingProblems, ...recording.problems, ...planned.problems);
    const verdict = judgeReplay(result, { modes, requireFamilies: [...new Set([...requiredFamilies(portMap, families), ...recording.requireFamilies])].sort() });
    for (const line of verdict.inconclusive) error(`inconclusive: ${line}`);
    for (const line of verdict.failures) error(`different: ${line}`);
    for (const line of reportLines(result, verdict, modes)) log(line);
    let code = verdict.code;
    let plants = null;
    if (plantNames !== null) {
      plants = await runProductPlants({ directory, workDir: scratch.dir, only: plantNames.length ? plantNames : null, concurrency });
      for (const entry of plants) {
        log(`planted ${entry.plant.name}: ${entry.caught ? `caught by ${entry.plant.expect.check}${entry.plant.expect.kind ? `/${entry.plant.expect.kind}` : ''}` : 'NOT caught'}; ${entry.differences.length} cases differ${entry.error ? `; error: ${entry.error}` : ''}${entry.inconclusive.length ? `; ${entry.inconclusive.length} inconclusive` : ''}`);
        if (!entry.caught) for (const line of entry.differences.slice(0, 3)) log(`  ${line.slice(0, 600)}`);
      }
      if (code === EXIT.pass && plants.some((entry) => !entry.caught)) code = EXIT.fail;
      log(`${plants.filter((entry) => entry.caught).length}/${plants.length} planted differences caught by their named check`);
    }
    if (options.json) writeFileSync(options.json, `${JSON.stringify({ code, families: summarize(result.cases, modes), verdict, cases: result.cases, plants: plants?.map((entry) => ({ name: entry.plant.name, caught: entry.caught, differences: entry.differences.slice(0, 5), inconclusive: entry.inconclusive.slice(0, 5), error: entry.error ?? null })) ?? null }, null, 2)}\n`);
    status = code === EXIT.pass ? 'passed' : 'failed';
    return code;
  } finally {
    scratch.finish(status);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
