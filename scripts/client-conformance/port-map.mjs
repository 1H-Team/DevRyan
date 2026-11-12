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
//     "ports": [{ "module": "<path>", "exports": ["log"] }],             // may be another family's entry: also its input
//     "injected": [{ "entry": "connect", "arg": 0, "name": "sdk" },       // an object handed in is a port
//                  { "entry": "connect", "arg": 1, "key": "onEvent", "name": "onEvent" }],
//     // "wrapAnswers": true on a port or an injected item: what its calls resolve to is a port object too
//     // when it has behaviour (an SDK stream's `{ items: <async iterator> }`), one microtask later
//     "unorderedPorts": [{ "port": "...", "reason": "..." }]            // effect order not observable (waiver)
//   }],
//   "globals": { "fetch": { "wrapAnswers": true } }                     // answers wrapped as port objects
// }
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const FAMILY_KEYS = new Set(['name', 'module', 'entries', 'state', 'ports', 'injected', 'unorderedPorts', 'note']);
const ENTRY_KEYS = new Set(['export', 'draft', 'returns']);
const PORT_KEYS = new Set(['module', 'exports', 'wrapAnswers']);
const INJECTED_KEYS = new Set(['entry', 'arg', 'key', 'name', 'wrapAnswers']);
const GLOBAL_PORTS = new Set(['fetch', 'WebSocket', 'EventSource', 'localStorage', 'sessionStorage', 'document', 'window', 'crypto', 'performance']);

function fail(file, message) { throw new Error(`client-conformance port map ${path.basename(file)}: ${message}`); }
function onlyKeys(file, where, object, allowed) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) fail(file, `${where} must be an object`);
  for (const key of Object.keys(object)) if (!allowed.has(key)) fail(file, `${where} has unknown member ${key}`);
}

/**
 * Reads and validates a port map. Returns `{ file, digest, families, globals,
 * modules }` with module paths resolved (real paths); `modules` maps a module
 * path to the wrapping it needs: `{ entries: Map(export -> {family, spec}),
 * ports: Map(export -> { name, families }), families: [names] }`. An export
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
    if (!modules.has(absolute)) modules.set(absolute, { entries: new Map(), ports: new Map(), families: [] });
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
    if (entries.length === 0) fail(file, `${where} has no entries`);
    if (family.state !== undefined && typeof family.state !== 'string') fail(file, `${where}: state must be an export name`);
    for (const [portIndex, port] of (family.ports ?? []).entries()) {
      onlyKeys(file, `${where} port ${portIndex}`, port, PORT_KEYS);
      const portPath = resolveModule(port.module, `${where} port ${portIndex}`);
      if (portPath === modulePath) fail(file, `${where}: a family cannot be its own port`);
      if (!Array.isArray(port.exports) || port.exports.length === 0) fail(file, `${where} port ${portIndex}: exports must be a list`);
      if (port.wrapAnswers !== undefined && typeof port.wrapAnswers !== 'boolean') fail(file, `${where} port ${portIndex}: wrapAnswers must be true or false`);
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
      if (!entries.some((entry) => entry.export === injected.entry)) fail(file, `${where} injected ${injectedIndex}: ${injected.entry} is not an entry`);
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
  }
  const globals = map.globals ?? {};
  onlyKeys(file, 'globals', globals, GLOBAL_PORTS);
  for (const [name, options] of Object.entries(globals)) onlyKeys(file, `global ${name}`, options, new Set(['wrapAnswers']));
  return { file, digest: `sha256:${createHash('sha256').update(text).digest('hex')}`, families, globals, modules };
}
