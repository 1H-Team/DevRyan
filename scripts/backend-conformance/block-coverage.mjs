// V8 block coverage of a group's files, taken in pieces (BH5, the census;
// design file 31 §8.3). The group host starts it before it imports the
// group, when the harness asks for it (`--coverage=block`); each take returns
// what ran in the group's files since the previous take, and resets the
// counts. The census reads which branch each exchange took from these takes;
// product code is not changed and nothing is added to it.
//
// A take is `[{ file, functions: [{ name, start, end, ranges: [[start, end, count], ...] }] }]`:
// for every function of a group file that ran since the last take (or that
// V8 reports for the first time), its own range first, then the block ranges
// inside it, as V8's precise coverage reports them (offsets are UTF-16 code
// units of the file's text; a block counts as executed n times when the
// innermost range of its own function holding its position says n). A
// function absent from a take did not run during it.
import inspector from 'node:inspector';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Posts one inspector command on an in-process session and returns its answer at once (it is synchronous there). */
function postNow(session, method, params = {}) {
  let answer = null;
  let failure = null;
  let done = false;
  session.post(method, params, (error, result) => { failure = error; answer = result; done = true; });
  if (!done) throw new Error(`block coverage: the inspector did not answer ${method} synchronously`);
  if (failure) throw new Error(`block coverage: ${method} failed: ${failure.message ?? failure}`);
  return answer;
}

/**
 * Starts precise block coverage in this process. Returns `{ take(files) }`,
 * which keeps only `files` (absolute paths; their real paths are matched).
 * It must run before the files are imported: a function compiled before has
 * no block counters.
 */
export function startBlockCoverage() {
  const session = new inspector.Session();
  session.connect();
  postNow(session, 'Profiler.enable');
  postNow(session, 'Profiler.startPreciseCoverage', { callCount: true, detailed: true, allowTriggeredUpdates: false });
  return {
    take(files) {
      const wanted = new Map(files.map((file) => [fs.realpathSync(file), file]));
      const { result } = postNow(session, 'Profiler.takePreciseCoverage');
      const out = [];
      for (const script of result) {
        if (!script.url.startsWith('file:')) continue;
        let real;
        try { real = fs.realpathSync(fileURLToPath(script.url)); } catch { continue; }
        if (!wanted.has(real)) continue;
        out.push({
          file: wanted.get(real),
          functions: script.functions.map((fn) => ({ name: fn.functionName, block: fn.isBlockCoverage, start: fn.ranges[0].startOffset, end: fn.ranges[0].endOffset, ranges: fn.ranges.map((range) => [range.startOffset, range.endOffset, range.count]) })),
        });
      }
      return out;
    },
  };
}
