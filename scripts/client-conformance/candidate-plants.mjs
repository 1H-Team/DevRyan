// Planted faults in the candidate comparer (package C0g): each a copy of this
// directory (mutants.mjs buildMutant: exact anchored replacements, each
// anchor occurring once) with one fault in the comparer, its census, its
// judgement or its command, which must fail the self-test check it names
// (candidate-checks.mjs) and no other part need. The unchanged copy passes
// every check a plant names (the control: without it a copy that cannot load
// would pass for a caught plant). `origin` says whose: the package's own
// (C0g, re-anchored to protocol 5 in its fix round), the review's (C0g
// review: its 39, less those protocol 5 has no place for, CANDIDATE_RETIRED),
// the fix round's own, the second review's six (C0g review 2, its S1) or the
// second fix round's own. PER_PUSH_PLANTS run per push, one of the
// comparer's, the census's and the command's judgement; the rest in the full
// suite. Its subjects are the toys only.
import { cpSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildMutant } from './mutants.mjs';
import { HARNESS_DIR } from './record.mjs';

const CC = 'candidate-compare.mjs';
const RC = 'replay-compare.mjs';
const CN = 'candidate-census.mjs';
const CM = 'candidate.mjs';
const CENSUS = 'census.mjs';
const CODE = 'const code = inconclusive.length ? EXIT.inconclusive : unstable.length ? EXIT.unstable : failures.length ? EXIT.fail : asked.length ? EXIT.inconclusive : EXIT.pass;';
const PENDING_KEYS = "    for (const key of ['timer', 'repeat', 'step', 'group']) if (left[key] !== right[key])";
const OPENED_COMPARED = "    if (!found.some((item) => item.check === 'effects') && (Object.prototype.hasOwnProperty.call(expected, 'openedAt') || Object.prototype.hasOwnProperty.call(actual, 'openedAt')) && expected.openedAt !== actual.openedAt) {";
const GROUP_COMPARED = "    if ((Object.prototype.hasOwnProperty.call(expected, 'group') || Object.prototype.hasOwnProperty.call(actual, 'group')) && expected.group !== actual.group) {";
const SETTLED = "    const settled = recorded.steps[index]?.input?.kind === 'settle';";
const CLOCK_SCOPE = '  layout.groups.forEach((members, at) => { if (members.every((index) => uniform(steps[index]))) free.add(at + 1); });';
const REST = '    const { openedAt: given, returnedAt: returned, effects: _effects, group: _group, ...rest } = step;';
const SEQUENCE = '  const sequenceOf = (group) => sequences[group - 1] ?? [];';
const GROUP_EFFECTS = '    out.effects = first.has(index) ? (free ? sequence.filter((item) => !isClock(item)) : [...sequence]) : [];';
const POSITIONS = '    if (openedAt !== undefined && !(settled && settleFree)) out.openedAt = position(openedAt);\n    if (returnedAt !== undefined) out.returnedAt = position(returnedAt);';
const VIEWS = "  const result = compareReplayed(candidateView(recorded, recorded, 'recorded', options), candidateView(recorded, replayed, 'replayed', options), { unordered });";
const IS_CLOCK = "const isClock = (item) => item?.kind === 'clock';";
const dropMember = (key, check, origin = 'C0g', name = `cc-${key}-dropped`) => ({ name, origin, file: CC, anchor: REST, replacement: REST.replace('...rest }', `${key}: _planted, ...rest }`), check, what: `a compared part dropped: ${key}` });
const stripEffect = (name, kind, keys, check) => ({ name, origin: 'C0g review', file: CC, anchor: SEQUENCE, replacement: `  const sequenceOf = (group) => (sequences[group - 1] ?? []).map((item) => (item?.kind === '${kind}' ? Object.fromEntries(Object.entries(item).filter(([key]) => !${JSON.stringify(keys)}.includes(key))) : item));`, check, what: `the ${keys.join(' and ')} of a ${kind} effect not compared (S1 of the review)` });
const widen = (label, kind, check) => ({ name: `r-clock-freedom-widened-to-${label}`, origin: 'C0g review', file: CC, anchor: IS_CLOCK, replacement: `const isClock = (item) => item?.kind === 'clock' || item?.kind === '${kind}';`, check, what: `the clock freedom widened to ${kind} effects` });

/** Each plant: the file and anchor (and `also`), what it plants, and the check of candidate-checks.mjs that must fail. */
export const CANDIDATE_PLANTS = Object.freeze([
  // The comparer's views: the order, the boundaries, the positions, the freedoms widened, compared parts dropped.
  { name: 'cc-attribution-compared', origin: 'C0g', file: CC, anchor: '    if (recordedGroup === undefined || recordedGroup >= exactFrom) {', replacement: '    if (true) {', check: 'reshaped-reproduced', what: 'a group compared step by step, the recorder\'s attribution required (the C0f review S6 requirement undone)' },
  { name: 'cc-group-boundaries-ignored', origin: 'C0g', file: CC, anchor: GROUP_EFFECTS, replacement: '    out.effects = index === 0 ? sequences.flat().filter((item) => !free || !isClock(item)) : [];', check: 'outside-group-leak', what: 'the groups\' sequences compared as one: an effect moved into another group passes' },
  { name: 'cc-sync-part-not-pinned', origin: 'C0g', file: CC, anchor: POSITIONS, replacement: '', check: 'outside-sync-across-members', what: 'the steps\' opening and return positions not compared: a synchronous effect moved into another step passes' },
  { name: 'cc-group-order-ignored', origin: 'C0g', file: CC, anchor: GROUP_EFFECTS, replacement: GROUP_EFFECTS.replace('(free ? sequence.filter((item) => !isClock(item)) : [...sequence])', '(free ? sequence.filter((item) => !isClock(item)) : [...sequence]).sort((a, b) => (`${a.kind}${a.port}${a.source}` < `${b.kind}${b.port}${b.source}` ? -1 : `${a.kind}${a.port}${a.source}` > `${b.kind}${b.port}${b.source}` ? 1 : 0))'), check: 'outside-async-reordered', what: 'a group\'s effects compared as a set, not in order' },
  { name: 'cc-present-ignored', origin: 'C0g', file: CC, anchor: '  let exactFrom = present < recorded.steps.length ? layout.groupOf[present] + 1 : Infinity;', replacement: '  let exactFrom = Infinity;', check: 'compared-step-count', what: 'a group the engine did not report whole compared as a sequence: the missing step is reported as another difference' },
  { name: 'cc-clock-free-where-reads-vary', origin: 'C0g', file: CC, anchor: '      else if (known !== value) return false;', replacement: '      else if (known !== value) continue;', check: 'outside-clock-varying-dropped', what: 'the clock freedom widened to a group whose reads of one source returned two values' },
  { name: 'cc-draws-dropped-as-clocks', origin: 'C0g', file: CC, anchor: IS_CLOCK, replacement: "const isClock = (item) => item?.kind === 'clock' || item?.kind === 'draw';", check: 'outside-draw-dropped', what: 'the clock freedom widened to draws, which are inputs taken in order' },
  { name: 'cc-clock-positions-unadjusted', origin: 'C0g', file: CC, anchor: '    const position = (value) => (free && Number.isInteger(value) ? recount(mine, value) : value);', replacement: '    const position = (value) => value;', check: 'reshaped-reproduced', what: 'clock reads dropped without recounting the opening and return positions' },
  { name: 'cc-pending-named-by-step', origin: 'C0g', file: CC, anchor: '    const pending = pendingByGroup(side.end?.pending, recorded.steps, layout.groupOf);', replacement: '    const pending = side.end?.pending ?? [];', check: 'reshaped-reproduced', what: 'a pending timer named by its step, not its group' },
  { name: 'cc-time-oracle-off', origin: 'C0g', file: CC, anchor: "    if (time !== null && times.has(time) && !times.has(numberOf(actual))) return { ...item, kind: 'time-oracle'", replacement: "    if (false && time !== null && times.has(time) && !times.has(numberOf(actual))) return { ...item, kind: 'time-oracle'", check: 'outside-clock-time-shifted', what: 'a stored time that is no supplied time reported as a plain value (the time oracle lost with the clock reads)' },
  { name: 'cc-candidate-rules-never-applied', origin: 'C0g', file: CC, anchor: "  if (rules === 'exact') return { ...exact, rules, exact: exact.differences.length, freedoms: [] };", replacement: '  return { ...exact, rules, exact: exact.differences.length, freedoms: [] };', check: 'reshaped-reproduced', what: 'the candidate rules never applied: a non-JavaScript engine judged by the exact ones' },
  { name: 'cc-views-asymmetric', origin: 'C0g', file: CC, anchor: "  const clockFree = freedoms.includes('clock') ? clockFreeGroups(layout, recorded.steps) : new Set();", replacement: "  const clockFree = freedoms.includes('clock') && kind === 'recorded' ? clockFreeGroups(layout, recorded.steps) : new Set();", check: 'views-equal-on-exact-pairs', what: 'the two sides cut differently (the clock freedom applied to the recording only)' },
  dropMember('returns', 'compared-returns'),
  dropMember('after', 'compared-after'),
  dropMember('state', 'compared-state'),
  { name: 'cc-identity-ignored', origin: 'C0g', file: CC, anchor: VIEWS, replacement: '  const strip = (view) => JSON.parse(JSON.stringify(view).replace(/\\{"\\$dr":"ref","n":\\d+\\}/g, \'{"$dr":"ref","n":0}\'));\n' + VIEWS.replace("candidateView(recorded, recorded, 'recorded', options)", "strip(candidateView(recorded, recorded, 'recorded', options))").replace("candidateView(recorded, replayed, 'replayed', options)", "strip(candidateView(recorded, replayed, 'replayed', options))"), check: 'compared-identity', what: 'identity ignored: every later sight of an object taken for any object' },
  { name: 'cc-pending-ignored', origin: 'C0g', file: CC, anchor: '  return { ...side, steps: view };', replacement: '  return { ...side, steps: view, pending: [] };', also: [{ file: CC, anchor: '    return { ...side, steps: view, end: side.end ? { ...side.end, ...(side.end.pending ? { pending } : {}) } : side.end };', replacement: '    return { ...side, steps: view, end: side.end ? { ...side.end, pending: [] } : side.end };' }], check: 'compared-pending-timers', what: 'the timers pending at a case\'s end ignored (C0e)' },
  // The fix round's own: the groups' cut (B1), the settled answer's free position kept free only for it.
  { name: 'fix-later-input-joins-its-delivery', origin: 'C0g fix', file: RC, anchor: '    const sameGroup = delivery !== null && (step.input.together === true ||', replacement: '    const sameGroup = delivery !== null && (true ||', check: 'groups-cut', what: 'B1 of the review: a test call held in a delivery but given once the engine ran out kept in the group before it' },
  { name: 'fix-later-input-joins-its-delivery-b1-case', origin: 'C0g fix', file: RC, anchor: '    const sameGroup = delivery !== null && (step.input.together === true ||', replacement: '    const sameGroup = delivery !== null && (true ||', check: 'outside-async-past-later-input', what: 'B1 of the review, by its planted engine: an effect moved past such a call passes' },
  { name: 'fix-every-opening-free', origin: 'C0g fix', file: CC, anchor: POSITIONS, replacement: '    if (openedAt !== undefined && !settleFree) out.openedAt = position(openedAt);\n    if (returnedAt !== undefined) out.returnedAt = position(returnedAt);', check: 'compared-open-position', what: 'the group freedom widened to every step\'s opening position, not a settled answer\'s alone' },
  { name: 'fix-group-number-ignored', origin: 'C0g fix', file: RC, anchor: GROUP_COMPARED, replacement: '    if (false) {', check: 'compared-group', what: 'which group a step is in not compared' },
  // The C0g review 2's (its S1): six ways the comparer could get weaker that no check pinned, each now with its own.
  { name: 'n-nested-positions-free', origin: 'C0g review 2', file: CC, anchor: SETTLED, replacement: SETTLED.replace("=== 'settle';", "=== 'settle' || recorded.steps[index]?.input?.during !== undefined;"), check: 'compared-nested-open-position', what: 'a nested input\'s opening freed as if it were a settled answer\'s' },
  { name: 'n-opening-compared-only-if-both', origin: 'C0g review 2', file: RC, anchor: OPENED_COMPARED, replacement: OPENED_COMPARED.replace("'openedAt') || Object", "'openedAt') && Object"), check: 'compared-open-position-omitted', what: 'a step\'s opening compared only when the engine reports one' },
  { name: 'n-extra-engine-groups-ignored', origin: 'C0g review 2', file: CC, anchor: "  if (kind !== 'recorded' && sequences.length > layout.sequences.length && view.length) {", replacement: '  if (false) {', check: 'compared-extra-group', what: 'effects in a group the recording does not have not compared' },
  { name: 'n-group-compared-only-if-both', origin: 'C0g review 2', file: RC, anchor: GROUP_COMPARED, replacement: GROUP_COMPARED.replace("'group') || Object", "'group') && Object"), check: 'compared-group-omitted', what: 'a step\'s group compared only when the engine reports one' },
  { name: 'n-clock-free-if-any-step-uniform', origin: 'C0g review 2', file: CC, anchor: CLOCK_SCOPE, replacement: CLOCK_SCOPE.replace('members.every(', 'members.some('), check: 'outside-clock-varying-dropped', what: 'the clock freedom held in a group where any one step is uniform, not every step (the check caught it in 2 of 5 runs before it chose its cases by id: S4)' },
  { name: 'n-pending-group-not-compared', origin: 'C0g review 2', file: RC, anchor: PENDING_KEYS, replacement: PENDING_KEYS.replace(", 'group']", ']'), check: 'compared-pending-group', what: 'a pending timer\'s group not compared' },
  // Fix round 2's own: a run judged in some modes only taken as whole, a partial run asked for exiting 0, a container
  // of another recording version read.
  { name: 'fix2-modes-subset-whole', origin: 'C0g fix 2', file: CM, anchor: '  const missingModes = MODES.filter((mode) => !modes.includes(mode));', replacement: '  const missingModes = [];', check: 'judge-modes-partial', what: 'a run judged in file order only (or alone only) taken for a complete one' },
  { name: 'fix2-partial-asked-exits-0', origin: 'C0g fix 2', file: CN, anchor: CODE, replacement: CODE.replace('asked.length ? EXIT.inconclusive', 'asked.length ? EXIT.pass'), check: 'judge-partial-asked', what: 'a partial run asked for exits 0, like a complete pass' },
  { name: 'fix2-recording-version-unchecked', origin: 'C0g fix 2', file: 'replay.mjs', anchor: '    if (header.recording !== RECORDING) {', replacement: '    if (false) {', check: 'recording-version-refused', what: 'a container of another recording version read by this recording\'s rules' },
  // The review's (its "My plants", re-planted on the protocol-5 code where the code they changed still exists).
  { name: 'r-nested-inputs-own-group', origin: 'C0g review', file: RC, anchor: '      const at = outer !== undefined && groupOf[outer] !== undefined ? groupOf[outer] : groups.length - 1;', replacement: '      const at = -1;', check: 'groups-cut', what: 'an input nested in a port call put in a group of its own' },
  widen('global-reads', 'read', 'compared-read-value'),
  widen('notify', 'notify', 'compared-notify-state'),
  widen('timer-set', 'timer.set', 'compared-timer-delay'),
  widen('settled', 'settled', 'compared-settled-value'),
  widen('port', 'port', 'compared-port-answer'),
  { name: 'r-time-oracle-swallowed', origin: 'C0g review', file: CC, anchor: '  return { differences, stepsCompared: result.stepsCompared };', replacement: "  return { differences: differences.filter((item) => item.kind !== 'time-oracle'), stepsCompared: result.stepsCompared };", check: 'outside-clock-time-shifted', what: 'a time-oracle difference dropped' },
  { name: 'r-freedoms-never-reported', origin: 'C0g review', file: CC, anchor: "    if (!freedoms.length) freedoms = ['group'];\n", replacement: '    freedoms = [];\n', check: 'freedoms-reported', what: 'a case only a freedom reproduces says nothing of it' },
  { name: 'r-exact-shortcut-below-3', origin: 'C0g review', file: CC, anchor: '  if (!exact.differences.length) return { differences: [], stepsCompared: exact.stepsCompared, rules, exact: 0, freedoms: [] };', replacement: '  if (exact.differences.length < 3) return { differences: [], stepsCompared: exact.stepsCompared, rules, exact: 0, freedoms: [] };', check: 'outside-async-reordered', what: 'a case the exact rules find one or two differences in taken as reproduced' },
  { name: 'r-joined-deduplicated', origin: 'C0g review', file: CC, anchor: GROUP_EFFECTS, replacement: GROUP_EFFECTS.replace('(free ? sequence.filter((item) => !isClock(item)) : [...sequence])', '(free ? sequence.filter((item) => !isClock(item)) : [...sequence]).filter((item, at, all) => all.findIndex((other) => JSON.stringify({ ...other, call: 0 }) === JSON.stringify({ ...item, call: 0 })) === at)'), check: 'outside-continuation-duplicated', what: 'a group\'s sequence deduplicated: a request sent twice passes (S1)' },
  { name: 'r-group-whole-case-when-any-hold', origin: 'C0g review', file: RC, anchor: '    if (!holds.has(index)) delivery = null;', replacement: '    if (!holds.size) delivery = null;', check: 'groups-cut', what: 'a whole case one delivery when any step is held' },
  dropMember('throws', 'compared-throws', 'C0g review', 'f-step-throws-dropped'),
  dropMember('stateChanges', 'compared-state-changes', 'C0g review', 'f-state-changes-dropped'),
  dropMember('changes', 'compared-change-set', 'C0g review', 'f-change-set-dropped'),
  dropMember('input', 'compared-input', 'C0g review', 'f-input-dropped'),
  stripEffect('f-notify-states-dropped', 'notify', ['state', 'previous'], 'compared-notify-state'),
  stripEffect('f-timer-delay-dropped', 'timer.set', ['delay', 'repeat'], 'compared-timer-delay'),
  stripEffect('f-port-answers-dropped', 'port', ['answer', 'throws'], 'compared-port-answer'),
  stripEffect('f-settled-values-dropped', 'settled', ['value', 'outcome'], 'compared-settled-value'),
  // The judgement of unjudged cases and the exit code.
  { name: 'cn-unrecordable-unwaived-passes', origin: 'C0g', file: CN, anchor: '  for (const entry of judgedUnrecordable.remaining) inconclusive.push(', replacement: '  for (const entry of []) inconclusive.push(', check: 'judge-unrecordable-unwaived', what: 'an unjudged (unrecordable) case no waiver names exits 0' },
  { name: 'cn-unrecordable-first-flag-only', origin: 'C0g', file: CN, anchor: "      unrecordable.push({ check: 'unrecordable', ...testOf(record), case: record.id, flags });", replacement: "      unrecordable.push({ check: 'unrecordable', ...testOf(record), case: record.id, flags: flags.slice(0, 1) });", check: 'judge-unrecordable-every-flag', what: 'a case waived when its first flag is' },
  { name: 'census-waiver-by-file-only', origin: 'C0g', file: CENSUS, anchor: 'testsOf(waiver).includes(entry.name) && (!', replacement: 'true && (!', check: 'judge-unrecordable-by-name', what: 'an unrecordable waiver that covers any test of its file, not the test it names' },
  { name: 'cn-real-transport-with-company', origin: 'C0g', file: CN, anchor: "      if (flags.includes('real-transport') && (flags.length !== 1", replacement: "      if (false && flags.includes('real-transport') && (flags.length !== 1", check: 'judge-real-transport-alone', what: 'a real-transport case with another flag or with steps accepted' },
  { name: 'cn-not-replayable-passes', origin: 'C0g', file: CN, anchor: '      if (index < 0) { inconclusive.push(', replacement: '      if (index < -1) { inconclusive.push(', check: 'judge-not-replayable-unwaived', what: 'a case not replayable that no waiver names exits 0' },
  { name: 'cn-recorded-inconclusive-passes', origin: 'C0g', file: CN, anchor: '      else inconclusive.push(`${record.id}: recorded ${record.outcome}', replacement: '      else if (false) inconclusive.push(`${record.id}: recorded ${record.outcome}', check: 'judge-recorded-inconclusive', what: 'a case whose test failed taken as judged nowhere and waived' },
  { name: 'cn-unjudged-stale-ignored', origin: 'C0g', file: CN, anchor: '      if (!used.has(index)) stale.push(', replacement: '      if (false) stale.push(', check: 'judge-unjudged-stale', what: 'a waiver of unjudged cases that matches none kept' },
  { name: 'cn-difference-exits-0', origin: 'C0g', file: CN, anchor: CODE, replacement: CODE.replace('failures.length ? EXIT.fail', 'failures.length ? EXIT.pass'), check: 'judge-difference', what: 'a difference exits 0' },
  { name: 'cn-inconclusive-exits-0', origin: 'C0g', file: CN, anchor: CODE, replacement: CODE.replace('inconclusive.length ? EXIT.inconclusive', 'inconclusive.length ? EXIT.pass'), check: 'judge-inconclusive-case', what: 'an unjudged (inconclusive) case exits 0' },
  { name: 'cn-unstable-not-2', origin: 'C0g', file: CN, anchor: CODE, replacement: CODE.replace('unstable.length ? EXIT.unstable : ', ''), check: 'judge-unstable-unwaived', what: 'an unstable case no waiver names does not exit 2' },
  { name: 'cn-precedence-unstable-over-inconclusive', origin: 'C0g', file: CN, anchor: CODE, replacement: 'const code = unstable.length ? EXIT.unstable : inconclusive.length ? EXIT.inconclusive : failures.length ? EXIT.fail : asked.length ? EXIT.inconclusive : EXIT.pass;', check: 'judge-precedence-inconclusive', what: 'unstable taking precedence over inconclusive' },
  { name: 'cn-repeat-ignored', origin: 'C0g', file: CN, anchor: '  const unstable = [...unjudged.unstable, ...repeats];', replacement: '  const unstable = [...unjudged.unstable];', check: 'judge-repeat', what: 'an engine that judged a case two ways in two runs passes' },
  { name: 'cn-partial-passes', origin: 'C0g fix', file: CN, anchor: '  const inconclusive = [...problems, ...partial, ', replacement: '  const inconclusive = [...problems, ', check: 'judge-partial-unasked', what: 'S2 of the review: a run of part of a recording, not asked for, exits 0' },
  { name: 'c-unjudged-waiver-any-family', origin: 'C0g review', file: CN, anchor: "item.outcome === 'not-replayable' && item.family === kase.family && ", replacement: "item.outcome === 'not-replayable' && ", check: 'judge-not-replayable-unwaived', what: 'a not-replayable waiver covering any family' },
  { name: 'c-unjudged-waiver-tests-ignored', origin: 'C0g review', file: CN, anchor: ' && (item.tests === undefined || item.tests.includes(record.name)));', replacement: ');', check: 'judge-not-replayable-by-test', what: 'a not-replayable waiver covering any test of its family (S4)' },
  { name: 'c-real-transport-steps-ignored', origin: 'C0g review', file: CN, anchor: '(flags.length !== 1 || (record.steps ?? []).length !== 0)', replacement: '(flags.length !== 1)', check: 'judge-real-transport-without-steps', what: 'a real-transport case with steps accepted (S4)' },
  { name: 'c-flagless-unrecordable-waivable', origin: 'C0g review', file: CN, anchor: "      if (!flags.length) { inconclusive.push(`${record.id}: unrecordable with no flag, which no waiver can name`); continue; }\n", replacement: '', check: 'judge-unrecordable-flagless', what: 'an unrecordable case with no flag waived vacuously (S4)' },
  { name: 'c-repeat-outcome-only', origin: 'C0g review', file: CN, anchor: "  const signature = (entry) => (entry ? `${entry.outcome} ${entry.differences?.[0] ? `${entry.differences[0].check}/${entry.differences[0].kind} ${entry.differences[0].step} ${entry.differences[0].path}` : ''}` : '(not run)');", replacement: "  const signature = (entry) => (entry ? `${entry.outcome}` : '(not run)');", check: 'judge-repeat-other-difference', what: 'a case different in both runs by different first differences not unstable (S4)' },
  // The census.
  { name: 'cn-item-unjudged-passes', origin: 'C0g', file: CN, anchor: "      failures.push({ check: 'candidate-item-unjudged',", replacement: "      void ({ check: 'candidate-item-unjudged',", check: 'census-item-unjudged', what: 'an item with no judged case and no waiver passes' },
  { name: 'cn-waiver-of-judged-item-kept', origin: 'C0g', file: CN, anchor: "usedContract.add(contractIndex); failures.push({ check: 'candidate-waiver-judged',", replacement: "usedContract.add(contractIndex); void ({ check: 'candidate-waiver-judged',", check: 'census-waiver-judged', what: 'a waiver of an item reproduced cases exercise kept' },
  { name: 'cn-stale-waiver-kept', origin: 'C0g', file: CN, anchor: "      if (!known) failures.push({ check: 'candidate-waiver-stale',", replacement: "      if (false) failures.push({ check: 'candidate-waiver-stale',", check: 'census-waiver-stale', what: 'a waiver of an item the census does not have kept' },
  { name: 'cn-unrecordable-counted-judged', origin: 'C0g', file: CN, anchor: "      if (kase.outcome === 'reproduced') counts.judged += 1;", replacement: "      if (kase.outcome === 'reproduced' || kase.outcome === 'unrecordable') counts.judged += 1;", check: 'census-unrecordable-is-not-judged', what: 'an unrecordable case counted as judging the items it exercises' },
  { name: 'cn-recording-waiver-covers-recorded', origin: 'C0g', file: CN, anchor: '      if (recording !== null && use.recorded === 0) {', replacement: '      if (recording !== null) {', check: 'census-recording-waiver-needs-unexercised', what: 'a recording census waiver standing for an item recorded cases exercise' },
  { name: 'c-different-counts-as-judged', origin: 'C0g review', file: CN, anchor: "      if (kase.outcome === 'reproduced') counts.judged += 1;", replacement: "      if (kase.outcome === 'reproduced' || kase.outcome === 'different') counts.judged += 1;", check: 'census-different-is-not-judged', what: 'a case the candidate differs on counted as judging its items (M7: now seen by name, not only by the exit code)' },
  { name: 'c-contract-item-kind-ignored', origin: 'C0g review', file: CN, anchor: "(item.kind === 'family' || (item.kind === kind && item.name === name)));", replacement: "(item.kind === 'family' || item.name === name));", check: 'census-waiver-kind', what: 'a waiver matched by name whatever its kind (M7: now seen by a waiver of another kind)' },
  { name: 'c-family-waiver-never-stale', origin: 'C0g review', file: CN, anchor: "      else if (item.kind === 'family') failures.push({ check: 'candidate-waiver-stale',", replacement: "      else if (false) failures.push({ check: 'candidate-waiver-stale',", check: 'census-family-waiver-stale', what: 'a family waiver that covers nothing kept' },
  { name: 'fix-pins-unchecked', origin: 'C0g fix', file: CN, anchor: '  if (complete) failures.push(...checkPins(out, contract, { scope }));\n', replacement: '', check: 'census-judged-lost', what: 'the contract\'s pins never checked: an item that loses its judged cases passes' },
  { name: 'fix-pinned-cases-floor-ignored', origin: 'C0g fix', file: CN, anchor: '    if (row.cases.judged < pin.cases) failures.push(', replacement: '    if (false) failures.push(', check: 'census-judged-cases-lost', what: 'a family that lost judged cases passes its pin' },
  { name: 'fix-unpinned-judged-item-passes', origin: 'C0g fix', file: CN, anchor: '      for (const name of list) if (!pin[kind].includes(name)) failures.push(', replacement: '      for (const name of []) if (!pin[kind].includes(name)) failures.push(', check: 'census-judged-unpinned', what: 'a judged item the pin does not name passes (the pin no longer exact)' },
  { name: 'fix-stale-pin-kept', origin: 'C0g fix', file: CM, anchor: "    for (const family of Object.keys(contract.judged)) if (!known.has(family)) census.failures.push(", replacement: "    for (const family of []) if (!known.has(family)) census.failures.push(", check: 'census-judged-pin-stale', what: 'a pin of a family no port map has kept' },
  // The command's judgement.
  { name: 'cm-fixtures-dropped', origin: 'C0g', file: CM, anchor: '    verdicts.push(judgeReplay(run.result, { modes, expected: run.expected ?? [],', replacement: '    verdicts.push(judgeReplay(run.result, { modes, expected: [],', check: 'judge-fixture-reproduced', what: 'the fixtures that must differ not judged' },
  { name: 'cm-census-failures-dropped', origin: 'C0g', file: CM, anchor: '    census.failures.push(...counted.failures);\n', replacement: '', check: 'census-item-unjudged', what: 'the census\'s failures not counted in the exit code' },
  { name: 'cm-nothing-judged-passes', origin: 'C0g', file: CM, anchor: 'requireFamilies: run.requireFamilies ?? [] }));', replacement: 'requireFamilies: run.requireFamilies ?? [], requireJudged: false }));', check: 'judge-nothing-judged', what: 'a run that judged nothing exits 0' },
  { name: 'cm-families-not-required', origin: 'C0g', file: CM, anchor: 'requireFamilies: run.requireFamilies ?? [] }));', replacement: 'requireFamilies: [] }));', check: 'judge-family-without-judged-case', what: 'a family that must be judged and has no judged case passes' },
  { name: 'm-verdict-code-ignored', origin: 'C0g review', file: CM, anchor: '  if (manifest?.verdict && manifest.verdict.code !== EXIT.pass) problems.push(', replacement: '  if (false) problems.push(', check: 'directory-verdict-required', what: 'a recording that did not pass its own checks taken as a reference' },
  { name: 'm-items-not-required', origin: 'C0g review', file: CM, anchor: '  if (manifest && !manifest.items) problems.push(', replacement: '  if (false) problems.push(', check: 'directory-items-required', what: 'a manifest without census items accepted (S3)' },
  { name: 'fix-items-of-one-family-enough', origin: 'C0g fix', file: CM, anchor: '  if (manifest?.items) for (const family of Object.keys(manifest.families ?? {})) if (!manifest.items[family]) problems.push(', replacement: '  if (false) for (const family of Object.keys(manifest.families ?? {})) if (!manifest.items[family]) problems.push(', check: 'directory-items-every-family', what: 'S3 of the review: `items: {}` or items of some families only accepted' },
  { name: 'm-from-never-complete', origin: 'C0g review', file: CM, anchor: '  const complete = manifest?.scope === null && families === null;', replacement: '  const complete = false;', check: 'directory-complete', what: 'a directory run never judged complete (S4)' },
  { name: 'fix-from-always-complete', origin: 'C0g fix', file: CM, anchor: '  const complete = manifest?.scope === null && families === null;', replacement: '  const complete = true;', check: 'directory-scope-is-partial', what: 'S2 of the review: a directory whose manifest names a scope judged complete' },
  { name: 'm-from-families-not-required', origin: 'C0g review', file: CM, anchor: '  return { problems, complete, requireFamilies: [...new Set([...recording.requireFamilies, ...requireAlso])].sort(), universe: manifest?.items ?? null };', replacement: '  return { problems, complete, requireFamilies: [], universe: manifest?.items ?? null };', check: 'directory-families-required', what: 'a family with recorded cases and no judged case passes a directory run (S4)' },
  { name: 'm-repeat-runs-once', origin: 'C0g review', file: CM, anchor: '  for (let run = 0; run < repeat; run += 1) results.push(', replacement: '  for (let run = 0; run < 1; run += 1) results.push(', check: 'judge-repeat-runs', what: '--repeat=N running once (S4)' },
  // The command itself (process checks).
  { name: 'cm-difference-mapped-to-0', origin: 'C0g', file: CM, anchor: '    return outcome.code;\n', replacement: '    return outcome.code === 1 ? 0 : outcome.code;\n', check: 'command-reshaped-exact', process: true, what: 'the command exits 0 on a difference' },
  { name: 'cm-rules-option-ignored', origin: 'C0g', file: CM, anchor: 'candidateToys({ workDir: scratch.dir, engine, rules, ', replacement: "candidateToys({ workDir: scratch.dir, engine, rules: 'exact', ", check: 'command-reshaped-toys', process: true, what: 'the command judges by the exact rules whatever --rules says' },
  { name: 'm-toy-fixtures-not-required', origin: 'C0g review', file: CM, anchor: 'portMap: replayMap, expected: REPLAY_FIXTURES },', replacement: 'portMap: replayMap },', check: 'command-typescript-toys', process: true, what: 'the toys\' fixtures that must differ not required' },
  { name: 'i-manifest-verdict-not-written', origin: 'C0g review', file: 'manifest.mjs', anchor: '  if (verdict) manifest.verdict = ', replacement: '  if (false) manifest.verdict = ', check: 'command-directory', process: true, what: 'the family command\'s verdict not written into the manifest' },
  { name: 'fix-partial-option-ignored', origin: 'C0g fix', file: CM, anchor: 'families, engine, rules, modes, repeat, concurrency, deadlineMs, partial: options.partial === true });', replacement: 'families, engine, rules, modes, repeat, concurrency, deadlineMs, partial: false });', check: 'command-partial-asked', process: true, what: 'a partial run asked for with --partial still inconclusive' },
]);

/**
 * The review's plants (C0g review, "My plants") that protocol 5 has no place
 * for, each with why: the code they changed is gone, and what it did has no
 * counterpart a fault could change, or the plant is equivalent.
 */
export const CANDIDATE_RETIRED = Object.freeze([
  { name: 'r-joined-into-first-member', why: 'equivalent in protocol 4 already (the review, M7); in protocol 5 no member list is joined: a group\'s sequence is the engine\'s own' },
  { name: 'r-last-member-sync-dropped', why: 'protocol 5 has no per-member effect lists: a step\'s synchronous part is its positions in the group\'s sequence (cc-sync-part-not-pinned, fix-every-opening-free)' },
  { name: 'r-groups-cut-from-each-side', why: 'both views take their cut from the one layout of the recorded case (candidateView `layout`); the engine\'s own cut is data, each step\'s `group`, compared by check `groups` (fix-group-number-ignored)' },
  { name: 'i-census-items-lose-an-export', why: 'a family command plant, not the comparer\'s: mutants.mjs c0g-fix-census-items-lose-an-export, caught by familychecks.mjs family-out' },
  { name: 'i-manifest-verdict-always-0', why: 'a family command plant: mutants.mjs c0g-fix-manifest-verdict-always-0, caught by familychecks.mjs family-out' },
]);

/** The review's 39 plants by name: each is planted here, retired above, or a family command plant of mutants.mjs (origin `C0g fix:`). */
export const REVIEW_PLANTS = Object.freeze([
  'r-nested-inputs-own-group', 'r-joined-into-first-member', 'r-last-member-sync-dropped', 'r-clock-freedom-widened-to-global-reads', 'r-clock-freedom-widened-to-notify',
  'r-clock-freedom-widened-to-timer-set', 'r-clock-freedom-widened-to-settled', 'r-clock-freedom-widened-to-port', 'r-time-oracle-swallowed', 'r-freedoms-never-reported',
  'r-exact-shortcut-below-3', 'r-joined-deduplicated', 'r-groups-cut-from-each-side', 'r-group-whole-case-when-any-hold',
  'f-step-throws-dropped', 'f-state-changes-dropped', 'f-change-set-dropped', 'f-input-dropped', 'f-notify-states-dropped', 'f-timer-delay-dropped', 'f-port-answers-dropped', 'f-settled-values-dropped',
  'c-unjudged-waiver-any-family', 'c-unjudged-waiver-tests-ignored', 'c-real-transport-steps-ignored', 'c-flagless-unrecordable-waivable', 'c-repeat-outcome-only', 'c-different-counts-as-judged', 'c-contract-item-kind-ignored', 'c-family-waiver-never-stale',
  'm-verdict-code-ignored', 'm-items-not-required', 'm-from-never-complete', 'm-from-families-not-required', 'm-toy-fixtures-not-required', 'm-repeat-runs-once',
  'i-census-items-lose-an-export', 'i-manifest-verdict-always-0', 'i-manifest-verdict-not-written',
]);

/** The plants the per-push self-test runs: one of the comparer's, the census's and the command's judgement (pure checks only). */
export const PER_PUSH_PLANTS = Object.freeze(['cc-group-order-ignored', 'cn-difference-exits-0', 'cm-census-failures-dropped']);

/**
 * Runs each plant (all, or `only`) and the unchanged control. `captured` is
 * candidate-checks.mjs capture's (made once by the unchanged harness);
 * `recording` the replayer's toys. Resolves `{ control, plants: [{ plant,
 * caught, problem, error? }] }`.
 */
export async function runCandidatePlants(given, { captured, recording, only = null } = {}) {
  mkdirSync(given, { recursive: true });
  const scratch = realpathSync(given);
  const list = CANDIDATE_PLANTS.filter((plant) => !only || only.includes(plant.name));
  const checksOf = async (harnessDir, names, workDir) => {
    const module = await import(pathToFileURL(path.join(harnessDir, 'candidate-checks.mjs')).href);
    const pure = names.filter((name) => !name.startsWith('command-'));
    const command = names.filter((name) => name.startsWith('command-'));
    const out = new Map();
    if (pure.length) for (const [name, problem] of await module.candidateChecks({ harnessDir, captured, only: pure })) out.set(name, problem);
    if (command.length) {
      // A command run reads the toy corpus from its own copy: the copy is given the repository's tracked one.
      cpSync(path.join(HARNESS_DIR, 'toy', 'expected'), path.join(harnessDir, 'toy', 'expected'), { recursive: true });
      for (const [name, problem] of await module.commandChecks({ harnessDir, workDir, recording, only: command })) out.set(name, problem);
    }
    return out;
  };
  const names = [...new Set(list.map((plant) => plant.check))];
  const { harnessDir: controlDir } = buildMutant({ name: 'control' }, scratch);
  const control = await checksOf(controlDir, names, path.join(scratch, 'control-work'));
  const results = [];
  for (const plant of list) {
    try {
      const { harnessDir } = buildMutant(plant, scratch);
      const found = await checksOf(harnessDir, [plant.check], path.join(scratch, `${plant.name}-work`));
      const problem = found.get(plant.check);
      results.push({ plant, caught: problem !== undefined && problem !== null, problem: problem ?? null });
    } catch (error) {
      results.push({ plant, caught: false, problem: null, error: String(error?.stack ?? error) });
    }
  }
  return { control: [...control], plants: results };
}
