// The judgement and the coverage census of a candidate engine (package C0g;
// design file 29 §4.1, §4.4): what a run of the candidate comparer exits
// with, and per family, per export, port and event type, how many cases a
// candidate is judged on against how many are recorded only. Pure functions
// over the replayer's results, the planned containers and the waiver files:
// no engine, no process.
//
// Outcomes per case (the replayer's): `reproduced` and `different` are
// judged; `inconclusive` could not be judged; `unrecordable`, `no-reference`
// (recorded unstable, or a test that failed) and `not-replayable` are as
// recorded, never judged. Exit codes, as every tool of the harness: 0 only
// for a complete run (the whole recording, in every mode) with no difference
// in which every case that is not judged is waived by name and what is judged
// is what the contract pins; 1 a difference, a census item no judged case
// exercises and no waiver names, a pin the run does not meet, or a stale
// waiver; 2 an unstable case (as recorded, or one an engine judged two ways
// in two runs) no waiver names; 3 inconclusive (a case not judged that no
// waiver names by its test, a problem, nothing judged, a family with no
// judged case, a recording that did not pass its own checks, a run that
// skipped part of the judgement: part of a recording, or some modes only).
// A run that skipped part of the judgement is never 0: not asked for, it is
// inconclusive by a line naming what it skipped; asked for (`--partial`),
// what it judged decides 1 or 2 as usual, and where that passed it is 3 and
// says `partial` (its skipped part listed in `partial`), so no step that
// reads only the exit code takes it for a complete pass. Precedence:
// inconclusive, then unstable, then fail, then a partial run asked for.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readContainer } from './container.mjs';
import { judgeUnrecordable, judgeUnstable } from './census.mjs';

export const EXIT = Object.freeze({ pass: 0, fail: 1, unstable: 2, inconclusive: 3, usage: 64 });
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const ITEM_KINDS = Object.freeze(['export', 'port', 'event', 'family']);
const UNJUDGED_OUTCOMES = Object.freeze(['not-replayable', 'no-reference']);

export const CONTRACT_VERSION = 2;
/**
 * Reads the candidate census contract (version 2): `judged`, what a
 * candidate is judged on today, per family `{ cases, exports, ports, events
 * }` (the number of cases it reproduces and the names of the items they
 * exercise), so an item that silently loses its judged cases, or a family
 * that loses judged cases, fails (a ratchet: a complete run must meet it
 * exactly, `candidate-judged-*`); `items`, census items a candidate is not
 * judged on, each `{ family, kind: export|port|event|family, name?, reason }`
 * (`family` waives every item of the family); `unjudged`, cases not judged
 * for another reason than being unrecordable or unstable (those are the
 * recording census's waivers), each `{ family, outcome, file?, tests?, reason
 * }`. Every waiver needs a reason. Throws on anything else.
 */
export function loadContract(file) {
  const fail = (message) => { throw new Error(`client-conformance candidate census ${path.basename(file)}: ${message}`); };
  let contract;
  try { contract = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { fail(`cannot be read: ${error.message}`); }
  if (!isObject(contract) || contract.version !== CONTRACT_VERSION) fail(`version must be ${CONTRACT_VERSION}`);
  for (const key of Object.keys(contract)) if (!['version', 'note', 'judged', 'items', 'unjudged'].includes(key)) fail(`unknown member ${key}`);
  if (!isObject(contract.judged)) fail('judged must pin, per family, the cases and items a candidate is judged on');
  const names = (list) => Array.isArray(list) && list.every((name) => typeof name === 'string' && name) && new Set(list).size === list.length;
  for (const [family, pin] of Object.entries(contract.judged)) {
    if (!isObject(pin) || Object.keys(pin).some((key) => !['cases', 'exports', 'ports', 'events'].includes(key))) fail(`judged ${family}: only cases, exports, ports and events`);
    if (!Number.isInteger(pin.cases) || pin.cases < 0 || !names(pin.exports) || !names(pin.ports) || !names(pin.events)) fail(`judged ${family}: cases a count, exports, ports and events lists of distinct names`);
  }
  for (const list of ['items', 'unjudged']) if (contract[list] !== undefined && !Array.isArray(contract[list])) fail(`${list} must be a list`);
  for (const [index, item] of (contract.items ?? []).entries()) {
    if (!isObject(item)) fail(`items ${index} must be an object`);
    for (const key of Object.keys(item)) if (!['family', 'kind', 'name', 'reason'].includes(key)) fail(`items ${index} has unknown member ${key}`);
    if (typeof item.family !== 'string' || !item.family || !ITEM_KINDS.includes(item.kind)) fail(`items ${index}: family and a kind (${ITEM_KINDS.join(', ')}) are required`);
    if ((item.kind === 'family') !== (item.name === undefined) || (item.name !== undefined && (typeof item.name !== 'string' || !item.name))) fail(`items ${index}: a family waiver names no item, every other one names its item`);
    if (typeof item.reason !== 'string' || !item.reason.trim()) fail(`items ${index}: every waiver needs a reason`);
  }
  for (const [index, item] of (contract.unjudged ?? []).entries()) {
    if (!isObject(item)) fail(`unjudged ${index} must be an object`);
    for (const key of Object.keys(item)) if (!['family', 'outcome', 'file', 'tests', 'reason'].includes(key)) fail(`unjudged ${index} has unknown member ${key}`);
    if (typeof item.family !== 'string' || !item.family || !UNJUDGED_OUTCOMES.includes(item.outcome)) fail(`unjudged ${index}: family and an outcome (${UNJUDGED_OUTCOMES.join(', ')}) are required`);
    if (item.file !== undefined && (typeof item.file !== 'string' || !item.file)) fail(`unjudged ${index}: file must be a path`);
    if (item.tests !== undefined && (!Array.isArray(item.tests) || !item.tests.length || item.tests.some((name) => typeof name !== 'string' || !name))) fail(`unjudged ${index}: tests must be a list of test names`);
    if (typeof item.reason !== 'string' || !item.reason.trim()) fail(`unjudged ${index}: every waiver needs a reason`);
  }
  return { file, judged: contract.judged, items: contract.items ?? [], unjudged: contract.unjudged ?? [] };
}

/** The cases of a run with their recorded records, in the replayer's order (its cases follow the planned containers). */
export function casesWithRecords(run) {
  const out = [];
  let at = 0;
  for (const container of run.planned.containers) {
    for (const item of container.cases) {
      const kase = run.result.cases[at];
      at += 1;
      if (!kase || kase.id !== item.record.id || kase.container !== container.name) throw new Error(`the replayer's cases do not follow the planned containers at ${container.name} ${item.record.id}`);
      out.push({ kase, record: item.record, container });
    }
  }
  if (at !== run.result.cases.length) throw new Error(`the replayer reported ${run.result.cases.length} cases for ${at} planned`);
  return out;
}

/** The test file of a case (its recorded `file`) and its bare test name. */
const testOf = (record) => ({ file: record.file, name: record.name });

/**
 * The cases a run did not judge, decided by name: unrecordable ones by the
 * recording census's `unrecordable` waivers (every flag of the case covered
 * by a waiver of its file, its test and that flag, and of its family when the
 * waiver names one), a `real-transport` case only with that flag alone and no
 * steps; recorded unstable ones by its `unstable` waivers; not replayable
 * ones by the contract's `unjudged`. Returns `{ inconclusive, unstable,
 * stale, waived }` (lists of lines; `waived` counts by reason).
 */
export function judgeUnjudged(entries, { recordingCensus, contract, complete = true, scope = null }) {
  const inconclusive = [];
  const unstable = [];
  const waived = { unrecordable: 0, unstable: 0, 'not-replayable': 0 };
  const unrecordable = [];
  const unstableCases = [];
  const used = new Set();
  for (const { kase, record } of entries) {
    if (kase.outcome === 'unrecordable') {
      const flags = record.flags ?? [];
      if (!flags.length) { inconclusive.push(`${record.id}: unrecordable with no flag, which no waiver can name`); continue; }
      if (flags.includes('real-transport') && (flags.length !== 1 || (record.steps ?? []).length !== 0)) inconclusive.push(`${record.id}: a real-transport case must carry that flag alone and no steps (flags ${flags.join(', ')}, ${(record.steps ?? []).length} steps)`);
      unrecordable.push({ check: 'unrecordable', ...testOf(record), case: record.id, flags });
      continue;
    }
    if (kase.outcome === 'no-reference') {
      if (record.outcome === 'unstable') unstableCases.push({ case: record.id });
      else inconclusive.push(`${record.id}: recorded ${record.outcome} (${record.reason ?? 'no reference'}), which no waiver can stand for`);
      continue;
    }
    if (kase.outcome === 'not-replayable') {
      const index = contract.unjudged.findIndex((item) => item.outcome === 'not-replayable' && item.family === kase.family && (item.file === undefined || item.file === record.file) && (item.tests === undefined || item.tests.includes(record.name)));
      if (index < 0) { inconclusive.push(`${record.id}: not replayable (${kase.reason}), and no unjudged waiver of the candidate census names its family and test`); continue; }
      used.add(index);
      waived['not-replayable'] += 1;
    }
  }
  const judgedUnrecordable = judgeUnrecordable(unrecordable, recordingCensus, { complete: false });
  for (const entry of judgedUnrecordable.remaining) inconclusive.push(`${entry.case}: unrecordable (${entry.flags.join(', ')}), and no unrecordable waiver names its test and every flag`);
  waived.unrecordable = judgedUnrecordable.waived.length;
  const judgedUnstable = judgeUnstable(unstableCases, recordingCensus, { complete: false });
  for (const entry of judgedUnstable.remaining) unstable.push(`${entry.case}: recorded unstable, and no unstable waiver names its file and family`);
  waived.unstable = judgedUnstable.waived.length;
  const stale = [];
  if (complete) {
    contract.unjudged.forEach((item, index) => {
      if (scope !== null && !scope.includes(item.family)) return;
      if (!used.has(index)) stale.push(`candidate-waiver-stale: the unjudged waiver of ${item.family} (${item.outcome}${item.file ? `, ${item.file}` : ''}${item.tests ? `, ${item.tests.length} tests` : ''}) matched no case: remove it`);
    });
  }
  return { inconclusive, unstable, stale, waived };
}

/** The base export a step input names: `x` for `x`, `x#2`, `x#2.next`; a store action counts as itself and its store. */
const exportsOf = (entry) => {
  const base = String(entry).split('#')[0].split('.')[0];
  return /^[^#.]+(?:\.[^#.]+)+$/.test(entry) ? [base, entry] : [base];
};
const plainOf = (node) => {
  const tag = isObject(node) ? node.$dr : undefined;
  if (tag === 'id') return plainOf(node.value);
  if (tag === 'escape' || tag === 'nullproto' || tag === 'class') return node.value;
  return node;
};

/**
 * What every case of a run exercises, as the recording census reads it: the
 * exports its steps call, the ports its effects use (a port's members and
 * answers count as the port; a data port a module took when it loaded counts
 * for every case of its container), the event types its event sources were
 * handed. Yields `{ family, kind, name }` per item and case.
 */
function itemsOfCase(record, container, { eventSources, resolve }) {
  const found = new Map();
  const add = (kind, name) => found.set(`${kind}\0${name}`, { kind, name });
  for (const name of Object.keys(container.header.load?.portData ?? {})) add('port', name);
  for (const step of record.steps ?? []) {
    const { input } = step;
    if (['call', 'new', 'get'].includes(input.kind) && typeof input.entry === 'string') {
      for (const name of exportsOf(input.entry)) add('export', name);
      const source = eventSources.get(input.entry);
      if (source && input.args !== undefined) {
        const args = plainOf(resolve(input.args));
        const event = Array.isArray(args) ? plainOf(args[source.arg]) : null;
        if (isObject(event) && typeof event.type === 'string') add('event', event.type);
      }
    }
    for (const effect of step.effects ?? []) if (['port', 'new', 'read'].includes(effect.kind) && typeof effect.port === 'string') add('port-use', effect.port);
  }
  return [...found.values()];
}

/**
 * The census of a candidate: `entries` are a run's cases with their records
 * (casesWithRecords); `universe` the items per family the recording's census
 * judges (`{ family: { exports, ports, events } }`, from its manifest, or
 * null: then the items the cases show and the map's ports); `portMap` the
 * map; `recordingCensus` its census file (event sources, and its waivers of
 * items no recorded case exercises); `contract` the candidate census. An item
 * no case the candidate reproduced exercises fails (`candidate-item-unjudged`)
 * unless the recording census waives it (it is then exercised by no recorded
 * case, for the reason given there) or the contract does; a contract waiver
 * of an item a reproduced case exercises fails (`candidate-waiver-judged`),
 * one of an item the census does not know fails (`candidate-waiver-stale`).
 * Returns `{ failures, families }`, `families` the counts per family and item.
 */
export function candidateCensus({ entries, universe = null, portMap, recordingCensus, contract, scope = null, complete = true }) {
  const inScope = (name) => scope === null || scope.includes(name);
  const families = {};
  const rowOf = (family) => {
    if (!families[family]) {
      const ports = [];
      for (const [, target] of portMap.modules) for (const [, port] of target.ports) if (port.families.includes(family)) ports.push(port.name);
      const given = universe?.[family];
      families[family] = { cases: { total: 0, judged: 0, different: 0, inconclusive: 0, recordedOnly: 0, unrecordable: {} }, items: new Map() };
      const row = families[family];
      for (const name of given?.exports ?? []) row.items.set(`export\0${name}`, null);
      for (const name of given?.ports ?? ports) row.items.set(`port\0${name}`, null);
      for (const name of given?.events ?? []) row.items.set(`event\0${name}`, null);
    }
    return families[family];
  };
  for (const family of portMap.families) if (inScope(family.name)) rowOf(family.name);
  const blank = () => ({ judged: 0, different: 0, inconclusive: 0, recordedOnly: 0, recorded: 0, unrecordable: {} });
  for (const { kase, record, container } of entries) {
    if (!inScope(kase.family)) continue;
    const row = rowOf(kase.family);
    const eventSources = new Map(recordingCensus.events.filter((item) => item.family === kase.family).map((item) => [item.entry, item]));
    const cases = row.cases;
    cases.total += 1;
    const flags = record.flags ?? [];
    const bump = (counts) => {
      if (record.outcome === 'recorded') counts.recorded += 1;
      if (kase.outcome === 'reproduced') counts.judged += 1;
      else if (kase.outcome === 'different') counts.different += 1;
      else if (kase.outcome === 'inconclusive') counts.inconclusive += 1;
      else if (kase.outcome === 'unrecordable') for (const flag of flags) counts.unrecordable[flag] = (counts.unrecordable[flag] ?? 0) + 1;
      else counts.recordedOnly += 1;
    };
    if (kase.outcome === 'reproduced') cases.judged += 1;
    else if (kase.outcome === 'different') cases.different += 1;
    else if (kase.outcome === 'inconclusive') cases.inconclusive += 1;
    else if (kase.outcome === 'unrecordable') for (const flag of flags) cases.unrecordable[flag] = (cases.unrecordable[flag] ?? 0) + 1;
    else cases.recordedOnly += 1;
    const familyPorts = [...row.items.keys()].filter((key) => key.startsWith('port\0')).map((key) => key.slice(5));
    const seen = new Set();
    for (const { kind, name } of itemsOfCase(record, container, { eventSources, resolve: container.reader.resolve })) {
      // A port's members and answers (`<port>.<member>`, `<port>#<call>`) count as the port.
      const keys = kind === 'port-use' ? familyPorts.filter((port) => name === port || name.startsWith(`${port}.`) || name.startsWith(`${port}#`)).map((port) => `port\0${port}`) : [`${kind}\0${name}`];
      for (const key of keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        if (!row.items.get(key)) row.items.set(key, blank());
        bump(row.items.get(key));
      }
    }
  }
  const failures = [];
  const recordingWaiver = (family, kind, name) => {
    const whole = recordingCensus.families.find((item) => item.family === family);
    if (whole) return whole.reason;
    const list = kind === 'export' ? recordingCensus.exports.filter((item) => item.export === name) : kind === 'port' ? recordingCensus.ports.filter((item) => item.port === name) : recordingCensus.eventTypes.filter((item) => item.type === name);
    return list.find((item) => item.family === family)?.reason ?? null;
  };
  const usedContract = new Set();
  const out = {};
  for (const [family, row] of Object.entries(families)) {
    const summary = { cases: row.cases, exports: { total: 0, judged: 0, waived: 0, failed: 0 }, ports: { total: 0, judged: 0, waived: 0, failed: 0 }, events: { total: 0, judged: 0, waived: 0, failed: 0 }, items: {} };
    out[family] = summary;
    for (const [key, counts] of [...row.items].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const [kind, name] = key.split('\0');
      const group = summary[`${kind}s`];
      const use = counts ?? blank();
      group.total += 1;
      const contractIndex = contract.items.findIndex((item) => item.family === family && (item.kind === 'family' || (item.kind === kind && item.name === name)));
      const item = { ...use, status: null, reason: null };
      summary.items[`${kind} ${name}`] = item;
      if (use.judged > 0) {
        group.judged += 1;
        item.status = 'judged';
        // A family waiver stands only for the items no reproduced case exercises: one that covers none is stale (below).
        if (contractIndex >= 0 && contract.items[contractIndex].kind !== 'family') { usedContract.add(contractIndex); failures.push({ check: 'candidate-waiver-judged', family, name: `${kind} ${name}`, detail: `${kind} ${name} of ${family} is waived in the candidate census ("${contract.items[contractIndex].reason}") but ${use.judged} reproduced cases exercise it: remove the waiver` }); }
        continue;
      }
      const recording = recordingWaiver(family, kind, name);
      if (recording !== null && use.recorded === 0) { group.waived += 1; item.status = 'waived by the recording census'; item.reason = recording; continue; }
      if (contractIndex >= 0) { usedContract.add(contractIndex); group.waived += 1; item.status = 'waived by the candidate census'; item.reason = contract.items[contractIndex].reason; continue; }
      if (!complete) { item.status = 'not judged (chosen files)'; continue; }
      group.failed += 1;
      item.status = 'unjudged';
      const unrecordable = Object.entries(use.unrecordable).map(([flag, count]) => `${flag} ${count}`).join(', ');
      failures.push({ check: 'candidate-item-unjudged', family, name: `${kind} ${name}`, detail: `${kind} ${name} of ${family} is exercised by no case the candidate reproduced (recorded in ${use.recorded}, recorded only ${use.recordedOnly}, different ${use.different}, inconclusive ${use.inconclusive}${unrecordable ? `, unrecordable: ${unrecordable}` : ''}) and no waiver names it` });
    }
  }
  if (complete) failures.push(...checkPins(out, contract, { scope }));
  if (complete) {
    contract.items.forEach((item, index) => {
      if (!inScope(item.family) || usedContract.has(index)) return;
      const known = families[item.family] && (item.kind === 'family' || families[item.family].items.has(`${item.kind}\0${item.name}`));
      if (!known) failures.push({ check: 'candidate-waiver-stale', family: item.family, name: item.name ?? '(family)', detail: `the candidate census waives ${item.kind}${item.name ? ` ${item.name}` : ''} of ${item.family}, which this recording's census does not have: remove the waiver` });
      else if (item.kind === 'family') failures.push({ check: 'candidate-waiver-stale', family: item.family, name: '(family)', detail: `the candidate census waives family ${item.family}, but every item of it is judged or waived by the recording census: remove the waiver` });
    });
  }
  return { failures, families: out };
}

/**
 * The contract's pins against a complete run's census (`families` as
 * candidateCensus summarises them): per family in scope, the reproduced
 * cases must be the pinned count, and the items they exercise the pinned
 * names, neither fewer (`candidate-judged-lost`: an item or cases lost their
 * judgement) nor more (`candidate-judged-unpinned`: pin them); a pin of a
 * family the run's port maps do not have is stale.
 */
export function checkPins(families, contract, { scope = null, known = null } = {}) {
  const failures = [];
  const judgedNames = (row, kind) => Object.entries(row.items).filter(([key, item]) => key.startsWith(`${kind} `) && item.status === 'judged').map(([key]) => key.slice(kind.length + 1)).sort();
  for (const [family, row] of Object.entries(families)) {
    if (scope !== null && !scope.includes(family)) continue;
    const pin = contract.judged[family];
    const judged = { exports: judgedNames(row, 'export'), ports: judgedNames(row, 'port'), events: judgedNames(row, 'event') };
    if (!pin) {
      if (row.cases.judged || Object.values(judged).some((list) => list.length)) failures.push({ check: 'candidate-judged-unpinned', family, name: '(family)', detail: `${family} has ${row.cases.judged} judged cases (${judged.exports.length} exports, ${judged.ports.length} ports, ${judged.events.length} event types judged) and the candidate census pins none: add its pin` });
      continue;
    }
    if (row.cases.judged < pin.cases) failures.push({ check: 'candidate-judged-lost', family, name: '(cases)', detail: `${family}: ${row.cases.judged} cases judged, ${pin.cases} pinned: ${pin.cases - row.cases.judged} cases lost their judgement` });
    if (row.cases.judged > pin.cases) failures.push({ check: 'candidate-judged-unpinned', family, name: '(cases)', detail: `${family}: ${row.cases.judged} cases judged, ${pin.cases} pinned: raise the pin` });
    for (const [kind, list] of Object.entries(judged)) {
      const word = kind.slice(0, -1);
      for (const name of pin[kind]) if (!list.includes(name)) failures.push({ check: 'candidate-judged-lost', family, name: `${word} ${name}`, detail: `${word} ${name} of ${family} is pinned as judged and no case the candidate reproduced exercises it` });
      for (const name of list) if (!pin[kind].includes(name)) failures.push({ check: 'candidate-judged-unpinned', family, name: `${word} ${name}`, detail: `${word} ${name} of ${family} is judged and not pinned: add it` });
    }
  }
  if (known) for (const family of Object.keys(contract.judged)) if (!known.has(family) && (scope === null || scope.includes(family))) failures.push({ check: 'candidate-waiver-stale', family, name: '(pin)', detail: `the candidate census pins ${family}, which no port map of the run has: remove the pin` });
  return failures;
}

/**
 * Judges a candidate run: `runs` `[{ label, result, planned, expected?,
 * requireFamilies?, repeats? }]` (`result` the replayer's, `expected` its
 * fixtures, `repeats` the results of the same run made again); `verdicts`
 * the replayer's own judgement of each result (its judgeReplay: the
 * judged cases' differences, inconclusive cases and problems, fixtures,
 * nothing judged, families without a judged case); `census` the candidate
 * census's result; `unjudged` judgeUnjudged's; `problems` lines that make the
 * run inconclusive (a recording that did not pass its own checks, say);
 * `partial` the lines of a run that skipped part of the judgement and was
 * not asked to, `asked` those of one asked for with `--partial`. Returns `{
 * code, failures, inconclusive, unstable, partial }`: `partial` the asked
 * lines (what a passing partial run skipped, for its last line).
 */
export function judgeCandidate({ verdicts, census, unjudged, problems = [], repeats = [], partial = [], asked = [] }) {
  // A run that skipped part of the judgement (part of a recording, or some modes only) is never a pass (S2 of the C0g
  // reviews): not asked for, it is inconclusive by its `partial` lines; asked for, it is judged on what it holds and,
  // where that passes, exits inconclusive too, so an exit code alone never takes it for a complete pass.
  const inconclusive = [...problems, ...partial, ...verdicts.flatMap((verdict) => verdict.inconclusive), ...unjudged.inconclusive];
  const unstable = [...unjudged.unstable, ...repeats];
  const failures = [...verdicts.flatMap((verdict) => verdict.failures), ...census.failures.map((item) => `${item.check}: ${item.detail}`), ...unjudged.stale];
  const code = inconclusive.length ? EXIT.inconclusive : unstable.length ? EXIT.unstable : failures.length ? EXIT.fail : asked.length ? EXIT.inconclusive : EXIT.pass;
  return { code, failures, inconclusive, unstable, partial: [...asked] };
}

/**
 * Cases an engine judged two ways in two runs of the same recording (its
 * outcome, or the check, kind, step and path of its first difference, in a
 * mode): each a line, unstable (the engine is not deterministic on it).
 */
export function repeatDifferences(results) {
  const lines = [];
  const signature = (entry) => (entry ? `${entry.outcome} ${entry.differences?.[0] ? `${entry.differences[0].check}/${entry.differences[0].kind} ${entry.differences[0].step} ${entry.differences[0].path}` : ''}` : '(not run)');
  const [first, ...rest] = results;
  for (const [index, kase] of first.cases.entries()) {
    for (const [run, other] of rest.entries()) {
      const again = other.cases[index];
      for (const mode of new Set([...Object.keys(kase.modes), ...Object.keys(again?.modes ?? {})])) {
        const a = signature(kase.modes[mode]);
        const b = signature(again?.modes?.[mode]);
        if (a !== b) lines.push(`${kase.id} (${mode}): run 1 judged it ${a}, run ${run + 2} ${b}`);
      }
    }
  }
  return lines;
}

/** Reads a container list (`{ name, text }`) only far enough to give each case's record (the toys' universe needs none). */
export const recordsOf = (list) => list.flatMap(({ text }) => readContainer(text).cases);

/** One line per family of a candidate census: its cases and its items, judged against total. */
export function censusLines(census) {
  const lines = [];
  for (const [family, row] of Object.entries(census.families).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const part = (name) => `${name} ${row[name].judged}/${row[name].total} judged${row[name].waived ? ` (${row[name].waived} waived)` : ''}${row[name].failed ? `, ${row[name].failed} unjudged` : ''}`;
    const unrecordable = Object.entries(row.cases.unrecordable).sort(([a], [b]) => (a < b ? -1 : 1)).map(([flag, count]) => `${flag} ${count}`).join(', ');
    lines.push(`census ${family}: ${row.cases.total} cases, ${row.cases.judged} judged, ${row.cases.recordedOnly} recorded only, ${row.cases.different} different, ${row.cases.inconclusive} inconclusive${unrecordable ? `, unrecordable by flag: ${unrecordable}` : ''}; ${part('exports')}; ${part('ports')}; ${part('events')}`);
  }
  return lines;
}
