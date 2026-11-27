// How the driver observes an arm's effects from outside (S1 of the BH3/BH4
// review; design file 31 §2.2 "Child processes", "Outbound HTTP"). The
// reference's group is observed from inside by the tap; a candidate is a
// process of its own, so it runs under the same observation from outside:
//
//   stubs          one loopback HTTP server per stub name for every arm (the reference's group host
//                  gets them with --stubs, a candidate with --stub and in its environment as
//                  DEVRYAN_HARNESS_STUB_<NAME>); each request a stub receives is recorded (method,
//                  path, headers, body bytes) and answered 204.
//   PATH shim      a candidate's PATH starts with a folder of this run holding, for every name in a
//                  folder of its PATH, a link to one shell script: it records the name, the working directory
//                  and the arguments, puts the original PATH back and runs the real program (so the
//                  program's own children are not recorded, as the tap records only the group's).
//   process group  at each step's quiescence the driver looks at the candidate's process group, frozen:
//                  a member other than the candidate itself is a child it started (process-group look).
//
// What this cannot see is a named limit (CANDIDATE_EFFECT_LIMIT), printed in every run's summary with
// the number of candidate exchanges it applies to: a child started by absolute path (no PATH lookup)
// that exits between two looks, a connection to an address the harness did not hand out, and hub
// events (a candidate publishes them only through the protocol's /events, which is not read).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const CANDIDATE_EFFECT_LIMIT = Object.freeze({
  name: 'candidate-effects-unseen',
  text: 'on a candidate, a child started by absolute path that exits between two looks at its process group, a connection to an address the harness did not hand out, and hub events (the protocol\'s /events is not read) are not seen; children found through the PATH shim or the process group and requests to the handed-out stubs are compared',
});
/** The stub names every arm is given (a group's own declared stubs come after; the pilot declares none). */
export const STUB_NAMES = Object.freeze(['outbound']);
export const stubVariable = (name) => `DEVRYAN_HARNESS_STUB_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
const SHIM_LOG = 'DEVRYAN_HARNESS_SHIM_LOG';
const SHIM_PATH = 'DEVRYAN_HARNESS_SHIM_PATH';
const END = 'DEVRYAN-SHIM-END';

// Builtins only: any program it named would itself resolve through the shim.
const SHIM = `#!/bin/sh
# DevRyan backend harness PATH shim (scripts/backend-conformance/observe.mjs):
# records one PATH-resolved child, then runs the real program with the original PATH.
name=\${0##*/}
log=\${${SHIM_LOG}:-}
if [ -n "$log" ] && [ -d "$log" ]; then
  i=0
  while [ -e "$log/$$.$i" ]; do i=$((i+1)); done
  printf '%s\\0' "$name" "$PWD" "$@" "${END}" > "$log/$$.$i"
fi
real_path=\${${SHIM_PATH}:-}
PATH=$real_path
export PATH
IFS=:
for dir in $real_path; do
  if [ -n "$dir" ] && [ -f "$dir/$name" ] && [ -x "$dir/$name" ]; then
    IFS=' '
    exec "$dir/$name" "$@"
  fi
done
printf 'harness shim: %s is not on the original PATH\\n' "$name" >&2
exit 127
`;

/**
 * The observation of one arm of one scenario, under `<label>/observe` of the run. `children`: whether
 * this arm gets the PATH shim (candidates; the reference's children are the tap's).
 */
export async function createObservation({ run, label, children, env = process.env, stubNames = STUB_NAMES }) {
  const root = run.makeDirectory(`${label}/observe`);
  const stubs = new Map();
  const received = [];
  for (const name of stubNames) {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ kind: 'http-request', seenBy: 'stub', stub: name, method: req.method, target: `127.0.0.1:${server.address().port}${req.url}`, headers: req.rawHeaders, body: Buffer.concat(chunks).toString('base64') });
        res.writeHead(204, { Connection: 'close' });
        res.end();
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    stubs.set(name, server);
  }
  let shim = null;
  if (children) {
    const bin = run.makeDirectory(`${label}/observe/bin`);
    const log = run.makeDirectory(`${label}/observe/log`);
    const script = path.join(root, 'shim.sh');
    fs.writeFileSync(script, SHIM, { mode: 0o755 });
    const originalPath = env.PATH ?? '';
    const names = new Set();
    for (const dir of originalPath.split(':')) {
      if (!dir || !path.isAbsolute(dir)) continue;
      let list = [];
      try { list = fs.readdirSync(dir); } catch { continue; }
      // Every name, unchecked (a stat each would cost more than the links): the shim runs only a real executable file.
      for (const name of list) names.add(name);
    }
    for (const name of names) fs.symlinkSync(script, path.join(bin, name));
    shim = { bin, log, originalPath, names: names.size, seen: new Set() };
  }
  const groupSeen = new Set();
  let stubIndex = 0;
  return {
    stubUrls: Object.fromEntries([...stubs].map(([name, server]) => [name, `http://127.0.0.1:${server.address().port}`])),
    stubPorts: Object.fromEntries([...stubs].map(([name, server]) => [name, server.address().port])),
    seenBy: [...(shim ? ['path-shim'] : []), 'stubs', ...(children ? ['process-group'] : [])],
    shimmedNames: shim?.names ?? 0,
    /** The environment an arm is given on top of its own (the shim's PATH, each stub's address). */
    environment() {
      return {
        ...Object.fromEntries([...stubs].map(([name, server]) => [stubVariable(name), `http://127.0.0.1:${server.address().port}`])),
        ...(shim ? { PATH: `${shim.bin}${shim.originalPath ? `:${shim.originalPath}` : ''}`, [SHIM_LOG]: shim.log, [SHIM_PATH]: shim.originalPath } : {}),
      };
    },
    /**
     * What was observed since the last call: `{ outbound, children }` (each effect with `seenBy`).
     * `groupOthers` are the members of the arm's process group other than the arm, seen frozen
     * (`[{ pid, command }]`); a child the shim already recorded (same pid: the shim execs) is not repeated.
     */
    collect(groupOthers = []) {
      const outbound = received.slice(stubIndex);
      stubIndex = received.length;
      const childrenSeen = [];
      const shimPids = new Set();
      if (shim) {
        let files = [];
        try { files = fs.readdirSync(shim.log).sort(); } catch { files = []; }
        for (const file of files) {
          if (shim.seen.has(file)) continue;
          let fields;
          try { fields = fs.readFileSync(path.join(shim.log, file), 'utf8').split('\0'); } catch { continue; }
          if (fields.at(-2) !== END) continue; // still being written: the next look takes it
          shim.seen.add(file);
          const pid = Number(file.split('.')[0]);
          shimPids.add(pid);
          groupSeen.add(pid);
          childrenSeen.push({ kind: 'child', seenBy: 'path-shim', pid, file: fields[0], cwd: fields[1], args: fields.slice(2, -2), argvHasName: false });
        }
      }
      for (const { pid, command } of groupOthers) {
        if (groupSeen.has(pid) || shimPids.has(pid)) continue;
        groupSeen.add(pid);
        const words = String(command ?? '').split(' ').filter(Boolean);
        childrenSeen.push({ kind: 'child', seenBy: 'process-group', pid, file: words[0] ?? null, args: words, command });
      }
      return { outbound, children: childrenSeen };
    },
    async close() { await Promise.all([...stubs.values()].map((server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }))); },
  };
}
