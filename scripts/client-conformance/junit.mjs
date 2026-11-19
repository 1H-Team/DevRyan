// Bun's junit report as test identities (design file 29 §2.8): each test's
// file, line, describe path and name, and whether it passed, failed or was
// skipped. Times and the host name are discarded.
import path from 'node:path';

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decodeEntities = (text) => text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, entity) => {
  if (entity[0] === '#') return String.fromCodePoint(entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
  return ENTITIES[entity] ?? whole;
});
const attributes = (text) => {
  const out = {};
  for (const match of text.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) out[match[1]] = decodeEntities(match[2]);
  return out;
};

/**
 * Parses a junit report into `[{ file, line, describe, name, status,
 * assertions }]` in report order (Bun reports concurrent tests in the order
 * they finish). `file` is relative to `root` when `cwd` (the directory Bun ran
 * in, which junit paths are relative to) is given.
 */
export function parseJunit(xml, { cwd, root } = {}) {
  const tests = [];
  const suites = [];
  let open = null;
  for (const match of xml.matchAll(/<(\/?)(testsuite|testcase|failure|error|skipped)\b([^>]*?)(\/?)>/g)) {
    const [, closing, tag, rest, selfClosing] = match;
    if (tag === 'testsuite') {
      if (closing) suites.pop();
      else if (!selfClosing) suites.push(attributes(rest));
      continue;
    }
    if (tag === 'testcase') {
      if (closing) { if (open) tests.push(open); open = null; continue; }
      const attrs = attributes(rest);
      const fileAttr = attrs.file ?? suites[0]?.file ?? '';
      const file = cwd && root ? path.relative(root, path.resolve(cwd, fileAttr)).split(path.sep).join('/') : fileAttr;
      const record = { file, line: Number(attrs.line ?? 0), describe: suites.slice(1).map((suite) => suite.name), name: attrs.name ?? '', status: 'passed', assertions: attrs.assertions === undefined ? null : Number(attrs.assertions) };
      if (selfClosing) tests.push(record); else open = record;
      continue;
    }
    if (open && !closing) open.status = tag === 'skipped' ? 'skipped' : 'failed';
  }
  return tests;
}

/** The identity of a test: `<file>:<line> <describe> > <name> #<occurrence>`. */
export function testKeys(tests) {
  const seen = new Map();
  return tests.map((test) => {
    const base = `${test.file}:${test.line} ${[...test.describe, test.name].join(' > ')}`;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return { ...test, occurrence, key: `${base} #${occurrence}` };
  });
}
