// The Rust ledger core, run as WebAssembly: the edit script of
// `mutationDiff` (session-mutation-text.js) for two byte strings, as flat
// (kind, byte length) pairs. Off unless DEVRYAN_LEDGER_RUST=1, read on every
// call. Any failure answers `null` ("use JavaScript") for that call and is
// journaled once per cause through the caller's `onDiagnostic`; nothing here
// can throw into the ledger or take down its thread. The JavaScript
// implementation stays the reference (DOCUMENTATION.md, "Rust ledger core").
//
// Never load a native Rust module into this process instead: a fault there
// would end the process that hosts the server and every session.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The ABI this loader speaks; the module's `ledger_core_abi_version` must match. */
export const LEDGER_CORE_ABI_VERSION = 1;
export const LEDGER_CORE_SWITCH = 'DEVRYAN_LEDGER_RUST';
/** Pair kinds, as in the module: equal, delete, insert. */
export const LEDGER_CORE_KINDS = Object.freeze(['equal', 'delete', 'insert']);
/**
 * Why a call used JavaScript, besides the switch being off. `missing`,
 * `provenance`, `hash`, `compile` and `abi` are found once, when the module is
 * first loaded, and hold for the loader's life; the others are per call. Each is journaled
 * once per loader (one per thread for the default loader) as
 * `{ phase: 'ledger_core', state: 'fallback', code: 'ledger_core_<cause>' }`.
 */
export const LEDGER_CORE_FALLBACK_CAUSES = Object.freeze([
  'missing', 'provenance', 'hash', 'compile', 'abi', 'instantiate', 'budget', 'input', 'memory', 'trap', 'status', 'result',
]);
const EXPORTS = Object.freeze(['ledger_core_abi_version', 'ledger_core_alloc', 'ledger_core_free', 'ledger_core_diff', 'ledger_core_free_result']);
// A latin1 byte string holds only code units 0x00-0xff.
const NOT_A_BYTE_STRING = /[^\x00-\xff]/;

/**
 * WebAssembly memory never shrinks, so an instance whose memory is larger than
 * this after a call is dropped and the next call instantiates the compiled
 * module again. Measured (two edits, ASCII, the largest case): a 32 KiB file
 * leaves 1.4 MiB, 256 KiB 3.7 MiB, 1 MiB 11.2 MiB, 8 MiB 81 MiB (R0: about
 * 110 MiB). 8 MiB keeps one instance for edits up to a few hundred KiB, the
 * common case, and never retains what a 1 MiB or larger call grew to.
 */
export const LEDGER_CORE_RETAINED_MEMORY_BYTES = 8 * 1024 * 1024;

const DEFAULT_MODULE = new URL('./native/ledger-core.wasm', import.meta.url);
const DEFAULT_PROVENANCE = new URL('./native/ledger-core.json', import.meta.url);

/**
 * A loader with its own module, instance and journaled causes. Paths resolve
 * relative to this file, which in the packaged app sits in the unpacked
 * harness-runtime folder. `environment` is read on every call.
 */
export function createLedgerCore({ moduleUrl = DEFAULT_MODULE, provenanceUrl = DEFAULT_PROVENANCE, environment = process.env } = {}) {
  let compiled = null; // WebAssembly.Module once loaded
  let failed = null; // a permanent cause once loading failed
  let instance = null; // { exports, memory }
  let instances = 0;
  const reported = new Set();
  // Read on every call; only the value 1 turns it on.
  const enabled = () => environment.DEVRYAN_LEDGER_RUST === '1';

  const fallback = (cause, onDiagnostic) => {
    if (typeof onDiagnostic === 'function' && !reported.has(cause)) {
      reported.add(cause);
      try { onDiagnostic({ phase: 'ledger_core', state: 'fallback', code: `ledger_core_${cause}` }); } catch { /* Observer only. */ }
    }
    return null;
  };

  /** The compiled module, or a permanent cause. Loaded once, synchronously, after its hash check. */
  const load = () => {
    if (compiled || failed) return failed;
    let bytes;
    try { bytes = readFileSync(moduleUrl); } catch { return (failed = 'missing'); }
    let provenance;
    try { provenance = JSON.parse(readFileSync(provenanceUrl, 'utf8')); } catch { return (failed = 'provenance'); }
    if (provenance?.schemaVersion !== 1 || typeof provenance.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(provenance.sha256)) return (failed = 'provenance');
    if (bytes.length !== provenance.bytes || createHash('sha256').update(bytes).digest('hex') !== provenance.sha256) return (failed = 'hash');
    try { compiled = new WebAssembly.Module(bytes); } catch { return (failed = 'compile'); }
    const exported = new Map(WebAssembly.Module.exports(compiled).map((entry) => [entry.name, entry.kind]));
    if (exported.get('memory') !== 'memory' || EXPORTS.some((name) => exported.get(name) !== 'function')) { compiled = null; return (failed = 'abi'); }
    return null;
  };

  /** The live instance, or a cause. A fresh one shares only the compiled module. */
  const current = () => {
    if (instance) return instance;
    let created;
    try { created = new WebAssembly.Instance(compiled, {}); } catch { return 'instantiate'; }
    let version;
    try { version = created.exports.ledger_core_abi_version(); } catch { return 'abi'; }
    if (version !== LEDGER_CORE_ABI_VERSION) { compiled = null; failed = 'abi'; return 'abi'; }
    instances += 1;
    instance = { exports: created.exports, memory: created.exports.memory };
    return instance;
  };

  /**
   * The edit script `mutationDiff(before, after, { budget })` produces, as a
   * Uint32Array of [kind, bytes, kind, bytes, ...], or null to use JavaScript.
   * `before` and `after` are latin1 byte strings.
   */
  function diff(before, after, budget, options) {
    // Any options value, null and non-objects included, is accepted; only a function observer is called.
    let onDiagnostic;
    try { onDiagnostic = options !== null && typeof options === 'object' ? options.onDiagnostic : undefined; } catch { /* A throwing getter: no observer. */ }
    if (!enabled()) return null;
    if (!Number.isSafeInteger(budget)) return fallback('budget', onDiagnostic);
    if (typeof before !== 'string' || typeof after !== 'string' || NOT_A_BYTE_STRING.test(before) || NOT_A_BYTE_STRING.test(after)) {
      return fallback('input', onDiagnostic);
    }
    const permanent = load();
    if (permanent) return fallback(permanent, onDiagnostic);
    const live = current();
    if (typeof live === 'string') return fallback(live, onDiagnostic);
    const { exports, memory } = live;
    const n = before.length, m = after.length;
    let a = 0, b = 0, result = 0, trapped = false;
    try {
      try {
        a = exports.ledger_core_alloc(n);
        b = a ? exports.ledger_core_alloc(m) : 0;
      } catch { trapped = true; return fallback('trap', onDiagnostic); }
      if (!a || !b) return fallback('memory', onDiagnostic);
      // Allocation may have grown the memory: take the view afterwards.
      const view = Buffer.from(memory.buffer);
      if (view.write(before, a, n, 'latin1') !== n || view.write(after, b, m, 'latin1') !== m) return fallback('memory', onDiagnostic);
      try { result = exports.ledger_core_diff(a, n, b, m, budget); } catch { trapped = true; return fallback('trap', onDiagnostic); }
      const words = new Uint32Array(memory.buffer);
      const base = result >>> 2;
      if (!result || result % 4 !== 0 || base + 2 > words.length) return fallback('result', onDiagnostic);
      if (words[base] !== 0) return fallback('status', onDiagnostic);
      const count = words[base + 1];
      if (base + 2 + 2 * count > words.length) return fallback('result', onDiagnostic);
      const pairs = words.slice(base + 2, base + 2 + 2 * count);
      // A script that does not cover both texts exactly is not trusted.
      let x = 0, y = 0;
      for (let index = 0; index < pairs.length; index += 2) {
        const kind = pairs[index], bytes = pairs[index + 1];
        if (kind > 2 || bytes === 0) return fallback('result', onDiagnostic);
        if (kind !== 2) x += bytes;
        if (kind !== 1) y += bytes;
      }
      if (x !== n || y !== m) return fallback('result', onDiagnostic);
      return pairs;
    } finally {
      if (trapped) instance = null;
      else if (instance === live) {
        try {
          if (result) exports.ledger_core_free_result(result);
          if (b) exports.ledger_core_free(b, m);
          if (a) exports.ledger_core_free(a, n);
        } catch { instance = null; }
        // Memory never shrinks: drop an instance past the cap so its memory is released.
        if (memory.buffer.byteLength > LEDGER_CORE_RETAINED_MEMORY_BYTES) instance = null;
      }
    }
  }

  /** What the loader holds, for tests and diagnostics. */
  const inspect = () => ({ loaded: Boolean(compiled), failed, instances, memoryBytes: instance ? instance.memory.buffer.byteLength : 0 });
  return { diff, enabled, inspect };
}

/** The process's loader for this thread, over the package's own module. */
export const ledgerCore = createLedgerCore();
/** Whether the switch is on for `ledgerCore` now (callers skip work the Rust path needs when it is off). */
export const ledgerCoreEnabled = () => ledgerCore.enabled();
/** `ledgerCore.diff`: the edit script as pairs, or null to use JavaScript. */
export const ledgerCoreDiff = (before, after, budget, options) => ledgerCore.diff(before, after, budget, options);
