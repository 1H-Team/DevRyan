import crypto from 'node:crypto';

const storage = 'globalThis[Symbol.for("devryan.context-mode.storage")]?.()';
const native = 'globalThis[Symbol.for("devryan.context-mode.storage")]';
const attributedSession = 'globalThis[Symbol.for("devryan.context-mode.call")]?.()?.sessionId';

// Every input is pinned as a whole file. The reversible edits also recognize a
// complete installed revision, so provisioning can upgrade without guessing.
export const STORAGE_PATCHES = [
  { file: 'store.js', sha256: 'c00a7014bcd7dadd9aee2586975b4cee915f4ceae923104c048610ca6a9fdd05', edits: [
    ['    #fuzzyCache = new Map();', `    #fuzzyCache = new Map();
    #workerDataVersion;
    devryanRefreshSharedCache() {
        const version = this.#db.pragma("data_version");
        if (version !== this.#workerDataVersion) {
            this.#fuzzyCache.clear();
            this.#workerDataVersion = version;
        }
    }`],
    ['    constructor(dbPath) {', `    constructor(dbPath) {
        const coordination = ${storage};
        if (coordination) coordination.run(dbPath, () => this.#open(dbPath));
        else this.#open(dbPath);
    }
    #open(dbPath) {`],
    ['        this.#initSchema();', `        const coordination = ${storage};
        if (coordination) coordination.run(this.#dbPath, () => this.#initSchema(), 1);
        else this.#initSchema();`],
    ['    cleanup() {', `    cleanup() {
        if (${native}) { closeDB(this.#db); return; }`],
    ['        const sourceId = transaction();', `        const coordination = ${storage};
        const sourceId = coordination ? coordination.transaction(this.#dbPath, transaction) : transaction();`],
    ['        const info = cleanup(maxAgeDays);', `        const coordination = ${storage};
        const info = coordination ? coordination.transaction(this.#dbPath, () => cleanup(maxAgeDays)) : cleanup(maxAgeDays);`],
    ['    #optimizeFTS() {', `    #optimizeFTS() {
        if (${native}) return; // Keep full-index defragmentation off tool completion.`],
    ['        this.#optimizeFTS(); // defragment before close', `        if (!${native}) this.#optimizeFTS(); // workers close without synchronous defragmentation`],
    ['        this.#db.transaction(() => {\n            for (const word of unique) {', '        const insert = this.#db.transaction(() => {\n            for (const word of unique) {'],
    ['        })();\n        // Invalidate fuzzy cache', `        });
        const coordination = ${storage};
        if (coordination) coordination.transaction(this.#dbPath, insert);
        else insert();
        // Invalidate fuzzy cache`],
  ] },
  { file: 'db-base.js', sha256: '1f02ca5c499661f9458374fa33627ab6be661fe2a7911fd4548eea8fc76b9452', edits: [
    ['export function cleanOrphanedWALFiles(dbPath) {', `export function cleanOrphanedWALFiles(dbPath) {
    if (${native}) return;`],
    ['export function deleteDBFiles(dbPath) {', `export function deleteDBFiles(dbPath) {
    if (${native}) throw new Error("Shared worker databases cannot be deleted during live recovery");`],
    ['export function renameCorruptDB(dbPath) {', `export function renameCorruptDB(dbPath) {
    if (${native}) throw new Error("Shared worker databases cannot be renamed during live recovery");`],
    ['export function closeDB(db) {', `export function closeDB(db) {
    if (${native}) { try { db.close(); } catch {} return; }`],
    ['export function withRetry(fn, delays = [100, 500, 2000]) {', `export function withRetry(fn, delays = [100, 500, 2000]) {
    // Native workers retry only explicitly rollback-safe transactions.
    if (${native}) return fn();`],
    ['    constructor(dbPath) {', `    constructor(dbPath) {
        const coordination = ${storage};
        if (coordination) coordination.run(dbPath, () => this.#open(dbPath));
        else this.#open(dbPath);
    }
    #open(dbPath) {`],
    ['        this.initSchema();', `        const coordination = ${storage};
        if (coordination) coordination.run(dbPath, () => this.initSchema(), 1);
        else this.initSchema();`],
    ['        return withRetry(fn);', `        const coordination = ${storage};
        return coordination ? coordination.transaction(this.#dbPath, fn) : withRetry(fn);`],
  ] },
  { file: 'session/db.js', sha256: '2fc24943ea7bdac558730ff86acfea1703e0d98c4e650d495d68f05006b80dd9', edits: [
    ['    if (existsSync(legacyPath)) {', `    if (existsSync(legacyPath)) {
        if (${native}) return legacyPath; // Never move live SQLite files or sidecars.`],
    ['        return this.stmts.get(key);', `        const statement = this.stmts.get(key);
        const coordination = ${storage};
        if (!coordination || !statement) return statement;
        return new Proxy(statement, { get: (target, property) => {
            const value = Reflect.get(target, property, target);
            if (property === "run") return (...args) => coordination.run(this.dbPath, () => value.apply(target, args));
            return typeof value === "function" ? value.bind(target) : value;
        } });`],
  ] },
  { file: 'session/persist-tool-calls.js', sha256: '386589efb86adce891676644ebd0e1cb3db3cf119ecf37a9e8a462342069a2f5', edits: [
    ['        const sdb = new SessionDB({ dbPath: sessionDbPath });', '        const shared = globalThis[Symbol.for("devryan.context-mode.session-db")]?.(sessionDbPath);\n        const sdb = shared ?? new SessionDB({ dbPath: sessionDbPath });'],
    ['            sdb.close();', '            if (!shared) sdb.close();'],
    ['            const sid = sdb.getLatestSessionId();', `            const sid = ${attributedSession} ?? sdb.getLatestSessionId();`],
  ] },
  { file: 'session/event-emit.js', sha256: 'f3ac238bdf8d360dc95ed23b0c08395b2fa179a9984c588fff755692f25e5893', edits: [
    ['        const sdb = new SessionDB({ dbPath });', '        const shared = globalThis[Symbol.for("devryan.context-mode.session-db")]?.(dbPath);\n        const sdb = shared ?? new SessionDB({ dbPath });'],
    ['                sdb.close();', '                if (!shared) sdb.close();'],
    ['            project_dir: "",', '            project_dir: globalThis[Symbol.for("devryan.context-mode.call")]?.()?.projectDir ?? "",'],
    ['            const sid = sdb.getLatestSessionId();', `            const sid = ${attributedSession} ?? sdb.getLatestSessionId();`],
  ] },
];

export const normalizeStorageSource = (source, edits) => [...edits].reverse()
  .reduce((text, [original, patched]) => text.replaceAll(patched, original), source);

export function prepareContextModeStorageHotfix({ packageRoot, fsApi, expectedStorageSha256 = {} }) {
  return STORAGE_PATCHES.map(({ file, sha256, edits }) => {
    const filePath = `${packageRoot}/build/${file}`;
    const original = normalizeStorageSource(fsApi.readFileSync(filePath, 'utf8'), edits);
    if (crypto.createHash('sha256').update(original).digest('hex') !== (expectedStorageSha256[file] ?? sha256)) {
      throw new Error(`Context-mode storage source hash is incompatible: ${file}`);
    }
    let patched = original;
    for (const [before, after] of edits) {
      if (!patched.includes(before)) throw new Error(`Context-mode storage anchor mismatch: ${file}`);
      patched = patched.replaceAll(before, after);
    }
    return [filePath, patched];
  });
}
