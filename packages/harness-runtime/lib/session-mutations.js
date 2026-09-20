import fs from 'node:fs/promises';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { randomUUID, createHash } from 'node:crypto';
import { git, changeError } from './session-changes-git.js';
import { openChangeStore, changeKey } from './session-changes-store.js';
import { safeChangePath, verifyAncestors } from './session-changes-snapshot.js';
import { withCrossProcessFileLock, writeFileAtomic } from './atomic-file.js';
import { applyMutationText, initialMutationRuns, mutationText, visibleMutationRuns } from './session-mutation-text.js';

const key = (kind, id) => `${kind}/${changeKey(id)}.json`;
const permissions = (entry) => !entry || entry.deleted || entry.mode === '120000' ? null
  : entry.permissions ?? (entry.mode === '100755' ? 0o755 : 0o644);
const equal = (a, b) => (a?.hash ?? null) === (b?.hash ?? null) && (a?.mode ?? null) === (b?.mode ?? null)
  && permissions(a) === permissions(b);
const validID = (id) => typeof id === 'string' && id.length > 0 && id.length <= 1024 && !id.includes('\0');
const scopeFields = ['sessionID', 'messageID', 'userMessageID', 'callID'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inputDirectories = new Set(['node_modules', '.venv', '__pycache__']);

/** Durable mutation ledger; not an execution sandbox.
 * Adapters must enforce write confinement and stop every writer before finish.
 * The private Git metadata store pages histories and commits accepted intent
 * with an atomic ref update before the publication transaction writes files. */
export function createSessionMutationRuntime({ directory: storage, onChange = () => {}, onMaterialize } = {}) {
  if (!path.isAbsolute(storage ?? '')) throw new TypeError('Absolute mutation storage directory is required');
  const queues = new Map();
  const rootFor = (directory) => path.join(storage, changeKey(directory));
  const bytesFor = async (repo, hash) => {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw changeError('invalid_change_record');
    const bytes = await fs.readFile(path.join(repo.root, 'objects', hash));
    if (digest(bytes) !== hash) throw changeError('invalid_change_record');
    return bytes;
  };
  const putBytes = async (repo, bytes) => {
    const hash = digest(bytes), target = path.join(repo.root, 'objects', hash);
    try { await fs.access(target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await writeFileAtomic(target, bytes); }
    return hash;
  };
  const inspect = async (repo, file, directory = repo.directory) => {
    await verifyAncestors(directory, file);
    const target = path.join(directory, file);
    const stat = await fs.lstat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return null;
    if (!stat.isFile() && !stat.isSymbolicLink()) throw changeError('unsupported_file_type');
    const bytes = stat.isSymbolicLink() ? Buffer.from(await fs.readlink(target)) : await fs.readFile(target);
    return { hash: await putBytes(repo, bytes), mode: stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644',
      ...(stat.isFile() ? { permissions: stat.mode & 0o7777 } : {}),
      identity: `${stat.dev}:${stat.ino}` };
  };
  const write = async (repo, file, entry, directory = repo.directory) => {
    await verifyAncestors(directory, file);
    const target = path.join(directory, file);
    if (!entry) { await fs.rm(target, { force: true }); return; }
    const bytes = await bytesFor(repo, entry.hash);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (entry.mode !== '120000') {
      await writeFileAtomic(target, bytes, { mode: permissions(entry) });
      return;
    }
    const temporary = `${target}.devryan-${randomUUID()}`;
    try { await fs.symlink(bytes.toString(), temporary); await fs.rename(temporary, target); }
    finally { await fs.rm(temporary, { force: true }); }
  };
  const recover = async (repo) => {
    const pending = await repo.db.get('materialization.json');
    if (!pending) return;
    for await (const row of repo.db.list(`materializations/${pending.id}`)) {
      const current = await inspect(repo, row.path);
      if (equal(current, row.after)) continue;
      if (!equal(current, row.before)) throw changeError('mutation_recovery_required', 503);
      await onMaterialize?.(row);
      await write(repo, row.path, row.after);
      if (!equal(await inspect(repo, row.path), row.after)) throw changeError('mutation_recovery_required', 503);
    }
    repo.db.remove('materialization.json');
    await repo.db.commit();
  };
  const locked = async (requested, fn) => {
    const logicalDirectory = await fs.realpath(requested);
    let vcs = true;
    const root = await git(logicalDirectory, ['rev-parse', '--show-toplevel'], { limit: 16 * 1024 }).then((value) => value.toString(), (cause) => {
      if (cause.code !== 'capture_not_git') throw cause;
      vcs = false; return logicalDirectory;
    });
    const directory = await fs.realpath(root.endsWith('\n') ? root.slice(0, -1) : root);
    const relative = path.relative(directory, logicalDirectory);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw changeError('session_directory_mismatch');
    const previous = queues.get(directory) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(() => withCrossProcessFileLock(path.join(rootFor(directory), 'owner.lock'), async () => {
      const root = rootFor(directory), gitDir = path.join(root, 'git');
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      try { await fs.access(path.join(gitDir, 'HEAD')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await git(root, ['init', '--bare', '--quiet', gitDir]); }
      const db = await openChangeStore(root, gitDir);
      const meta = await db.get('meta.json') ?? { version: 1, directory, sequence: 0 };
      if (meta.version !== 1 || meta.directory !== directory) throw changeError('invalid_change_record');
      const repo = { directory, logicalDirectory, root, gitDir, db, meta, vcs };
      await recover(repo);
      const result = await fn(repo);
      db.set('meta.json', meta); await db.commit();
      return result;
    }, { timeoutMs: 30_000 }));
    queues.set(directory, work);
    try { return await work; }
    finally { if (queues.get(directory) === work) queues.delete(directory); }
  };
  const next = (repo) => ++repo.meta.sequence;
  const inactive = async (repo) => {
    const ids = new Set();
    for await (const { value } of repo.db.entries('operations')) if (!value.active || value.fileUndone) ids.add(value.id);
    return ids;
  };
  const runsFor = async (repo, id, prefix = 'runs') => {
    const runs = [];
    for await (const run of repo.db.list(`${prefix}/${id}`)) runs.push({ ...run, text: Buffer.from(run.bytes, 'base64').toString('latin1') });
    return runs;
  };
  const saveRuns = async (repo, id, runs, prefix = 'runs') => {
    const rows = function* () {
      for (const run of runs) {
        for (let offset = 0; offset < run.text.length; offset += 32_768) {
          const { text, bytes: _bytes, ...metadata } = run;
          yield { ...metadata, start: run.start + offset, bytes: Buffer.from(text.slice(offset, offset + 32_768), 'latin1').toString('base64') };
        }
      }
    };
    await repo.db.setList(`${prefix}/${id}`, rows());
  };
  const revisionsFor = async (repo, id) => {
    const revisions = [];
    for await (const revision of repo.db.list(`revisions/${id}`)) revisions.push(revision);
    return revisions;
  };
  const projection = async (repo, doc, disabled) => {
    const all = await revisionsFor(repo, doc.id);
    const revisions = all.filter((revision) => revision.owner === null || !disabled.has(revision.owner));
    const latest = revisions.at(-1);
    if (!latest) return null;
    const name = revisions.findLast((revision) => revision.path !== undefined)?.path ?? all[0]?.path;
    const mode = revisions.findLast((revision) => revision.mode !== undefined)?.mode ?? all[0]?.mode;
    const access = revisions.findLast((revision) => revision.permissions !== undefined)?.permissions;
    if (latest.deleted) return { path: name, sequence: latest.sequence, deleted: true };
    const content = revisions.findLast((revision) => revision.hash !== undefined);
    const bytes = content?.binary ? await bytesFor(repo, content.hash) : Buffer.from(mutationText(await runsFor(repo, doc.id), disabled), 'latin1');
    return { path: name, mode, ...(access === undefined ? {} : { permissions: access }),
      hash: await putBytes(repo, bytes), sequence: latest.sequence };
  };
  const activePaths = async (repo) => {
    const paths = new Map();
    for await (const { value } of repo.db.entries('files')) {
      if (value.published && (!paths.has(value.published.path)
        || (paths.get(value.published.path).published.sequence ?? 0) < (value.published.sequence ?? 0))) paths.set(value.published.path, value);
    }
    return paths;
  };
  const recordFile = async (repo, { doc, beforeRuns, baseEntry, basePath, entry, file, operation, disabled }) => {
    doc ??= { id: randomUUID(), published: null };
    const revisions = await revisionsFor(repo, doc.id);
    const before = await runsFor(repo, doc.id);
    if (entry) {
      const bytes = await bytesFor(repo, entry.hash);
      const binary = entry.mode === '120000' || bytes.includes(0) || !isUtf8(bytes);
      const runs = operation === null ? initialMutationRuns(bytes.toString('latin1'), `${doc.id}:baseline`)
        : applyMutationText(before, beforeRuns ?? visibleMutationRuns(before, disabled), bytes.toString('latin1'), operation.id);
      await saveRuns(repo, doc.id, runs);
      revisions.push({ owner: operation?.id ?? null, sequence: operation?.sequence ?? 0,
        ...(file !== (basePath ?? doc.published?.path) ? { path: file } : {}),
        ...(entry.mode !== (baseEntry ?? doc.published)?.mode ? { mode: entry.mode } : {}),
        ...(permissions(entry) !== permissions(baseEntry ?? doc.published) ? { permissions: permissions(entry) } : {}),
        ...(entry.hash !== (baseEntry ?? doc.published)?.hash ? { hash: entry.hash, binary } : {}), deleted: false });
    } else revisions.push({ owner: operation.id, sequence: operation.sequence, deleted: true });
    await repo.db.setList(`revisions/${doc.id}`, revisions);
    repo.db.set(key('files', doc.id), doc);
    return doc;
  };
  // External edits are their own origin. They cannot be attributed to whichever
  // agent happens to be active when a snapshot is observed.
  async function* filesIn(repo, relative = '') {
    for (const entry of await fs.readdir(path.join(repo.directory, relative), { withFileTypes: true })) {
      if (entry.name === '.git' || inputDirectories.has(entry.name)) continue;
      if (path.resolve(repo.directory, relative, entry.name) === storage) continue;
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) yield* filesIn(repo, file);
      else yield file;
    }
  }
  async function* dependencyInputs(directory, relative = '') {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      if (entry.name === '.git' || path.resolve(directory, relative, entry.name) === storage) continue;
      const file = path.posix.join(relative, entry.name);
      if (inputDirectories.has(entry.name)) yield file;
      else if (entry.isDirectory()) yield* dependencyInputs(directory, file);
    }
  }
  const reconcile = async (repo) => {
    const paths = await activePaths(repo), names = new Set(paths.keys()), disabled = await inactive(repo);
    for await (const file of filesIn(repo)) {
      if (safeChangePath(file)) names.add(file);
    }
    for (const file of names) {
      const doc = paths.get(file), entry = await inspect(repo, file);
      if (!doc && !entry) continue;
      if (equal(doc?.published, entry)) continue;
      const operation = doc ? { id: randomUUID(), sequence: next(repo), active: true, origin: 'external', scope: null } : null;
      const changed = await recordFile(repo, { doc, entry, file, operation, disabled });
      changed.published = entry ? { ...entry, path: file, sequence: operation?.sequence ?? 0 } : null;
      repo.db.set(key('files', changed.id), changed);
      if (operation) { operation.files = [changed.id]; repo.db.set(key('operations', operation.id), operation); }
    }
  };
  const materialize = async (repo, documents, accept) => {
    const disabled = await inactive(repo), paths = new Set();
    for (const doc of documents) {
      const after = await projection(repo, doc, disabled);
      if (doc.published) paths.add(doc.published.path);
      if (after) paths.add(after.path);
      doc.published = after;
      repo.db.set(key('files', doc.id), doc);
    }
    const rows = [], winners = await activePaths(repo);
    for (const file of paths) {
      const winner = winners.get(file)?.published;
      const after = winner?.deleted ? null : winner ?? null;
      const before = await inspect(repo, file);
      if (!equal(before, after)) rows.push({ path: file, before, after });
    }
    if (rows.length) {
      const id = randomUUID();
      await repo.db.setList(`materializations/${id}`, rows);
      repo.db.set('materialization.json', { id });
    }
    const files = rows.map((row) => ({ path: row.path, status: !row.before ? 'added' : !row.after ? 'deleted' : 'modified' }));
    // Commit the result and decision in the same durable intent as its writes.
    // Recovery must not rediscover an empty diff and lose the original receipt.
    await accept?.(files);
    repo.db.set('meta.json', repo.meta);
    await repo.db.commit();
    await recover(repo);
    return files;
  };
  const register = async (repo, input) => {
    if (!validID(input.sessionID) || !validID(input.userMessageID)) throw changeError('invalid_capture_identity', 400);
    const sessionKey = key('sessions', input.sessionID);
    let session = await repo.db.get(sessionKey);
    if (!session) session = { id: input.sessionID, parentID: input.parentID ?? null, generation: 0, pending: null };
    if (session.directory && session.directory !== repo.logicalDirectory) throw changeError('session_directory_mismatch');
    session.directory = repo.logicalDirectory;
    if (input.parentID && session.parentID && input.parentID !== session.parentID) throw changeError('capture_identity_mismatch');
    session.parentID ??= input.parentID ?? null;
    const visited = new Set([session.id]);
    const origins = {};
    let child = session;
    for (let parentID = session.parentID; parentID;) {
      if (visited.has(parentID)) throw changeError('invalid_session_lineage');
      visited.add(parentID);
      const parent = await repo.db.get(key('sessions', parentID));
      if (!parent) throw changeError('mutation_parent_unavailable');
      if (parent.pending) throw changeError('session_reverting');
      const parentGeneration = input.parentGeneration ?? session.parentGeneration;
      if (parentID === session.parentID && (parentGeneration !== undefined || parent.generation > 0)
        && parentGeneration !== parent.generation) throw changeError('execution_reverted');
      if (child.parentCallID) {
        const call = await repo.db.get(key('calls', `${parentID}\0${child.parentCallID}`));
        const lease = call && await repo.db.get(key('leases', call.token));
        if (!lease) throw changeError('mutation_history_unavailable');
        origins[parentID] = lease.promptSequence;
      }
      child = parent;
      parentID = parent.parentID;
    }
    const promptKey = key('prompts', `${input.sessionID}\0${input.userMessageID}`);
    let prompt = await repo.db.get(promptKey);
    if (prompt?.reverted) throw changeError('execution_reverted');
    if (!prompt) {
      if (session.pending) throw changeError('session_reverting');
      // Native providers discard reverted suffixes on the next prompt. Do not
      // offer a file redo whose corresponding conversation can no longer return.
      for (const rootSessionID of visited) {
        repo.db.remove(key('last-redos', rootSessionID));
        const lastKey = key('last-reverts', rootSessionID);
        const last = await repo.db.get(lastKey);
        for (const transactionID of last?.ids ?? []) {
          const tx = await repo.db.get(key('transactions', transactionID));
          if (tx?.targets.some((target) => target.id === session.id)) { repo.db.remove(lastKey); break; }
        }
      }
      prompt = { sessionID: input.sessionID, messageID: input.userMessageID, sequence: next(repo), origins };
      repo.db.set(promptKey, prompt);
    }
    repo.db.set(sessionKey, session);
    return { session, prompt };
  };
  const registerPrompt = (input) => locked(input.directory, async (repo) => {
    const { prompt } = await register(repo, input);
    return { sequence: prompt.sequence };
  });
  const assertAdmission = (input) => locked(input.directory, async (repo) => {
    if (!validID(input.sessionID)) throw changeError('invalid_capture_identity', 400);
    let session = await repo.db.get(key('sessions', input.sessionID));
    if (session?.directory && session.directory !== repo.logicalDirectory) throw changeError('session_directory_mismatch');
    const seen = new Set();
    while (session) {
      if (seen.has(session.id)) throw changeError('invalid_session_lineage');
      seen.add(session.id);
      if (session.pending) throw changeError('session_reverting');
      session = session.parentID ? await repo.db.get(key('sessions', session.parentID)) : null;
    }
    return { admitted: true };
  });
  const begin = async (input) => {
    if (!scopeFields.every((field) => validID(input[field]))) throw changeError('invalid_capture_identity', 400);
    if (input.executionFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(input.executionFingerprint)) {
      throw changeError('invalid_capture_identity', 400);
    }
    const lease = await locked(input.directory, async (repo) => {
      const { session, prompt } = await register(repo, input);
      if (session.pending) throw changeError('session_reverting');
      const scopeKey = `${input.sessionID}\0${input.callID}`;
      if (await repo.db.get(key('cancelled-calls', scopeKey))) throw changeError('execution_cancelled');
      const existing = await repo.db.get(key('calls', scopeKey));
      if (existing) {
        const old = await repo.db.get(key('leases', existing.token));
        if (!old || scopeFields.some((field) => old.scope[field] !== input[field])
          || old.parentCallID !== (input.parentCallID ?? null)
          || old.executionFingerprint !== input.executionFingerprint) throw changeError('capture_identity_mismatch');
        if (old.state === 'published' || old.state === 'ready') return old;
        throw changeError('execution_already_started');
      }
      await reconcile(repo);
      const token = randomUUID(), viewDirectory = path.join(repo.root, 'views', token, 'worktree');
      const scope = Object.fromEntries(scopeFields.map((field) => [field, input[field]]));
      const result = { token, scope, directory: repo.logicalDirectory, projectDirectory: repo.directory,
        auxiliaryDirectory: path.join(repo.root, 'context-cache'),
        workingDirectory: path.join(viewDirectory, path.relative(repo.directory, repo.logicalDirectory)),
        generation: session.generation, baseSequence: repo.meta.sequence,
        vcs: repo.vcs,
        origins: prompt.origins,
        promptSequence: prompt.sequence, viewDirectory, state: 'preparing', parentCallID: input.parentCallID ?? null,
        executionFingerprint: input.executionFingerprint };
      const disabled = await inactive(repo), base = [];
      for (const [file, doc] of await activePaths(repo)) {
        if (doc.published.deleted) continue;
        base.push({ path: file, documentID: doc.id, entry: doc.published });
        await saveRuns(repo, doc.id, visibleMutationRuns(await runsFor(repo, doc.id), disabled), `bases/${token}`);
      }
      await repo.db.setList(`bases/${token}/files`, base);
      repo.db.set(key('leases', token), result);
      repo.db.set(key('calls', scopeKey), { token });
      return result;
    });
    if (lease.state === 'ready' || lease.state === 'published') return lease;
    try {
      await fs.mkdir(lease.viewDirectory, { recursive: true, mode: 0o700 });
      // Materialization uses immutable objects captured under the publication
      // lock; commands and copying do not hold that lock.
      const root = rootFor(lease.projectDirectory), db = await openChangeStore(root, path.join(root, 'git'));
      const repo = { root, directory: lease.projectDirectory };
      for await (const file of db.list(`bases/${lease.token}/files`)) await write(repo, file.path, file.entry, lease.viewDirectory);
      await git(lease.viewDirectory, ['init', '--quiet']);
      if (lease.vcs) {
        // Git commands can inspect the real revision and staged state without
        // gaining write access to the original metadata or object database.
        const common = (await git(lease.projectDirectory, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toString().trim();
        const metadata = (await git(lease.projectDirectory, ['rev-parse', '--absolute-git-dir'])).toString().trim();
        if (/[\r\n]/.test(common)) throw changeError('invalid_execution_path');
        await fs.mkdir(path.join(lease.viewDirectory, '.git', 'objects', 'info'), { recursive: true });
        await fs.writeFile(path.join(lease.viewDirectory, '.git', 'objects', 'info', 'alternates'), path.join(common, 'objects') + '\n');
        const head = await git(lease.projectDirectory, ['rev-parse', '--verify', 'HEAD']).then((value) => value.toString().trim(), () => null);
        if (head) await git(lease.viewDirectory, ['update-ref', 'HEAD', head]);
        try { await fs.copyFile(path.join(metadata, 'index'), path.join(lease.viewDirectory, '.git', 'index')); }
        catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      }
      // The execution launcher must enforce read-only access to this input.
      // A symlink and a private cwd alone do not provide write confinement.
      for await (const file of dependencyInputs(lease.projectDirectory)) {
        await verifyAncestors(lease.viewDirectory, file);
        const target = path.join(lease.viewDirectory, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.symlink(path.join(lease.projectDirectory, file), target, 'dir');
      }
      await fs.mkdir(lease.workingDirectory, { recursive: true });
      return await locked(lease.directory, async (current) => {
        if ((await current.db.get(key('leases', lease.token)))?.state === 'cancelled') throw changeError('execution_cancelled');
        const session = await current.db.get(key('sessions', lease.scope.sessionID));
        if (session.generation !== lease.generation || session.pending) throw changeError('execution_reverted');
        const base = [];
        for await (const file of current.db.list(`bases/${lease.token}/files`)) {
          base.push({ ...file, identity: (await inspect(current, file.path, lease.viewDirectory))?.identity });
        }
        await current.db.setList(`bases/${lease.token}/files`, base);
        lease.state = 'ready'; current.db.set(key('leases', lease.token), lease); return lease;
      });
    } catch (error) {
      // This method has not admitted a writer. A failed/cancelled copy must not
      // leave an immortal preparing lease that later recovery cannot attest.
      await locked(lease.directory, async (repo) => {
        const current = await repo.db.get(key('leases', lease.token));
        if (current?.state === 'preparing') { current.state = 'cancelled'; repo.db.set(key('leases', lease.token), current); }
      }).catch(() => {});
      await fs.rm(path.dirname(lease.viewDirectory), { recursive: true, force: true });
      throw error;
    }
  };
  const finish = async ({ directory, token, renames = [] }) => {
    const result = await locked(directory, async (repo) => {
      const lease = await repo.db.get(key('leases', token));
      if (!lease) throw changeError('execution_unavailable');
      if (lease.state === 'published') return lease.result;
      const session = await repo.db.get(key('sessions', lease.scope.sessionID));
      if (session.generation !== lease.generation || session.pending) throw changeError('execution_reverted');
      if (lease.state !== 'ready') throw changeError('execution_not_ready');
      await reconcile(repo);
      const base = new Map(), identities = new Map();
      for await (const file of repo.db.list(`bases/${token}/files`)) { base.set(file.path, file); if (file.identity) identities.set(file.identity, file); }
      const files = new Map();
      for await (const file of filesIn({ directory: lease.viewDirectory, vcs: lease.vcs !== false })) {
        if (!safeChangePath(file) || file === 'node_modules') continue;
        files.set(file, await inspect(repo, file, lease.viewDirectory));
      }
      // Tracked files remain captured even if the command changes ignore rules.
      for (const file of base.keys()) if (!files.has(file)) files.set(file, await inspect(repo, file, lease.viewDirectory));
      const renamed = new Map(), sources = new Set();
      if (!Array.isArray(renames)) throw changeError('invalid_rename_receipt');
      for (const move of renames) {
        if (!safeChangePath(move?.from) || !safeChangePath(move?.to) || move.from === move.to
          || sources.has(move.from) || renamed.has(move.to) || !base.has(move.from)
          || files.get(move.from) || !files.get(move.to)) throw changeError('invalid_rename_receipt');
        sources.add(move.from); renamed.set(move.to, base.get(move.from));
      }
      const operation = { id: randomUUID(), sequence: next(repo), scope: lease.scope, parentCallID: lease.parentCallID,
        promptSequence: lease.promptSequence, origins: lease.origins,
        active: true, origin: 'execution', files: [], baseSequence: lease.baseSequence };
      const changed = new Map(), moved = new Set(), disabled = await inactive(repo);
      for (const [file, entry] of files) {
        let from = renamed.get(file) ?? base.get(file);
        if (renamed.has(file)) moved.add(from.path);
        if (!from && entry) {
          const candidate = identities.get(entry.identity);
          if (candidate && !files.get(candidate.path)) { from = candidate; moved.add(candidate.path); }
        }
        if (from?.path === file && equal(from.entry, entry) || !from && !entry) continue;
        if (!entry) continue;
        const doc = from ? await repo.db.get(key('files', from.documentID)) : null;
        const updated = await recordFile(repo, { doc, entry, file, operation, disabled, baseEntry: from?.entry, basePath: from?.path,
          beforeRuns: from ? await runsFor(repo, from.documentID, `bases/${token}`) : [] });
        changed.set(updated.id, updated);
      }
      for (const [file, from] of base) {
        if (files.get(file) || moved.has(file)) continue;
        const doc = await repo.db.get(key('files', from.documentID));
        const updated = await recordFile(repo, { doc, entry: null, file, operation, disabled });
        changed.set(updated.id, updated);
      }
      operation.files = [...changed.keys()];
      const receipt = [];
      for (const file of new Set([...base.keys(), ...files.keys()])) {
        const before = base.get(file)?.entry ?? null, after = files.get(file) ?? null;
        if (!equal(before, after)) receipt.push({ path: file, before, after });
      }
      await repo.db.setList(`publications/${token}/files`, receipt);
      repo.db.set(key('operations', operation.id), operation);
      await materialize(repo, [...changed.values()], (files) => {
        lease.state = 'published'; lease.result = { operationID: operation.id, sequence: operation.sequence, files };
        repo.db.set(key('leases', token), lease);
      });
      return lease.result;
    });
    await onChange({ directory, ...result });
    return result;
  };
  const prepareRevert = (input) => locked(input.directory, async (repo) => {
    const prompt = await repo.db.get(key('prompts', `${input.sessionID}\0${input.messageID}`));
    if (!prompt) throw changeError('mutation_history_unavailable');
    const pending = (await repo.db.get(key('sessions', input.sessionID)))?.pending;
    if (pending) {
      const previous = await repo.db.get(key('transactions', pending));
      if (previous && !previous.redo && previous.boundarySequence === prompt.sequence
        && previous.scope === (input.scope ?? 'tree')) return previous;
      throw changeError('session_reverting');
    }
    if (prompt.reverted) {
      const receipt = await repo.db.get(key('last-reverts', input.sessionID));
      const previous = receipt?.ids?.length && await repo.db.get(key('transactions', receipt.ids.at(-1)));
      // A delayed retry of a later boundary must not reveal messages while
      // leaving their operations disabled by an earlier completed Revert.
      if (previous?.state !== 'committed' || previous.redo || previous.boundarySequence > prompt.sequence) {
        throw changeError('mutation_history_unavailable');
      }
      if (previous.boundarySequence < prompt.sequence || (previous.scope ?? 'tree') === 'tree' || input.scope === 'session') return previous;
      // The same boundary may deliberately expand from session-only to tree.
      // Keep the root boundary and select the still-active descendant work.
    }
    const members = new Set([input.sessionID]), sessions = [];
    for await (const { value } of repo.db.entries('sessions')) sessions.push(value);
    if (input.scope !== 'session') {
      for (let grew = true; grew;) {
        grew = false;
        for (const session of sessions) if (members.has(session.parentID) && !members.has(session.id)) { members.add(session.id); grew = true; }
      }
    }
    const selected = [], targets = new Map([[input.sessionID, { id: input.sessionID, targetMessageID: input.messageID }]]);
    const prompts = [];
    for await (const { value } of repo.db.entries('prompts')) if (members.has(value.sessionID)) prompts.push(value);
    prompts.sort((a, b) => a.sequence - b.sequence);
    for (const candidate of prompts) {
      if ((candidate.origins?.[input.sessionID] ?? candidate.sequence) >= prompt.sequence && !targets.has(candidate.sessionID)) {
        targets.set(candidate.sessionID, { id: candidate.sessionID, targetMessageID: candidate.messageID });
      }
    }
    const operations = [];
    for await (const { value } of repo.db.entries('operations')) operations.push(value);
    operations.sort((a, b) => a.sequence - b.sequence);
    for (const op of operations) {
      if (!op.active || !members.has(op.scope?.sessionID) || (op.origins?.[input.sessionID] ?? op.sequence) < prompt.sequence
        || op.scope.sessionID === input.sessionID && (op.promptSequence ?? op.sequence) < prompt.sequence) continue;
      selected.push(op.id);
      if (!targets.has(op.scope.sessionID)) targets.set(op.scope.sessionID, { id: op.scope.sessionID,
        targetMessageID: op.scope.messageID, callID: op.scope.callID });
    }
    const id = randomUUID();
    repo.db.remove(key('last-redos', input.sessionID));
    for (const session of sessions) {
      if (!members.has(session.id)) continue;
      if (session.pending) throw changeError('session_reverting');
      session.generation++; session.pending = id; repo.db.set(key('sessions', session.id), session);
    }
    const tx = { id, rootSessionID: input.sessionID, boundarySequence: prompt.sequence,
      state: 'prepared', phase: 'prepared', scope: input.scope ?? 'tree',
      targets: [...targets.values()], members: [...members], redo: false };
    await repo.db.setList(`transactions/${id}/operations`, selected);
    repo.db.set(key('transactions', id), tx);
    return tx;
  });
  const settleRevert = (input) => locked(input.directory, async (repo) => {
    const tx = await repo.db.get(key('transactions', input.transactionID));
    if (!tx) throw changeError('revert_unavailable');
    if (tx.state === 'committed') return tx.result;
    if (tx.state !== 'prepared') throw changeError('revert_unavailable');
    const documents = new Map();
    if (input.commit) {
      await reconcile(repo);
      for await (const id of repo.db.list(`transactions/${tx.id}/operations`)) {
        const op = await repo.db.get(key('operations', id));
        if (!op) throw changeError('invalid_change_record');
        if (tx.kind === 'files') op.fileUndone = !tx.redo;
        else op.active = tx.redo;
        repo.db.set(key('operations', id), op);
        for (const file of op.files) documents.set(file, await repo.db.get(key('files', file)));
      }
      if (tx.kind !== 'files') for await (const { key: promptKey, value: prompt } of repo.db.entries('prompts')) {
        if (tx.members.includes(prompt.sessionID) && (prompt.origins?.[tx.rootSessionID] ?? prompt.sequence) >= tx.boundarySequence) {
          prompt.reverted = !tx.redo;
          repo.db.set(promptKey, prompt);
        }
      }
    }
    const accept = async (files) => {
      tx.state = input.commit ? 'committed' : 'cancelled';
      tx.phase = tx.state;
      tx.result = { files, sessions: tx.targets, redoAvailable: input.commit && !tx.redo };
      repo.db.set(key('transactions', tx.id), tx);
      for (const member of tx.members) {
        const session = await repo.db.get(key('sessions', member));
        if (session?.pending === tx.id) { session.pending = null; repo.db.set(key('sessions', member), session); }
      }
      if (input.commit && tx.kind === 'files') return;
      if (input.commit && !tx.redo) {
        const previous = await repo.db.get(key('last-reverts', tx.rootSessionID));
        repo.db.set(key('last-reverts', tx.rootSessionID), { ids: [...(previous?.ids ?? []), tx.id] });
      } else if (input.commit) {
        repo.db.remove(key('last-reverts', tx.rootSessionID));
        repo.db.set(key('last-redos', tx.rootSessionID), { id: tx.id });
      }
    };
    if (input.commit) await materialize(repo, [...documents.values()], accept);
    else await accept([]);
    return tx.result;
  });
  const prepareRedo = (input) => locked(input.directory, async (repo) => {
    const pending = (await repo.db.get(key('sessions', input.sessionID)))?.pending;
    if (pending) {
      const previous = await repo.db.get(key('transactions', pending));
      if (previous?.redo && previous.rootSessionID === input.sessionID) return previous;
      throw changeError('session_reverting');
    }
    const last = await repo.db.get(key('last-reverts', input.sessionID));
    if (!last?.ids?.length) {
      const receipt = await repo.db.get(key('last-redos', input.sessionID));
      const completed = receipt && await repo.db.get(key('transactions', receipt.id));
      if (completed?.state === 'committed' && completed.redo) return completed;
      throw changeError('redo_unavailable');
    }
    const operations = new Set(), members = new Set(), targets = new Map();
    let boundarySequence = Infinity;
    for (const previousID of last.ids) {
      const previous = await repo.db.get(key('transactions', previousID));
      if (!previous || previous.state !== 'committed' || previous.redo) throw changeError('redo_unavailable');
      for await (const op of repo.db.list(`transactions/${previousID}/operations`)) operations.add(op);
      for (const member of previous.members) members.add(member);
      for (const target of previous.targets) targets.set(target.id, target);
      boundarySequence = Math.min(boundarySequence, previous.boundarySequence);
    }
    const id = randomUUID(), tx = { id, rootSessionID: input.sessionID, members: [...members],
      targets: [...targets.values()], boundarySequence, redo: true, state: 'prepared', phase: 'prepared' };
    for (const member of tx.members) {
      const session = await repo.db.get(key('sessions', member));
      if (session.pending) throw changeError('session_reverting');
      session.generation++; session.pending = id; repo.db.set(key('sessions', member), session);
    }
    await repo.db.setList(`transactions/${id}/operations`, operations);
    repo.db.set(key('transactions', id), tx); return tx;
  });
  const prepareFileRestore = (input) => locked(input.directory, async (repo) => {
    if (!validID(input.sessionID) || !validID(input.revision) || !Array.isArray(input.calls)
      || !input.calls.length || input.calls.some((call) => !validID(call.sessionID) || !validID(call.callID))) {
      throw changeError('mutation_history_unavailable');
    }
    const identity = JSON.stringify([input.sessionID, input.revision, input.redo === true]);
    const receipt = await repo.db.get(key('file-restores', identity));
    const fingerprint = digest(Buffer.from(JSON.stringify(input.calls.map((call) => [call.sessionID, call.callID]).sort())));
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw changeError('capture_identity_mismatch');
      const previous = await repo.db.get(key('transactions', receipt.id));
      if (!previous) throw changeError('mutation_recovery_failed');
      if (previous.state !== 'cancelled') return previous;
    }
    const members = new Set([input.sessionID]), operations = new Set();
    for (const call of input.calls) {
      const entry = await repo.db.get(key('calls', `${call.sessionID}\0${call.callID}`));
      const lease = entry && await repo.db.get(key('leases', entry.token));
      if (lease?.state !== 'published' || !lease.result?.operationID) throw changeError('mutation_history_unavailable');
      if (call.messageID && call.messageID !== lease.scope.messageID) throw changeError('capture_identity_mismatch');
      let id = call.sessionID;
      const seen = new Set();
      while (id !== input.sessionID) {
        if (!id || seen.has(id)) throw changeError('invalid_session_lineage');
        seen.add(id); members.add(id);
        id = (await repo.db.get(key('sessions', id)))?.parentID;
      }
      operations.add(lease.result.operationID);
    }
    const id = randomUUID();
    // A hidden descendant may still publish through an older parent call.
    // Fence the entire selected review tree before waiting for termination.
    const descendants = [];
    for await (const { value } of repo.db.entries('sessions')) descendants.push(value);
    for (let grew = true; grew;) {
      grew = false;
      for (const session of descendants) if (members.has(session.parentID) && !members.has(session.id)) {
        members.add(session.id); grew = true;
      }
    }
    for (const member of members) {
      const session = await repo.db.get(key('sessions', member));
      if (!session || session.pending) throw changeError('session_reverting');
      session.generation++; session.pending = id; repo.db.set(key('sessions', member), session);
    }
    const tx = { id, kind: 'files', rootSessionID: input.sessionID, members: [...members], targets: [],
      boundarySequence: 0, redo: input.redo === true, state: 'prepared', phase: 'prepared' };
    await repo.db.setList(`transactions/${id}/operations`, operations);
    repo.db.set(key('transactions', id), tx);
    repo.db.set(key('file-restores', identity), { id, fingerprint });
    return tx;
  });
  const leaseForCall = (input) => locked(input.directory, async (repo) => {
    const call = await repo.db.get(key('calls', `${input.sessionID}\0${input.callID}`));
    return call ? repo.db.get(key('leases', call.token)) : null;
  });
  const aliasCalls = (input) => locked(input.directory, async (repo) => {
    const lease = await repo.db.get(key('leases', input.token));
    if (!lease || !Array.isArray(input.calls) || input.calls.some((call) => !validID(call))) throw changeError('capture_identity_mismatch');
    for (const callID of input.calls) {
      const callKey = key('calls', `${lease.scope.sessionID}\0${callID}`), existing = await repo.db.get(callKey);
      if (existing && existing.token !== lease.token) throw changeError('capture_identity_mismatch');
      repo.db.set(callKey, { token: lease.token });
    }
  });
  const executionReceipt = (input) => locked(input.directory, async (repo) => {
    const lease = await repo.db.get(key('leases', input.token));
    if (lease?.state !== 'published') throw changeError('execution_unavailable');
    const files = [];
    const content = async (entry) => entry ? { bytes: await bytesFor(repo, entry.hash), mode: entry.mode } : null;
    for await (const file of repo.db.list(`publications/${input.token}/files`)) {
      files.push({ path: path.join(repo.directory, file.path), before: await content(file.before), after: await content(file.after) });
    }
    return { ...lease.scope, directory: lease.directory, source: 'confined-execution', complete: true, files };
  });
  const claimLease = (input) => locked(input.directory, async (repo) => {
    const lease = await repo.db.get(key('leases', input.token));
    if (!['control', 'process'].includes(input.kind) || lease?.state !== 'ready' || lease.executionKind) throw changeError('execution_already_started');
    const session = await repo.db.get(key('sessions', lease.scope.sessionID));
    if (session?.pending || session?.generation !== lease.generation) throw changeError('execution_reverted');
    lease.executionKind = input.kind;
    repo.db.set(key('leases', input.token), lease); return lease;
  });
  const registerChild = (input) => locked(input.directory, async (repo) => {
    if (!validID(input.sessionID) || !validID(input.parentID) || !validID(input.parentCallID)) throw changeError('invalid_capture_identity');
    const parent = await repo.db.get(key('sessions', input.parentID));
    const call = await repo.db.get(key('calls', `${input.parentID}\0${input.parentCallID}`));
    const lease = call && await repo.db.get(key('leases', call.token));
    if (!parent || parent.pending || !lease || lease.generation !== parent.generation || !['ready', 'published'].includes(lease.state)) {
      throw changeError('execution_reverted');
    }
    const session = await repo.db.get(key('sessions', input.sessionID));
    if (session && session.parentID !== input.parentID) throw changeError('invalid_session_lineage');
    if (session?.pending) throw changeError('session_reverting');
    repo.db.set(key('sessions', input.sessionID), { id: input.sessionID, generation: 0, pending: null, ...session,
      parentID: input.parentID, parentGeneration: parent.generation, parentCallID: input.parentCallID });
    return { parentGeneration: parent.generation };
  });
  const transaction = (input) => locked(input.directory, (repo) => repo.db.get(key('transactions', input.transactionID)));
  const updateTransaction = (input) => locked(input.directory, async (repo) => {
    const tx = await repo.db.get(key('transactions', input.transactionID));
    if (!tx || tx.state !== 'prepared') throw changeError('revert_unavailable');
    if (input.expectedPhase !== tx.phase) throw changeError('revert_phase_mismatch');
    const transitions = { prepared: ['stopped', 'restoring'], stopped: ['conversation', 'restoring'],
      conversation: ['files', 'restoring'], restoring: ['restoring'], files: [] };
    if (!transitions[tx.phase]?.includes(input.phase)) throw changeError('revert_phase_mismatch');
    if (input.boundaries) {
      if (tx.boundaries || !Array.isArray(input.boundaries) || input.boundaries.length !== tx.targets.length
        || tx.targets.some((target) => input.boundaries.filter((item) => item.id === target.id).length !== 1)) {
        throw changeError('invalid_revert_boundaries');
      }
      tx.boundaries = input.boundaries;
    }
    if (input.phase === 'conversation' && !tx.boundaries) throw changeError('invalid_revert_boundaries');
    tx.phase = input.phase;
    repo.db.set(key('transactions', tx.id), tx);
    return tx;
  });
  const pendingTransactions = (input) => locked(input.directory, async (repo) => {
    const entries = [];
    for await (const { value } of repo.db.entries('transactions')) if (value.state === 'prepared') entries.push(value);
    return entries;
  });
  const cancelLease = (input) => locked(input.directory, async (repo) => {
    const lease = await repo.db.get(key('leases', input.token));
    if (!lease) throw changeError('execution_unavailable');
    if (lease.state === 'published') throw changeError('execution_already_published');
    lease.state = 'cancelled'; repo.db.set(key('leases', lease.token), lease);
  });
  const cancelUnstartedCall = (input) => locked(input.directory, async (repo) => {
    if (!validID(input.sessionID) || !validID(input.callID) || !validID(input.messageID)) throw changeError('invalid_capture_identity');
    const scopeKey = `${input.sessionID}\0${input.callID}`, call = await repo.db.get(key('calls', scopeKey));
    if (call) {
      const lease = await repo.db.get(key('leases', call.token));
      if (!lease || lease.scope.messageID !== input.messageID || input.token && lease.token !== input.token) throw changeError('capture_identity_mismatch');
      if (lease.state === 'published') throw changeError('execution_already_published');
      lease.state = 'cancelled'; repo.db.set(key('leases', lease.token), lease);
    }
    repo.db.set(key('cancelled-calls', scopeKey), { messageID: input.messageID });
  });
  const activeLeases = (input) => locked(input.directory, async (repo) => {
    const entries = [];
    for await (const { value } of repo.db.entries('leases')) {
      if (['preparing', 'ready'].includes(value.state) && (!input.sessions || input.sessions.includes(value.scope.sessionID))) entries.push(value);
    }
    return entries;
  });
  const projectDirectories = async () => {
    const directories = [];
    for (const entry of await fs.readdir(storage, { withFileTypes: true }).catch((cause) => { if (cause.code === 'ENOENT') return []; throw cause; })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const root = path.join(storage, entry.name);
      const db = await openChangeStore(root, path.join(root, 'git'));
      const meta = await db.get('meta.json');
      if (meta?.version === 1 && path.isAbsolute(meta.directory ?? '')) directories.push(meta.directory);
    }
    return directories;
  };
  return { projectDirectories, projectDirectory: (input) => locked(input.directory, (repo) => repo.directory),
    assertAdmission, registerPrompt, registerChild, begin, claimLease, finish, executionReceipt, aliasCalls, prepareRevert, prepareRedo, prepareFileRestore, settleRevert, leaseForCall,
    transaction, updateTransaction, pendingTransactions, cancelLease, cancelUnstartedCall, activeLeases,
    drain: () => Promise.allSettled([...queues.values()]) };
}
