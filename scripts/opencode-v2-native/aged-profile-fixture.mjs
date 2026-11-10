// Aged-profile upgrade corpus: the ledger and conversation shapes that locked
// users out of earlier releases, written into a bundle's web data the way the
// product writes them. The startup, clone and upgrade gates
// (runtime-bundle.test.js, bundle-harness-integrity.test.js) run over it.
//
// Ledger records come from the product's own writers: the session-mutation
// runtime (leases, reverts, shell jobs, native removals, module overlays), the
// orchestration codec (task ledger) and the native Cursor recovery (intents).
// The few things no writer can produce in a test are written by hand and named
// as such: OpenCode's own rows (sessions, messages, archived flags, inbox
// notices), which `seedAgedNativeDatabase` inserts and the bundle verifier reads
// back; a lost termination receipt; an aged reservation time and a dead owner's
// lock file; and bulk files.
//
// Each scenario is selectable by name, cites the incident it reproduces and
// declares the documented outcome. While writing, each scenario records the
// exact records that outcome names (`profile.expected`), so the gates compare
// findings per record, never per code or key prefix. Scenarios use disjoint
// session IDs, so any selection composes into one profile.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSessionMutationRuntime } from '../../packages/harness-runtime/lib/session-mutations.js';
import { git } from '../../packages/harness-runtime/lib/session-changes-git.js';
import { changeKey, openChangeStore } from '../../packages/harness-runtime/lib/session-changes-store.js';
import { createManagedTaskRecord } from '../../packages/orchestration-runtime/contract.js';
import { assertManagedTaskTransition } from '../../packages/orchestration-runtime/transitions.js';
import { createManagedTaskResultEnvelope } from '../../packages/orchestration-runtime/result-envelope.js';
import { encodeLedgerSnapshot } from '../../packages/orchestration-runtime/codec.js';
import { createNativeCursorRecovery } from '../../packages/web/server/lib/opencode/runtime-host/native-cursor-recovery.js';

const receipt = ({ cancelled = false } = {}) => JSON.stringify({ terminated: true, confined: true, exitCode: cancelled ? 143 : 0, cancelled });
const writeReceipt = (lease, options) => fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'), receipt(options), { flag: 'wx', mode: 0o600 });
const leaseKey = token => `leases/${changeKey(token)}.json`;
const transactionKey = id => `transactions/${changeKey(id)}.json`;
/** The bundle ID an intent stamped by the bundle before an upgrade carries (the default first bundle). */
export const AGED_PROFILE_SOURCE_BUNDLE_ID = 'default-native';
/** The owner of the claimed process lease: its lock file is left, unlocked, by the dead process. */
export const AGED_PROFILE_DEAD_OWNER_ID = '70000000-0000-4000-8000-0000000000a1';

/**
 * name: selectable scenario; incident: what it reproduces; outcome: the
 * documented result, as codes (the exact records are in `profile.expected`):
 * - findings: codes the verifier reports instead of refusing, one per record;
 * - copyFindings: codes the clone's copy reports, one per entry;
 * - strictRefusal: the code the strict gate raises when startup recovery has
 *   not settled the record first (null: the strict gate admits the shape as is).
 * `profile.expected` also lists what startup recovery must settle
 * (settledLeases, cancelledReverts), what the clone leaves behind
 * (droppedInbox, derivedLinks: web-data paths of ledger links the copy must not
 * carry) and the Cursor intents the upgraded owner must adopt.
 */
export const AGED_PROFILE_SCENARIOS = Object.freeze([
  {
    name: 'abandoned-control-lease',
    // 2026-10-13 lockout (deleted 2.0.10 line): a lease reserved by a process
    // that is gone made every launch refuse `bundle_execution_unsettled`; cold
    // startup now settles never-spawned control leases before verification.
    incident: '2026-10-13 bundle_execution_unsettled (control lease left by a gone process)',
    outcome: { findings: [], copyFindings: [], strictRefusal: 'bundle_execution_unsettled' },
    async write(context) {
      const session = context.liveSession('ses_aged_control'), user = context.message(session, 'user'), assistant = context.message(session, 'assistant');
      // An earlier build reserved control leases without an owner and its process died before claiming.
      const lease = await context.runtime.begin({ directory: context.directory, sessionID: session, userMessageID: user, messageID: assistant, callID: 'call_aged_control', kind: 'control' });
      context.expected.settledLeases.push({ key: leaseKey(lease.token), state: 'cancelled' });
    },
  },
  {
    name: 'claimed-process-lease-owner-gone',
    // 2026-10-13 lockout, first blocker (deleted 2.0.10 line): a Cursor process
    // lease was claimed, its supervisor never started (no termination.json) and
    // its owning host died, so every launch refused `bundle_execution_unsettled`.
    // Cold startup probes the dead owner with the execution launcher and cancels
    // a `ready` process lease with no receipt long after its reservation.
    incident: '2026-10-13 bundle_execution_unsettled (claimed process lease, no receipt, owner gone)',
    outcome: { findings: [], copyFindings: [], strictRefusal: 'bundle_execution_unsettled' },
    async write(context) {
      const session = context.liveSession('ses_aged_claimed'), user = context.message(session, 'user'), assistant = context.message(session, 'assistant');
      const lease = await context.runtime.begin({ directory: context.directory, sessionID: session, userMessageID: user, messageID: assistant,
        callID: 'call_aged_claimed', ownerID: AGED_PROFILE_DEAD_OWNER_ID });
      await context.runtime.claimLease({ directory: context.directory, token: lease.token, kind: 'process' });
      // Hand-written: the dead owner's lock file (unlocked) and the age of the reservation.
      const owners = path.join(context.webDataDirectory, 'harness', 'execution-owners');
      await fs.mkdir(owners, { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(owners, `${AGED_PROFILE_DEAD_OWNER_ID}.lock`), '', { mode: 0o600 });
      context.afterWriters(async ledger => {
        const key = leaseKey(lease.token);
        ledger.set(key, { ...await ledger.get(key), reservedAt: Date.now() - 60 * 60_000 });
      });
      context.expected.settledLeases.push({ key: leaseKey(lease.token), state: 'cancelled', cancelledBeforeStart: true });
    },
  },
  {
    name: 'process-lease-receipt-gone',
    // 2026-10-13 used ledger: a settled process lease whose supervisor receipt
    // is gone is finished history, reported as a finding, never a refusal.
    incident: '2026-10-13 used ledger (terminal process lease without its termination receipt)',
    outcome: { findings: ['bundle_execution_unsettled'], copyFindings: [], strictRefusal: null },
    async write(context) {
      const session = context.liveSession('ses_aged_receipt');
      const lease = await context.edit(session, 'f-receipt.txt');
      // Hand-written step: the receipt file was lost (no writer deletes it).
      await fs.rm(path.join(path.dirname(lease.viewDirectory), 'termination.json'));
      context.expected.findings.push({ code: 'bundle_execution_unsettled', key: leaseKey(lease.token) });
    },
  },
  {
    name: 'unstarted-revert',
    // 2026-11-01 live QA: a revert whose cancellation failed stayed `prepared`
    // and poisoned the worktree (`native_managed_task_control_invalid`), and a
    // prepared transaction refuses migration (`migration_revert_pending`); cold
    // startup cancels a revert that never reached the conversation.
    incident: '2026-11-01 revert poison (prepared revert transaction left behind)',
    outcome: { findings: [], copyFindings: [], strictRefusal: 'migration_revert_pending' },
    async write(context) {
      const session = context.liveSession('ses_aged_unstarted');
      await context.edit(session, 'f-unstarted.txt');
      const tx = await context.runtime.prepareRevert({ directory: context.directory, sessionID: session, messageID: context.lastUser(session) });
      context.expected.cancelledReverts.push({ key: transactionKey(tx.id), sessionKey: `sessions/${changeKey(session)}.json` });
    },
  },
  {
    name: 'cancelled-revert-deleted-target',
    // 2026-11-02 lockout (2.0.11 fix): deleting every session left a cancelled
    // revert whose targets `{id,targetMessageID}` had no owner, and every launch
    // refused `bundle_message_reference_lost`.
    incident: '2026-11-02 / v2.0.11 bundle_message_reference_lost (cancelled revert of a deleted session)',
    outcome: { findings: [], copyFindings: [], strictRefusal: null },
    async write(context) {
      const session = context.deletedSession('ses_aged_cancelled_revert');
      await context.edit(session, 'f-cancelled-a.txt'); await context.edit(session, 'f-cancelled-b.txt');
      const tx = await context.runtime.prepareRevert({ directory: context.directory, sessionID: session, messageID: context.lastUser(session) });
      await context.runtime.settleRevert({ directory: context.directory, transactionID: tx.id, commit: false });
      await context.removeSession(session);
    },
  },
  {
    name: 'committed-revert-deleted-session',
    // v2.0.11 regression row: a deleted session with a reverted turn.
    incident: 'v2.0.11 deleted session with a reverted turn',
    outcome: { findings: [], copyFindings: [], strictRefusal: null },
    async write(context) {
      const session = context.deletedSession('ses_aged_committed_revert');
      await context.edit(session, 'f-committed-a.txt'); await context.edit(session, 'f-committed-b.txt');
      const tx = await context.runtime.prepareRevert({ directory: context.directory, sessionID: session, messageID: context.lastUser(session) });
      await context.runtime.settleRevert({ directory: context.directory, transactionID: tx.id, commit: true });
      await context.removeSession(session);
    },
  },
  {
    name: 'deleted-registered-child',
    // 2026-10-13 lockout, fourth blocker: a child session registered by its
    // parent's call has no `directory` on its ledger record; once deleted, the
    // verifier refused `bundle_native_removal_invalid`.
    incident: '2026-10-13 bundle_native_removal_invalid (deleted child without a recorded directory)',
    outcome: { findings: [], copyFindings: [], strictRefusal: null },
    async write(context) {
      const parent = context.liveSession('ses_aged_parent'), child = context.deletedSession('ses_aged_child');
      await context.edit(parent, 'f-parent.txt', async lease => {
        await context.runtime.registerChild({ directory: context.directory, sessionID: child, parentID: parent, parentCallID: lease.scope.callID });
      });
      await context.removeSession(child, { parentID: parent });
    },
  },
  {
    name: 'module-overlay-links',
    // 2026-10-13 lockout, second blocker: a call with a `node_modules` input
    // leaves link overlays under the ledger's `module-overlays/`; the upgrade
    // copy refused them as `bundle_symlink_source`. The overlays are derived
    // (preparation re-syncs them): the copy leaves the tree behind.
    incident: '2026-10-13 bundle_symlink_source (module-overlays links in the ledger)',
    outcome: { findings: [], copyFindings: [], strictRefusal: null },
    async write(context) {
      const session = context.liveSession('ses_aged_overlay');
      // A dependency folder the project ignores, as an installed package would be.
      const dependency = path.join(context.directory, 'node_modules', 'aged-dependency');
      await fs.mkdir(dependency, { recursive: true }); await fs.writeFile(path.join(dependency, 'index.js'), 'export default 1;\n');
      await fs.appendFile(path.join(context.directory, '.gitignore'), 'node_modules\n');
      await context.edit(session, 'f-overlay.txt');
      const overlays = path.join(context.ledgerRoot(), 'module-overlays');
      context.afterWriters(async () => {
        const walk = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => {
          const file = path.join(directory, entry.name);
          return entry.isSymbolicLink() ? [file] : entry.isDirectory() ? walk(file) : [];
        }))).flat();
        const links = (await walk(overlays)).map(file => path.relative(context.webDataDirectory, file)).sort();
        if (!links.some(link => link.endsWith('/aged-dependency'))) throw new Error('aged-profile: the writer left no module overlay link');
        context.expected.derivedLinks.push(...links);
      });
    },
  },
  {
    name: 'cursor-intent-previous-bundle',
    // 2026-10-13 lockout, third blocker: a `harness/native-cursor/` intent
    // stamped with the old bundle ID was cloned into the upgraded bundle, and
    // the new owner refused it as `native_cursor_recovery_owner_mismatch`. The
    // upgraded owner adopts intents of the bundle it was cloned from.
    incident: '2026-10-13 native_cursor_recovery_owner_mismatch (Cursor intent of the previous bundle)',
    outcome: { findings: [], copyFindings: [], strictRefusal: null },
    async write(context) {
      const session = context.liveSession('ses_aged_cursor'), user = context.message(session, 'user'), assistant = context.message(session, 'assistant');
      const recovery = createNativeCursorRecovery({ directory: path.join(context.webDataDirectory, 'harness', 'native-cursor'), ownerID: AGED_PROFILE_SOURCE_BUNDLE_ID, runtime: context.runtime });
      const scope = { controllerInstanceID: 'aged-controller', directory: context.directory, sessionID: session, userMessageID: user, assistantMessageID: assistant, agent: 'fixer', modelID: 'composer-fixture' };
      await recovery.stage({ scope, revision: 0 }); await recovery.drain();
      context.expected.cursorIntents.push({ sessionID: session, assistantMessageID: assistant });
    },
  },
  {
    name: 'archived-cancelled-shell-notice',
    // 2026-10-29 lockouts (v2.0.4 and v2.0.5): a cancelled background shell
    // queued a synthetic notice into a subagent session that was later
    // archived. The clone refused `migration_pending_input_unsupported`, then
    // `bundle_message_reference_lost` once OpenCode had accepted the notice.
    incident: 'v2.0.4/v2.0.5 archived session with a cancelled-shell notice',
    outcome: { findings: ['bundle_shell_notice_undelivered'], copyFindings: ['bundle_inbox_notice_undelivered'], strictRefusal: null },
    async write(context) {
      const session = context.liveSession('ses_aged_archived_shell', { archived: true }), notice = 'msg_aged_archived_notice';
      const lease = await context.cancelledShell(session, { notificationID: notice, delivered: true });
      // OpenCode's own row: the accepted notice, queued in the archived session's inbox.
      context.native.inbox.push({ id: notice, sessionID: session, type: 'synthetic', delivery: 'steer', text: '<shell id="sh_aged" state="cancelled" command="npm run dev">' });
      context.expected.findings.push({ code: 'bundle_shell_notice_undelivered', key: leaseKey(lease.token) });
      context.expected.copyFindings.push({ code: 'bundle_inbox_notice_undelivered', key: notice });
      context.expected.droppedInbox.push(notice);
    },
  },
  {
    name: 'undelivered-cancelled-shell-notice',
    // 2026-10-29: a cancelled shell never delivers the notice it reserved an
    // ID for; that message is reported, not required.
    incident: 'v2.0.4 cancelled shell notice never delivered',
    outcome: { findings: ['bundle_shell_notice_undelivered'], copyFindings: [], strictRefusal: null },
    async write(context) {
      const session = context.liveSession('ses_aged_undelivered_shell');
      const lease = await context.cancelledShell(session, { notificationID: 'msg_aged_undelivered_notice', delivered: false });
      context.expected.findings.push({ code: 'bundle_shell_notice_undelivered', key: leaseKey(lease.token) });
    },
  },
  {
    name: 'deleted-session-inbox-notice',
    // 2026-10-29 and 2026-11-02: a delivered shell notice and a queued inbox
    // row in a session that was then deleted; the removal's staged disposition
    // is the only record of them.
    incident: 'v2.0.4/v2.0.11 inbox notices on a deleted session',
    outcome: { findings: [], copyFindings: [], strictRefusal: null },
    async write(context) {
      const session = context.deletedSession('ses_aged_deleted_shell');
      await context.cancelledShell(session, { notificationID: 'msg_aged_deleted_notice', delivered: true });
      await context.removeSession(session, { inboxIDs: ['msg_aged_deleted_notice', 'msg_aged_deleted_queued'] });
    },
  },
  {
    name: 'orphaned-child-tasks',
    // 2026-10-17 lockout (deleted 2.1.0 line): completed orchestration tasks
    // whose Cursor child sessions were deleted refused
    // `bundle_message_reference_lost`; a finished task is history now.
    incident: '2026-10-17 bundle_message_reference_lost (finished tasks of deleted child or parent sessions)',
    outcome: { findings: ['bundle_session_reference_lost', 'bundle_message_reference_lost', 'bundle_session_reference_lost'], copyFindings: [], strictRefusal: null },
    async write(context) {
      const root = context.liveSession('ses_aged_task_root');
      // Task 1: its child session is gone, so are the child's messages it names.
      const first = context.task({ index: 1, root, child: 'ses_aged_task_child_gone' });
      context.expected.findings.push({ code: 'bundle_session_reference_lost', key: `tasks/${first}` }, { code: 'bundle_message_reference_lost', key: `tasks/${first}` });
      // Task 2: its parent (root) session is gone; the child and its messages live.
      const second = context.task({ index: 2, root: 'ses_aged_task_root_gone', child: context.liveSession('ses_aged_task_child_live') });
      context.expected.findings.push({ code: 'bundle_session_reference_lost', key: `tasks/${second}` });
    },
  },
  {
    name: 'copied-file-flood',
    // 2026-10-29 lockout (v2.0.6): 139,493 copied files listed inline pushed
    // `sources/preparation.json` past the 32 MiB document cap
    // (`bundle_document_too_large`). Loose mutation-ledger objects and Codex
    // `.tmp` caches were most of them. Rows now live in hash-bound sidecars,
    // so sealed documents do not grow with the file count.
    incident: 'v2.0.6 bundle_document_too_large (loose ledger objects and Codex caches)',
    outcome: { findings: [], copyFindings: [], strictRefusal: null },
    async write(context) {
      const session = context.liveSession('ses_aged_flood');
      await context.edit(session, 'f-flood.txt');
      // Hand-written bulk: unreachable loose objects in the ledger's git store and a regenerable cache.
      await context.looseObjects(context.files);
      const cache = path.join(context.webDataDirectory, 'quota', 'codex-usage', 'aged-account', '.tmp', 'plugins');
      await fs.mkdir(cache, { recursive: true });
      for (let index = 0; index < Math.ceil(context.files / 4); index += 1) await fs.writeFile(path.join(cache, `cache-${index}.json`), String(index));
      context.expected.looseObjects = context.files;
    },
  },
].map(Object.freeze));

export const AGED_PROFILE_SCENARIO_NAMES = Object.freeze(AGED_PROFILE_SCENARIOS.map(scenario => scenario.name));
export const agedProfileScenario = name => {
  const scenario = AGED_PROFILE_SCENARIOS.find(row => row.name === name);
  if (!scenario) throw new TypeError(`Unknown aged-profile scenario: ${name}`);
  return scenario;
};

/**
 * Writes the selected scenarios into `webDataDirectory` (a bundle's web data)
 * for the project at `directory` (an existing Git work tree). Returns the
 * OpenCode rows the profile needs (`native`), the exact expected records
 * (`expected`) and the combined outcome codes. `files` sizes the bulk scenario.
 */
export async function writeAgedProfile({ webDataDirectory, directory, scenarios = AGED_PROFILE_SCENARIO_NAMES, files = 100 }) {
  const selected = scenarios.map(agedProfileScenario);
  directory = await fs.realpath(directory);
  const storage = path.join(webDataDirectory, 'harness', 'session-mutations');
  const runtime = createSessionMutationRuntime({ directory: storage });
  const native = { sessions: [], messages: [], inbox: [] }, tasks = [], later = [];
  const expected = { findings: [], copyFindings: [], settledLeases: [], cancelledReverts: [], droppedInbox: [], cursorIntents: [], derivedLinks: [], looseObjects: 0 };
  const turns = new Map(), sequence = new Map();
  const nextID = (session, kind) => { const value = (sequence.get(session) ?? 0) + 1; sequence.set(session, value); return `msg_${session.slice(4)}_${kind}_${value}`; };
  const ledgerRoot = () => path.join(storage, changeKey(directory));
  const context = {
    runtime, directory, webDataDirectory, native, files, expected, ledgerRoot,
    /** Hand-written follow-ups, run once the writers have drained, with the ledger store. */
    afterWriters: step => { later.push(step); },
    liveSession: (id, { archived = false } = {}) => { native.sessions.push({ id, directory, archived }); return id; },
    deletedSession: id => id,
    message: (session, type) => {
      const id = nextID(session, type);
      if (native.sessions.some(row => row.id === session)) native.messages.push({ id, sessionID: session, type });
      if (type === 'user') turns.set(session, id);
      return id;
    },
    lastUser: session => turns.get(session),
    /** One finished edit call through the real lease lifecycle. */
    async edit(session, file, during) {
      const user = context.message(session, 'user'), assistant = context.message(session, 'assistant');
      await runtime.registerPrompt({ directory, sessionID: session, userMessageID: user });
      const lease = await runtime.begin({ directory, sessionID: session, userMessageID: user, messageID: assistant, callID: `call_${user.slice(4)}` });
      await runtime.claimLease({ directory, token: lease.token, kind: 'process' });
      await fs.appendFile(path.join(lease.viewDirectory, file), 'aged edit\n');
      await during?.(lease);
      await writeReceipt(lease);
      await runtime.finish({ directory, token: lease.token });
      await runtime.cleanupLease({ directory, token: lease.token });
      return lease;
    },
    /** A background shell bound to its native job and notice, then cancelled. */
    async cancelledShell(session, { notificationID, delivered }) {
      const user = context.message(session, 'user'), assistant = context.message(session, 'assistant'), callID = `call_${user.slice(4)}`, jobID = `job_${user.slice(4)}`;
      const lease = await runtime.begin({ directory, sessionID: session, userMessageID: user, messageID: assistant, callID });
      await runtime.claimLease({ directory, token: lease.token, kind: 'process' });
      await runtime.bindNativeShellJob({ directory, token: lease.token, jobID, sessionID: session, messageID: assistant, callID, command: 'npm run dev' });
      await runtime.bindNativeShellNotification({ directory, sessionID: session, jobID, notificationID });
      await writeReceipt(lease, { cancelled: true });
      await runtime.cancelLease({ directory, token: lease.token });
      await runtime.cleanupLease({ directory, token: lease.token });
      // `deliveredID`: OpenCode accepted the notice into the session's inbox.
      if (delivered) await runtime.acknowledgeNativeShellCompletion({ directory, sessionID: session, jobID, notificationID });
      return lease;
    },
    /** The product's native deletion: intent, commit, staged disposition, ACK, completion. */
    async removeSession(session, { parentID = null, inboxIDs = [], pendingIDs = [] } = {}) {
      const ownerID = 'aged-removal-owner', intent = await runtime.beginNativeRemoval({ directory, rootSessionID: session, ownerID });
      const members = [{ id: session, parentID, directory }];
      await runtime.prepareNativeRemovalMembers({ directory, intentID: intent.id, ownerID, members });
      await runtime.commitNativeRemoval({ directory, intentID: intent.id, ownerID, members });
      const input = { directory, intentID: intent.id, ownerID, sessionID: session, inboxIDs, pendingIDs };
      await runtime.stageNativeRemovalMember(input); await runtime.acknowledgeNativeRemoval(input);
      await runtime.completeNativeRemoval({ directory, intentID: intent.id, ownerID });
    },
    /** A finished orchestration task through the product contract; returns its ID. */
    task({ index, root, child }) {
      const queued = createManagedTaskRecord({ idempotencyKey: `aged-${index}`, rootSessionId: root, parentTaskId: null, directory, mode: 'orchestrator',
        providerId: 'openai', modelId: 'fixture', agent: 'fixer', variant: null, label: `Aged ${index}`, prompt: 'Fix.', taskId: `dvr_task_aged_${index}`,
        sequence: index, createdAt: 1, timeoutAt: null, attempt: 1, priorTaskId: null, executionKind: 'start' });
      const starting = { ...queued, status: 'starting', leaseToken: `dvr_lease_aged_${index}`, startedAt: 2 };
      assertManagedTaskTransition(queued, starting);
      const running = { ...starting, status: 'running', childSessionId: child };
      assertManagedTaskTransition(starting, running);
      const childMessage = `msg_${child.slice(4)}_assistant_task`;
      const completed = { ...running, status: 'completed', finishedAt: 3, leaseToken: null,
        canonicalRefs: [{ type: 'message', id: childMessage }, { type: 'tool', id: `call_aged_task_${index}`, messageId: childMessage }] };
      assertManagedTaskTransition(running, completed);
      if (native.sessions.some(row => row.id === child)) native.messages.push({ id: childMessage, sessionID: child, type: 'assistant' });
      tasks.push(completed);
      return completed.taskId;
    },
    /** Unreachable loose objects in the ledger's own object store. */
    async looseObjects(count) {
      const root = ledgerRoot(), staging = path.join(root, 'aged-objects');
      await fs.mkdir(staging, { recursive: true });
      const names = [];
      for (let index = 0; index < count; index += 1) { const file = path.join(staging, `${index}`); await fs.writeFile(file, `aged loose object ${index}\n`); names.push(file); }
      await git(root, ['--git-dir', path.join(root, 'git'), 'hash-object', '-w', ...names]);
      await fs.rm(staging, { recursive: true });
    },
  };
  try {
    for (const scenario of selected) await scenario.write(context);
  } finally { await runtime.drain(); }
  if (later.length) {
    const ledger = await openChangeStore(ledgerRoot(), path.join(ledgerRoot(), 'git'));
    for (const step of later) await step(ledger);
    await ledger.commit();
  }
  if (tasks.length) {
    const ledger = path.join(webDataDirectory, 'orchestration', 'ledger.json');
    await fs.mkdir(path.dirname(ledger), { recursive: true });
    const resultEnvelopes = tasks.map((task, index) => createManagedTaskResultEnvelope(task, { sequence: index + 1, createdAt: 4, resumable: false }));
    await fs.writeFile(ledger, encodeLedgerSnapshot({ version: 1, tasks, resultEnvelopes }));
  }
  const unique = rows => [...new Set(rows)].sort();
  return {
    scenarios: selected.map(scenario => scenario.name), directory, native, expected,
    outcome: { strictRefusals: unique(selected.map(scenario => scenario.outcome.strictRefusal).filter(Boolean)) },
  };
}

/** Exact `code key` rows, one per record, sorted: the form the gates compare. */
export const agedFindingRows = rows => rows.map(row => `${row.code} ${row.key}`).sort();

/** What OpenCode reports for the profile: live and archived sessions and their messages. */
export const agedNativeIdentity = profile => ({
  sessionIDs: profile.native.sessions.map(row => row.id),
  messageIDs: profile.native.messages.map(row => row.id),
  archivedSessionIDs: profile.native.sessions.filter(row => row.archived).map(row => row.id),
});

/**
 * Hand-written OpenCode rows (no OpenCode writer runs in these tests): sessions
 * with their required parents, messages, archive flags and inbox notices. The
 * bundle verifier and clone read them back as the product's own reader.
 */
export function seedAgedNativeDatabase(db, profile, { time = 1 } = {}) {
  const insertRow = (table, fixed) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all()
      .filter(column => Object.hasOwn(fixed, column.name) || column.notnull && column.dflt_value === null);
    const values = columns.map(column => Object.hasOwn(fixed, column.name) ? fixed[column.name] : /INT|REAL|NUM/i.test(column.type) ? time : 'fixture');
    db.prepare(`INSERT OR IGNORE INTO ${table}(${columns.map(column => column.name).join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...values);
  };
  const parents = {};
  for (const key of db.prepare('PRAGMA foreign_key_list(session_v2)').all()) { parents[key.from] = 'fixture'; insertRow(key.table, { [key.to]: 'fixture' }); }
  for (const session of profile.native.sessions) {
    insertRow('session_v2', { ...parents, id: session.id, directory: session.directory });
    if (session.archived) db.prepare('UPDATE session_v2 SET time_archived=? WHERE id=?').run(time, session.id);
  }
  const message = db.prepare('INSERT INTO session_message(id,session_id,type,seq,data,time_created,time_updated) VALUES(?,?,?,?,?,?,?)');
  profile.native.messages.forEach((row, index) => message.run(row.id, row.sessionID, row.type, 10_000 + index, JSON.stringify(row.type === 'user'
    ? { text: 'Aged turn', time: { created: time } }
    : { agent: 'orchestrator', model: { providerID: 'devryan-smoke', id: 'smoke-write' }, content: [], finish: 'stop', time: { created: time, completed: time } }), time, time));
  const inbox = db.prepare('INSERT INTO session_inbox(id,session_id,type,payload,delivery,enqueued_seq,time_created) VALUES(?,?,?,?,?,?,?)');
  profile.native.inbox.forEach((row, index) => inbox.run(row.id, row.sessionID, row.type, JSON.stringify({ text: row.text }), row.delivery, 20_000 + index, time));
}

/**
 * The native Cursor recovery as the runtime owner composes it at launch
 * (native-runtime-owner.js: ownerID is the selected bundle, sourceOwnerID the
 * bundle it was cloned from), over the profile's project. Returns the intents
 * it settled, what it isolated and the intent files left.
 */
export async function recoverAgedCursorIntents({ webDataDirectory, directory, ownerID, sourceOwnerID }) {
  const intents = path.join(webDataDirectory, 'harness', 'native-cursor');
  const runtime = createSessionMutationRuntime({ directory: path.join(webDataDirectory, 'harness', 'session-mutations') });
  const recovery = createNativeCursorRecovery({ directory: intents, ownerID, sourceOwnerID, runtime });
  const settled = [], isolated = [];
  try {
    await recovery.recover({ directory: await fs.realpath(directory), onIsolated: finding => isolated.push(finding),
      settle: async scope => { settled.push({ sessionID: scope.sessionID, assistantMessageID: scope.assistantMessageID }); } });
  } finally { await runtime.drain(); }
  const remaining = (await fs.readdir(intents).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  return { settled, isolated, remaining };
}
