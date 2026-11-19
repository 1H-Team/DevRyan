// The harmlessness judge (BH1; design file 31 §10 risk 2), pure: Vitest junit
// as test identities, the varying-word rule, and the verdict of one set from
// two plain runs and one tapped run. The runner (the harmlessness module of
// this folder) runs the sets; the self-test feeds this judge fixed inputs.
import { judgeParity, outputLines } from '../client-conformance/parity.mjs';

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decodeEntities = (text) => text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, entity) => {
  if (entity[0] === '#') return String.fromCodePoint(entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
  return ENTITIES[entity] ?? whole;
});
const attributes = (text) => Object.fromEntries([...text.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)].map((match) => [match[1], decodeEntities(match[2])]));

/**
 * Vitest's junit report as the test identities judgeParity takes:
 * `[{ file, line, describe, name, status, assertions, output }]`. Vitest names
 * the file in `classname` and joins the describe path into `name`; it reports
 * no line and no assertion count (both stay 0 / null on both sides).
 */
export function parseVitestJunit(xml) {
  const tests = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = attributes(match[1]);
    const inner = match[3] ?? '';
    const status = /<(?:failure|error)\b/.test(inner) ? 'failed' : /<skipped\b/.test(inner) ? 'skipped' : 'passed';
    const output = [...inner.matchAll(/<(system-out|system-err)>([\s\S]*?)<\/\1>/g)].map((part) => `${part[1]}: ${decodeEntities(part[2].replace(/^<!\[CDATA\[|\]\]>$/g, ''))}`).join('\n');
    tests.push({ file: attrs.classname ?? '', line: 0, describe: [], name: attrs.name ?? '', status, assertions: null, output });
  }
  return tests;
}

/**
 * What else varies without the tap. parity.mjs learns the shape of a line two
 * plain runs disagree on with its digit runs as #; product tests also print
 * random temporary names (mkdtemp suffixes are letters too). So a line only
 * one plain run printed is paired with the line only the other printed that
 * shares the longest prefix and suffix around one differing word (no
 * whitespace inside), and that prefix and suffix are learned. A line of any
 * run that has a learned prefix and suffix around one word is replaced by
 * `<prefix>«varies»<suffix>` before judging. Learned from the plain runs only,
 * like parity.mjs's shapes; every learned span and every line it replaced is
 * printed and counted.
 */
export function learnVaryingSpans(firstLines, secondLines) {
  const counts = new Map();
  for (const line of firstLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of secondLines) counts.set(line, (counts.get(line) ?? 0) - 1);
  const onlyFirst = [...counts].filter(([, count]) => count > 0).map(([line]) => line);
  const onlySecond = [...counts].filter(([, count]) => count < 0).map(([line]) => line);
  const spans = new Map();
  for (const left of onlyFirst) {
    let best = null;
    for (const right of onlySecond) {
      let prefix = 0;
      while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
      let suffix = 0;
      while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
      const middles = [left.slice(prefix, left.length - suffix), right.slice(prefix, right.length - suffix)];
      if (middles.some((middle) => middle === '' || /\s/.test(middle))) continue;
      if (prefix + suffix < Math.max(left.length, right.length) / 2) continue;
      if (!best || prefix + suffix > best.prefix.length + best.suffix.length) best = { prefix: left.slice(0, prefix), suffix: left.slice(left.length - suffix) };
    }
    if (best) spans.set(`${best.prefix}\u0000${best.suffix}`, best);
  }
  return [...spans.values()];
}
export function maskVaryingSpans(lines, spans) {
  let masked = 0;
  const out = lines.map((line) => {
    for (const { prefix, suffix } of spans) {
      if (line.length > prefix.length + suffix.length && line.startsWith(prefix) && line.endsWith(suffix) && !/\s/.test(line.slice(prefix.length, line.length - suffix.length))) { masked += 1; return `${prefix}\u00abvaries\u00bb${suffix}`; }
    }
    return line;
  });
  return { lines: out, masked };
}

/** A run's printed lines: its stdout, then each test's own output, keyed by the test. */
export const printed = (run) => [run.output, ...run.tests.filter((test) => test.output).map((test) => `${test.file} ${test.name}\n${test.output}`)].join('\n');

/**
 * The verdict of one set (pure; the self-test feeds it fixed inputs).
 * `plain` are the two plain runs, `tapped` the run with the tap; each run is
 * `{ tests, output }`, and `tapped` also carries what the tap wrote
 * (`tapFiles`, `tapProcesses`, `wrapped`: group exchanges it observed).
 */
export function harmlessnessVerdict({ plain, tapped, expectedFiles, wraps = false }) {
  // judgeParity's recording checks are the client recorder's (one recording per
  // test file). The tap writes one record file per process, not per test file,
  // so they are given the tapped run's own tests and say nothing here; the
  // tap's presence is checked below instead.
  const raws = [...new Set(tapped.tests.map((test) => test.file))].map((file) => ({ file, cases: tapped.tests.filter((test) => test.file === file && test.status !== 'skipped').map(() => ({ kind: 'test' })), errors: tapped.errors ?? [] }));
  const spans = learnVaryingSpans(outputLines(printed(plain[0])), outputLines(printed(plain[1])));
  let spanMasked = 0;
  const text = (run) => { const result = maskVaryingSpans(outputLines(printed(run)), spans); spanMasked += result.masked; return result.lines.join('\n'); };
  const judged = judgeParity({ baseline: plain[0].tests, recorded: tapped.tests, raws, expectedFiles, baselineOutput: text(plain[0]), secondBaselineOutput: text(plain[1]), recordedOutput: text(tapped) });
  judged.spans = spans;
  judged.spanMasked = spanMasked;
  const again = judgeParity({ baseline: plain[0].tests, recorded: plain[1].tests, raws: [], expectedFiles: [] });
  for (const difference of again.differences.filter((entry) => entry.check !== 'output')) judged.incomplete.push({ check: 'plain-unstable', file: difference.test, detail: `two plain runs disagree (${difference.check}: ${difference.baseline} then ${difference.recorded})` });
  if (!tapped.tapFiles) judged.incomplete.push({ check: 'tap-absent', detail: 'the tap wrote no record file: it never armed in the tapped run' });
  if (wraps && !tapped.wrapped) judged.incomplete.push({ check: 'tap-idle', detail: 'the tap wrapped no group handler that a test then called' });
  return judged;
}
