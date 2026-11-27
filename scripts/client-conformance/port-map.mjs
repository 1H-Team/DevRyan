// The port map (design file 29 §2.3): for each module family, the entry
// points the recorder wraps and the ports whose calls are effects and whose
// answers are inputs. Module paths are relative to the map file. Everything a
// family imports that the map does not name is inlined: part of the unit.
//
// {
//   "version": 1,
//   "families": [{
//     "name": "reducer",
//     "module": "<path of the module>",
//     "entries": [{ "export": "applyEvent", "draft": 0 },              // arg 0 is a draft: change set recorded
//                 { "export": "createDebouncer", "returns": "entry-object" }],  // the result is wrapped even as plain data,
//                                                                    // and an async entry's resolved value too
//     // Every entry's result that holds engine code (a function, an object with methods or getters, an
//     // iterator, a thenable) is handed to the test wrapped: running it is an input of the family.
//     "state": "snapshotState",                                         // export called at case entry and end
//     // Stateful families (package C0e): their state is recorded at case entry, after every step and at case
//     // end, with the change set of every step, and seeded into a replay. Either or both of:
//     "store": "useSelectionStore",                                     // a zustand store export (getState,
//                                                                       // setState, subscribe): its actions, the
//                                                                       // test's setState and subscribe are steps,
//                                                                       // every notification an effect
//     "moduleState": { "bindings": ["records", "executor"],             // module-level bindings no export exposes,
//                      "reason": "..." },                               // read (and seeded) through the loader
//     "ports": [{ "module": "<path>", "exports": ["log"] }],             // may be another family's entry: also its input
//     "injected": [{ "entry": "connect", "arg": 0, "name": "sdk" },       // an object handed in is a port
//                  { "entry": "connect", "arg": 1, "key": "onEvent", "name": "onEvent" },
//                  { "entry": "Manager", "member": "configure", "arg": 0, "key": "onEvict", "name": "onEvict" }],
//     // `member`: a method of what the entry handed out (`Manager#1.configure(...)`), at any depth;
//     // `onlyFunction`: the argument is a port only when it is a function (setState's updater, not its partial);
//     // `plainAnswers`: its answers are data, never port objects (an updater's next state carries functions)
//     // "wrapAnswers": true on a port or an injected item: what its calls resolve to is a port object too
//     // when it has behaviour (an SDK stream's `{ items: <async iterator> }`), one microtask later
//     "unorderedPorts": [{ "port": "...", "reason": "..." }],           // effect order not observable (waiver)
//     "allExports": true,                                               // every function export of the module is an entry,
//                                                                       // found at load time ("entries" only add specs)
//     "inline": [{ "export": "beginX", "reason": "..." }]               // with allExports: exports left unwrapped, each with a reason
//   }],
// A port may carry a "reason" (why it is a seam), and so may an entry.
//   "globals": { "fetch": { "wrapAnswers": true } }                     // answers wrapped as port objects
// }
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const FAMILY_KEYS = new Set(['name', 'module', 'entries', 'state', 'store', 'moduleState', 'ports', 'injected', 'unorderedPorts', 'note', 'allExports', 'inline']);
const ENTRY_KEYS = new Set(['export', 'draft', 'returns', 'reason']);
const PORT_KEYS = new Set(['module', 'exports', 'wrapAnswers', 'reason']);
const INLINE_KEYS = new Set(['export', 'reason']);
const INJECTED_KEYS = new Set(['entry', 'member', 'arg', 'key', 'name', 'wrapAnswers', 'onlyFunction', 'plainAnswers', 'reason']);
const GLOBAL_PORTS = new Set(['fetch', 'WebSocket', 'EventSource', 'localStorage', 'sessionStorage', 'document', 'window', 'crypto', 'performance']);

/**
 * The naming rule for test code (docs/TESTING.md, a hard rule): a path,
 * relative to the repository, is test code when its file name is Bun's test
 * name (`name.test.ext`, `name_test.ext`, `name.spec.ext`, `name_spec.ext`)
 * or it lies under a `test`, `tests`, `__tests__` or `__mocks__` directory,
 * outside node_modules. The recorder takes a family entry call as the test's
 * only when its caller is test code; a test helper named otherwise is found
 * by the family command as an unclassified caller.
 */
export const TEST_PATH = /(?:[._](?:test|spec)\.[cm]?[jt]sx?$)|(?:(?:^|\/)(?:test|tests|__tests__|__mocks__)\/)/;
export const isTestPath = (relativePath) => !relativePath.split('/').includes('node_modules') && TEST_PATH.test(relativePath);

function fail(file, message) { throw new Error(`client-conformance port map ${path.basename(file)}: ${message}`); }
function onlyKeys(file, where, object, allowed) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) fail(file, `${where} must be an object`);
  for (const key of Object.keys(object)) if (!allowed.has(key)) fail(file, `${where} has unknown member ${key}`);
}

/**
 * Reads and validates a port map. Returns `{ file, digest, families, globals,
 * modules }` with module paths resolved (real paths); `modules` maps a module
 * path to the wrapping it needs: `{ entries: Map(export -> {family, spec}),
 * ports: Map(export -> { name, families }), families: [names], all: null or
 * { family, inline: Set } }`: with `all`, every function export of the
 * module that is not listed and not inlined is an entry of that family with
 * a plain spec (the recorder finds the exports when it loads the module). An export
 * may be an entry of one family and a port of others: a call from those
 * families is their port call and the entry family's input.
 */
export function loadPortMap(file, { root } = {}) {
  const text = readFileSync(file, 'utf8');
  const map = JSON.parse(text);
  onlyKeys(file, 'the map', map, new Set(['version', 'families', 'globals', 'note']));
  if (map.version !== 1) fail(file, `version ${map.version} is not 1`);
  if (!Array.isArray(map.families)) fail(file, 'families must be a list');
  const base = path.dirname(realpathSync(file));
  const resolveModule = (relative, where) => {
    if (typeof relative !== 'string' || !relative) fail(file, `${where}: module must be a path`);
    const absolute = path.resolve(base, relative);
    if (!existsSync(absolute)) fail(file, `${where}: ${relative} does not exist`);
    return realpathSync(absolute);
  };
  const rel = (absolute) => path.relative(root ?? base, absolute).split(path.sep).join('/');
  const modules = new Map();
  const moduleEntry = (absolute) => {
    if (!modules.has(absolute)) modules.set(absolute, { entries: new Map(), ports: new Map(), families: [], all: null });
    return modules.get(absolute);
  };
  const names = new Set();
  const families = map.families.map((family, index) => {
    onlyKeys(file, `family ${index}`, family, FAMILY_KEYS);
    if (typeof family.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(family.name)) fail(file, `family ${index}: name must be lower-case words`);
    if (names.has(family.name)) fail(file, `family ${family.name} is listed twice`);
    names.add(family.name);
    const where = `family ${family.name}`;
    const modulePath = resolveModule(family.module, where);
    const target = moduleEntry(modulePath);
    target.families.push(family.name);
    const entries = (family.entries ?? []).map((entry, entryIndex) => {
      onlyKeys(file, `${where} entry ${entryIndex}`, entry, ENTRY_KEYS);
      if (typeof entry.export !== 'string') fail(file, `${where} entry ${entryIndex}: export must be a name`);
      if (entry.draft !== undefined && !Number.isInteger(entry.draft)) fail(file, `${where} ${entry.export}: draft must be an argument index`);
      if (entry.returns !== undefined && entry.returns !== 'entry-object') fail(file, `${where} ${entry.export}: returns must be "entry-object"`);
      if (target.entries.has(entry.export)) fail(file, `${where} ${entry.export} is an entry of two families`);
      target.entries.set(entry.export, { family: family.name, spec: entry });
      return entry;
    });
    if (family.allExports !== undefined && family.allExports !== true) fail(file, `${where}: allExports must be true when given`);
    if (family.inline !== undefined && family.allExports !== true) fail(file, `${where}: inline needs allExports`);
    const inline = new Set();
    for (const [inlineIndex, item] of (family.inline ?? []).entries()) {
      onlyKeys(file, `${where} inline ${inlineIndex}`, item, INLINE_KEYS);
      if (typeof item.export !== 'string' || !item.export) fail(file, `${where} inline ${inlineIndex}: export must be a name`);
      if (typeof item.reason !== 'string' || !item.reason.trim()) fail(file, `${where} inline ${item.export}: a reason is required`);
      if (inline.has(item.export) || target.entries.has(item.export)) fail(file, `${where} inline ${item.export} is listed twice, or is also an entry`);
      inline.add(item.export);
    }
    if (family.allExports === true) {
      if (target.all) fail(file, `${where}: ${target.all.family} already takes every export of this module`);
      target.all = { family: family.name, inline };
    }
    if (entries.length === 0 && family.allExports !== true) fail(file, `${where} has no entries`);
    if (family.state !== undefined && typeof family.state !== 'string') fail(file, `${where}: state must be an export name`);
    if (family.store !== undefined && (typeof family.store !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(family.store))) fail(file, `${where}: store must be an export name`);
    if (family.moduleState !== undefined) {
      onlyKeys(file, `${where} moduleState`, family.moduleState, new Set(['bindings', 'reason']));
      const { bindings, reason } = family.moduleState;
      if (!Array.isArray(bindings) || bindings.length === 0 || bindings.some((name) => typeof name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(name)) || new Set(bindings).size !== bindings.length) fail(file, `${where}: moduleState.bindings must be distinct identifiers`);
      if (typeof reason !== 'string' || !reason.trim()) fail(file, `${where}: moduleState needs a reason`);
    }
    if (family.state !== undefined && (family.store !== undefined || family.moduleState !== undefined)) fail(file, `${where}: state (an export) and store or moduleState are two ways to say the same: use one`);
    for (const [portIndex, port] of (family.ports ?? []).entries()) {
      onlyKeys(file, `${where} port ${portIndex}`, port, PORT_KEYS);
      const portPath = resolveModule(port.module, `${where} port ${portIndex}`);
      if (portPath === modulePath) fail(file, `${where}: a family cannot be its own port`);
      if (!Array.isArray(port.exports) || port.exports.length === 0) fail(file, `${where} port ${portIndex}: exports must be a list`);
      if (port.wrapAnswers !== undefined && typeof port.wrapAnswers !== 'boolean') fail(file, `${where} port ${portIndex}: wrapAnswers must be true or false`);
      if (port.reason !== undefined && (typeof port.reason !== 'string' || !port.reason.trim())) fail(file, `${where} port ${portIndex}: reason must be text`);
      const portTarget = moduleEntry(portPath);
      for (const name of port.exports) {
        if (typeof name !== 'string' || !name) fail(file, `${where} port ${portIndex}: export names must be strings`);
        if (!portTarget.ports.has(name)) portTarget.ports.set(name, { name: `module:${rel(portPath)}#${name}`, families: [], wrapAnswers: port.wrapAnswers === true });
        const entry = portTarget.ports.get(name);
        if (entry.families.includes(family.name)) fail(file, `${where}: port ${name} is listed twice`);
        // One wrapper serves every family that lists the port, so they must agree on how its answers are seen.
        if (entry.wrapAnswers !== (port.wrapAnswers === true)) fail(file, `${where}: port ${name} is listed with another wrapAnswers by another family`);
        entry.families.push(family.name);
      }
    }
    for (const [injectedIndex, injected] of (family.injected ?? []).entries()) {
      onlyKeys(file, `${where} injected ${injectedIndex}`, injected, INJECTED_KEYS);
      if (!entries.some((entry) => entry.export === injected.entry) && !(family.allExports === true && !inline.has(injected.entry)) && injected.entry !== family.store) fail(file, `${where} injected ${injectedIndex}: ${injected.entry} is not an entry`);
      if (injected.member !== undefined && (typeof injected.member !== 'string' || !injected.member)) fail(file, `${where} injected ${injectedIndex}: member must be a name`);
      if (injected.plainAnswers !== undefined && injected.plainAnswers !== true) fail(file, `${where} injected ${injectedIndex}: plainAnswers must be true when given (the port's answers are data, never port objects)`);
      if (injected.onlyFunction !== undefined && injected.onlyFunction !== true) fail(file, `${where} injected ${injectedIndex}: onlyFunction must be true when given (an argument that is no function is passed as it is)`);
      if (!Number.isInteger(injected.arg) || typeof injected.name !== 'string') fail(file, `${where} injected ${injectedIndex}: arg and name are required`);
      if (injected.wrapAnswers !== undefined && typeof injected.wrapAnswers !== 'boolean') fail(file, `${where} injected ${injectedIndex}: wrapAnswers must be true or false`);
    }
    for (const waiver of family.unorderedPorts ?? []) {
      if (typeof waiver?.port !== 'string' || typeof waiver?.reason !== 'string' || !waiver.reason.trim()) fail(file, `${where}: every unordered port needs a reason`);
    }
    return { ...family, module: modulePath, relModule: rel(modulePath) };
  });
  for (const [, target] of modules) {
    for (const [name, port] of target.ports) {
      const entry = target.entries.get(name);
      if (entry && port.families.includes(entry.family)) fail(file, `family ${entry.family}: ${name} is its own entry and its own port`);
    }
    // Two families on one module: an allExports family would take the other's exports too.
    if (target.all && target.families.length > 1) fail(file, `family ${target.all.family} takes every export of a module another family also names`);
  }
  const globals = map.globals ?? {};
  onlyKeys(file, 'globals', globals, GLOBAL_PORTS);
  for (const [name, options] of Object.entries(globals)) onlyKeys(file, `global ${name}`, options, new Set(['wrapAnswers']));
  return { file, digest: `sha256:${createHash('sha256').update(text).digest('hex')}`, families, globals, modules };
}

/**
 * The entry an export of a mapped module is, or null: a listed entry, or with
 * `allExports` any export that is not inlined (`{ family, spec, implicit }`).
 * Whether it is a function is the caller's to check: only functions are wrapped.
 */
export function entryOf(target, exportName) {
  if (!target) return null;
  const listed = target.entries.get(exportName);
  if (listed) return { ...listed, implicit: false };
  if (target.all && exportName !== 'default' && !target.all.inline.has(exportName)) return { family: target.all.family, spec: { export: exportName }, implicit: true };
  return null;
}
