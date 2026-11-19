// Outcomes, waivers, exit codes and the report of a backend conformance run
// (BH0; design file 31 §8.2).
//
// Every row ends in exactly one outcome:
//   passed        an eligible row, and the candidate equals the reference
//   failed        any difference; the candidate died or refused the protocol
//   inconclusive  the row could not be compared in full
//   unstable      the reference against a second reference differs
//   unrecordable  the reference against the JavaScript candidate adapter differs,
//                 or the reference is not linearisable
// Exit codes:
//   0   every row passed or waived, and at least one row passed
//   1   any failed row (a failure is never waivable)
//   2   anything else not waived: an inconclusive, unstable or unrecordable row,
//       a census gap, a waiver that waives nothing, or zero rows
//   64  refused: a usage error, outside the isolation guard, an output path refused
// The last line of the report prints every count, whatever the verdict.

export const OUTCOMES = Object.freeze(['passed', 'failed', 'inconclusive', 'unstable', 'unrecordable']);
/** Outcomes a waiver may cover, each with the reason it names; a failure is never waivable. */
export const WAIVABLE = Object.freeze(['inconclusive', 'unstable', 'unrecordable']);
export const EXIT = Object.freeze({ passed: 0, failed: 1, incomplete: 2, refused: 64 });

const ROW_ID = /^[a-z0-9][a-z0-9._:/@=-]*$/i;

/**
 * Checks rows: each needs a unique id and a known outcome. Malformed input is
 * a harness defect, so it throws (the caller reports it and exits 1).
 */
export function validateRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new TypeError('a row must be an object');
    if (typeof row.id !== 'string' || !ROW_ID.test(row.id)) throw new TypeError(`row id ${JSON.stringify(row.id)} is not a plain identifier`);
    if (seen.has(row.id)) throw new TypeError(`row id ${row.id} appears twice`);
    seen.add(row.id);
    if (!OUTCOMES.includes(row.outcome)) throw new TypeError(`row ${row.id} has unknown outcome ${JSON.stringify(row.outcome)}`);
    if (row.differences !== undefined && !Array.isArray(row.differences)) throw new TypeError(`row ${row.id} has differences that are not a list`);
    if (row.outcome === 'passed' && row.differences?.length) throw new TypeError(`row ${row.id} passed with ${row.differences.length} differences`);
  }
}

/**
 * Waivers are `{ [rowId]: { outcome, reason } }`: a waiver names the one
 * outcome it covers and why. Returns the problems with the table itself.
 */
export function waiverProblems(waivers) {
  const problems = [];
  if (!waivers || typeof waivers !== 'object' || Array.isArray(waivers)) return ['waivers must be an object keyed by row id'];
  for (const [id, waiver] of Object.entries(waivers)) {
    if (!waiver || typeof waiver !== 'object') { problems.push(`waiver ${id} is not an object`); continue; }
    if (!WAIVABLE.includes(waiver.outcome)) problems.push(`waiver ${id} names outcome ${JSON.stringify(waiver.outcome)}; only ${WAIVABLE.join(', ')} can be waived`);
    if (typeof waiver.reason !== 'string' || waiver.reason.trim().length < 8) problems.push(`waiver ${id} has no reason`);
  }
  return problems;
}

/**
 * Judges a run. `rows` are the judged rows; `waivers` the waiver table;
 * `gaps` census gaps (strings), each of which makes the run incomplete.
 * Returns `{ exit, verdict, counts, rows, problems }` where every row carries
 * `waived` (the reason) or null, and `problems` lists waiver and census
 * problems in the order they decide the exit.
 */
export function judgeRun({ rows, waivers = {}, gaps = [] }) {
  validateRows(rows);
  const tableProblems = waiverProblems(waivers);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const waiverFailures = [...tableProblems];
  const used = new Set();
  const judged = rows.map((row) => {
    const waiver = Object.hasOwn(waivers, row.id) ? waivers[row.id] : null;
    if (!waiver || tableProblems.some((problem) => problem.startsWith(`waiver ${row.id} `))) return { ...row, waived: null };
    used.add(row.id);
    if (row.outcome === 'passed') { waiverFailures.push(`waiver ${row.id} waives nothing: the row passed`); return { ...row, waived: null }; }
    if (row.outcome === 'failed') { waiverFailures.push(`waiver ${row.id} cannot waive a failure`); return { ...row, waived: null }; }
    if (waiver.outcome !== row.outcome) { waiverFailures.push(`waiver ${row.id} covers ${waiver.outcome}, but the row is ${row.outcome}`); return { ...row, waived: null }; }
    return { ...row, waived: waiver.reason };
  });
  for (const id of Object.keys(waivers)) if (!byId.has(id) && !used.has(id)) waiverFailures.push(`waiver ${id} waives nothing: no such row`);
  const counts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
  let waived = 0;
  for (const row of judged) { counts[row.outcome] += 1; if (row.waived) waived += 1; }
  const census = gaps.map((gap) => `census gap: ${gap}`);
  const open = judged.filter((row) => row.outcome !== 'passed' && row.outcome !== 'failed' && !row.waived);
  let exit;
  let verdict;
  if (counts.failed) { exit = EXIT.failed; verdict = 'FAILED'; }
  else if (judged.length === 0) { exit = EXIT.incomplete; verdict = 'NOTHING RECORDED'; }
  else if (open.length || waiverFailures.length || census.length) { exit = EXIT.incomplete; verdict = 'INCOMPLETE'; }
  else if (counts.passed === 0) { exit = EXIT.incomplete; verdict = 'NOTHING JUDGED'; }
  else { exit = EXIT.passed; verdict = 'passed'; }
  return { exit, verdict, counts: { rows: judged.length, ...counts, waived, waivers: Object.keys(waivers).length, gaps: gaps.length }, rows: judged, problems: [...waiverFailures, ...census] };
}

const MARK = Object.freeze({ passed: 'ok  ', failed: 'FAIL', inconclusive: 'INCONCLUSIVE', unstable: 'UNSTABLE', unrecordable: 'UNRECORDABLE' });

/** The last line: the verdict and every count, always. */
export function lastLine(judgement, { title = 'backend conformance' } = {}) {
  const { counts } = judgement;
  return `${title}: ${judgement.verdict} (${counts.rows} rows: ${counts.passed} passed, ${counts.failed} failed, ${counts.inconclusive} inconclusive, ${counts.unstable} unstable, ${counts.unrecordable} unrecordable; ${counts.waived} waived by ${counts.waivers} waivers; ${counts.gaps} census gaps; ${judgement.problems.length} problems) exit ${judgement.exit}`;
}

/** The report as lines: one per row (with its reason and differences), the problems, then the last line. */
export function reportLines(judgement, options) {
  const lines = [];
  for (const row of judgement.rows) {
    lines.push(`${MARK[row.outcome]} ${row.id}${row.reason ? `: ${row.reason}` : ''}${row.waived ? ` (waived: ${row.waived})` : ''}`);
    for (const difference of row.differences ?? []) lines.push(`    ${typeof difference === 'string' ? difference : JSON.stringify(difference)}`);
  }
  for (const problem of judgement.problems) lines.push(`PROBLEM ${problem}`);
  lines.push(lastLine(judgement, options));
  return lines;
}
