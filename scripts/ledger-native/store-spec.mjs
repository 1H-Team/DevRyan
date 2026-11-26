// The cases of the Git runner and store differential test: the runner's
// named cases (real Git and scripted fake Gits), the store's named
// scenarios, and the seeded operation scripts.
// Paths are written with `<root>` (the arm's directory) and `<fake>` (the
// fake Gits' directory); the driver puts each arm's in.

/** Scripted fake Gits, by name: the shell text after `#!/bin/sh`. */
export const FAKE_GITS = Object.freeze({
  sleep: 'exec sleep 30',
  'sleep-2': 'exec sleep 2',
  'kill-self': 'kill -9 $$',
  'disk-full': 'echo "error: unable to write: No space left on device" >&2; exit 1',
  'quota': 'echo "fatal: Disk quota exceeded" >&2; exit 128',
  'not-git': 'echo "fatal: not a git repository (or any of the parent directories): .git" >&2; exit 128',
  stderr: 'printf "%b" "$STDERR_TEXT" >&2; exit "${EXIT_CODE:-1}"',
  'stderr-split': 'printf "\\303" >&2; sleep 0.05; printf "\\251 inflate: data stream error\\n" >&2; exit 1',
  'stderr-long': 'i=0; while [ $i -lt 40 ]; do printf "warning: filler line %s that pads the stderr well past one kilobyte\\n" $i >&2; i=$((i+1)); done; echo "fatal: cannot lock ref refs/x" >&2; exit 1',
  'stderr-head': 'echo "fatal: cannot lock ref refs/x" >&2; i=0; while [ $i -lt 40 ]; do printf "warning: filler line %s that pads the stderr well past one kilobyte\\n" $i >&2; i=$((i+1)); done; exit 1',
  'env': 'env | grep "^GIT_" | sort; echo "args: $*"',
  'exit-1': 'echo one; exit 1',
  'exit-0-unread': 'exit 0',
  'grandchild-stdin-fail': 'exec 3<&0; sleep 120 >/dev/null 2>&1 & echo $! > "$PIDFILE"; echo "fatal: unable to lock" >&2; exit 1',
  'grandchild-stdin': 'exec 3<&0; sleep 120 >/dev/null 2>&1 & echo $! > "$PIDFILE"; exit 0',
  'no-delimiter': 'head -c 1100000 /dev/zero | tr "\\000" "a"',
  'split-utf8': 'printf "a\\000b\\303"; sleep 0.05; printf "\\251c\\000tail"',
  'tokens-slow': 'printf "one\\000two"; sleep 0.05; printf "\\000three\\000"; sleep 0.05; printf "four"',
  'cat': 'cat',
  'big-out': 'head -c 3000000 /dev/zero',
  'stdin-then-fail': 'cat > /dev/null; echo "fatal: unable to lock" >&2; exit 1',
});

/** stderr texts and the failure class `failureClass` gives each (`exit 1`). */
export const STDERR_CLASSES = Object.freeze([
  "fatal: Unable to create '/x/refs/devryan/state.lock': File exists.",
  "error: .lock': File exists",
  'error: x.lock: File exists',
  "fatal: UNABLE TO CREATE 'A.LOCK'",
  "fatal: unable to create 'a'b.lock'",
  "fatal: unable to create 'state.lck'",
  'error: cannot lock ref refs/devryan/state',
  'fatal: Unable to Lock index',
  'error: bad object 1234567',
  'fatal: missing blob 0123',
  'fatal: missing tree x',
  'fatal: missing commit x',
  'fatal: missing object x',
  'error: object 1234 is corrupt',
  'error: corrupt loose object x',
  'error: corrupt object x',
  'error: unable to read 0123abc',
  'error: unable to read 0123ab',
  'error: unable to read ABCDEF0123',
  'error: object file .git/objects/ab/cd is empty',
  'error: object file is empty',
  'error: object file x\\n is empty',
  'error: bad packed object x',
  'error: packfile p.pack cannot be mapped',
  'error: packfile p.pack does not match index',
  'error: packfile p.pack\\n cannot be mapped',
  'error: inflate: data stream error (incorrect header check)',
  'fatal: did not receive expected object 1234',
  'fatal: something else happened',
  'error: cannot lock ref refs/x; error: bad object 1234567',
  'error: bad object 1234567 and a signal',
  'fatal: \\342\\200\\250 missing BLOB x',
  'fatal: \\305\\277omething: cannot ʟock ref',
  '',
]);

/** Exit codes a fake Git reports (with stderr `fatal: x`). */
export const EXIT_CODES = Object.freeze([1, 2, 128, 129, 255]);

/** A seeded generator (mulberry32). */
export function random(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (limit) => Math.floor(next() * limit),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
  };
}

// The prefixes share leading bytes; the names are of the alphabet whose
// collation and code-unit orders agree (D25's `-./0-9a-z`).
const PREFIXES = ['runs', 'runs-x', 'runs/a', 'bases/t', 'bases/t-x', 'bases/t2', 'ops', 'a'];
const NAME_UNITS = 'abz09-';

function name(rng) {
  let text = '';
  const length = 1 + rng.int(4);
  for (let index = 0; index < length; index++) text += rng.pick(NAME_UNITS.split(''));
  return text;
}

/** A JSON value: numbers at their edges, strings with every kind of unit, nesting. */
export function value(rng, depth = 0) {
  const kind = rng.int(depth > 2 ? 4 : 7);
  switch (kind) {
    case 0: return rng.pick([0, 1, -1, 0.1, 1e21, 1e-7, 123456789012, -2.5e-300, 2 ** 53]);
    case 1: return rng.pick(['', 'a', 'é', ' ', '\ud800', 'x"\\\n\t', '😀', '0']);
    case 2: return rng.pick([true, false, null]);
    case 3: return 'v'.repeat(rng.int(60));
    case 4: return Array.from({ length: rng.int(4) }, () => value(rng, depth + 1));
    case 5: {
      const out = {};
      // An own `__proto__` key (as JSON.parse makes it), not the prototype
      // an assignment would set: the request carries it and both arms print it.
      for (const key of ['b', '1', 'a', '0', '__proto__', 'z'].slice(0, rng.int(6))) {
        Object.defineProperty(out, key, { value: value(rng, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    default: return { big: 'w'.repeat(rng.pick([10, 3000, 70000])) };
  }
}

/** One seeded operation script for one store: steps against `a` (and `b`, `s`). */
export function generateScript(seed, { length = 24 } = {}) {
  const rng = random(seed);
  const steps = [];
  const keyOf = () => `${rng.pick(PREFIXES)}/${name(rng)}.json`;
  for (let index = 0; index < length; index++) {
    const roll = rng.int(100);
    if (roll < 22) steps.push({ s: 'set', st: 'a', key: keyOf(), value: value(rng) });
    else if (roll < 28) steps.push({ s: 'remove', st: 'a', key: keyOf() });
    else if (roll < 34) steps.push({ s: 'get', st: 'a', key: keyOf() });
    else if (roll < 42) steps.push({ s: 'entries', st: 'a', prefix: rng.pick(PREFIXES), ...(rng.chance(0.2) ? { take: 1 } : {}) });
    else if (roll < 47) steps.push({ s: 'setList', st: 'a', prefix: `lists/${name(rng)}`, values: Array.from({ length: rng.pick([0, 3, 130, 300]) }, () => value(rng, 2)), absent: rng.chance(0.3), collect: rng.chance(0.3), valuesGen: rng.chance(0.3), firstPage: rng.pick([0, 0, 1]) });
    else if (roll < 50) steps.push({ s: 'list', st: 'a', prefix: `lists/${name(rng)}` });
    else if (roll < 54) {
      const register = `w${index}`;
      steps.push({ s: 'writeList', st: 'a', values: Array.from({ length: rng.pick([1, 140]) }, () => value(rng, 2)), as: register });
      steps.push({ s: 'setListObjects', st: 'a', prefix: `lists/${name(rng)}`, from: register });
    } else if (roll < 68) {
      const guard = rng.chance(0.15) ? { failAt: rng.pick([1, 2, 3]), async: rng.chance(0.5) } : undefined;
      steps.push({ s: 'commit', st: 'a', ...(guard ? { guard } : {}) });
    } else if (roll < 71) steps.push({ s: 'pin', st: 'a', token: `0000000${rng.int(3)}-0000-4000-8000-000000000000` });
    else if (roll < 73) steps.push({ s: 'release', st: 'a', token: `0000000${rng.int(3)}-0000-4000-8000-000000000000` });
    else if (roll < 76) steps.push({ s: 'importPrefix', st: 'a', source: '@a', prefix: rng.pick(PREFIXES), destination: rng.pick(PREFIXES) });
    else if (roll < 79) steps.push({ s: 'prefixIdentity', st: 'a', prefix: rng.pick(PREFIXES) });
    else if (roll < 81) steps.push({ s: 'prefixIdentities', st: 'a', prefixes: [rng.pick(PREFIXES), rng.pick(PREFIXES), 'none'] });
    else if (roll < 84) steps.push({ s: 'committedIdentity', st: 'a', prefix: rng.pick(PREFIXES) });
    else if (roll < 87) steps.push({ s: 'staged', st: 'a', prefix: rng.pick(PREFIXES) });
    else if (roll < 90) steps.push({ s: 'committedRows', st: 'a', prefix: rng.pick(PREFIXES) });
    else if (roll < 92) steps.push({ s: 'readRows', st: 'a', prefix: rng.pick(PREFIXES) });
    else if (roll < 95) steps.push({ s: 'stage', st: 'a', fail: rng.chance(0.5), steps: [{ s: 'set', st: 'a', key: keyOf(), value: value(rng) }, { s: 'remove', st: 'a', key: keyOf() }] });
    else if (roll < 97) steps.push({ s: 'concurrent', steps: [{ s: 'get', st: 'a', key: keyOf() }, { s: 'entries', st: 'a', prefix: rng.pick(PREFIXES) }, { s: 'get', st: 'a', key: keyOf() }] });
    else steps.push({ s: 'state', st: 'a' });
  }
  steps.push({ s: 'commit', st: 'a' });
  steps.push({ s: 'state', st: 'a' });
  return steps;
}

/** The switch settings each script runs under (environment and open options). */
export const SETTINGS = Object.freeze([
  { name: 'default', env: {}, options: {} },
  { name: 'index', env: { DEVRYAN_LEDGER_DIRECT_TREES: '0' }, options: {} },
  { name: 'kept-index', env: { DEVRYAN_LEDGER_DIRECT_TREES: '0' }, options: { persistentIndex: true } },
  { name: 'kept-index-off', env: { DEVRYAN_LEDGER_DIRECT_TREES: '0', DEVRYAN_LEDGER_PERSISTENT_INDEX: '0' }, options: { persistentIndex: true } },
  { name: 'direct-kept', env: {}, options: { persistentIndex: true } },
  { name: 'paged', env: {}, options: { listingLimitBytes: 1 } },
  { name: 'paged-git', env: { DEVRYAN_LEDGER_DIRECT_LISTINGS: '0' }, options: { listingLimitBytes: 1 } },
  { name: 'no-reader', env: { DEVRYAN_LEDGER_PERSISTENT_READER: '0' }, options: {} },
  { name: 'no-reader-paged', env: { DEVRYAN_LEDGER_PERSISTENT_READER: '0' }, options: { listingLimitBytes: 1 } },
]);
export const SWITCHES = Object.freeze(['DEVRYAN_LEDGER_DIRECT_TREES', 'DEVRYAN_LEDGER_DIRECT_LISTINGS', 'DEVRYAN_LEDGER_PERSISTENT_READER', 'DEVRYAN_LEDGER_PERSISTENT_INDEX']);
