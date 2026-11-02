#!/usr/bin/env bun
// Runs this checkout's every-launch harness check against a private copy of
// the installed app's selected runtime bundle, before that data meets a new
// release. The live bundle is only read: the database through `VACUUM INTO`
// (as startup does), the harness ledgers through a clone-on-write copy.
//
//   bun scripts/qa/bundle-startup-rehearsal.mjs [--control-root <dir>] [--keep-artifacts]
//
// Exit 0: passed or nothing installed. Exit 1: the check refused; the code and
// the record it named (identifiers only) are printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneFile, cloneTree, createRunRoot, scratchParent } from './run-root.mjs';
import { resolveSqliteDriver } from '../../packages/web/server/lib/opencode/sqlite-driver.js';
import { inspectBundleHarness } from '../../packages/web/server/lib/opencode/runtime-host/bundle-harness-integrity.js';
import { verifyBundleRecoveredInputs } from '../../packages/web/server/lib/opencode/runtime-host/bundle-recovered-inputs.js';
import { verifiedNativeUserCancellations } from '../../packages/web/server/lib/opencode/runtime-host/native-input-cancellation.js';

export const defaultControlRoot = (env = process.env) => env.DEVRYAN_RUNTIME_BUNDLE_ROOT
  || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'devryan', 'runtime-bundles');

const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const nativeUsers = db => db.all("SELECT id,session_id,data FROM session_message WHERE type='user'").flatMap(row => {
  try {
    const admission = JSON.parse(row.data)?.metadata?.devryan?.admission;
    return admission?.v === 1 && /^[a-f0-9]{64}$/.test(admission.fingerprint ?? '')
      ? [{ id: row.id, sessionID: row.session_id, fingerprint: admission.fingerprint }] : [];
  } catch { return []; }
});

/** Returns `{status:'skipped'|'passed'|'refused', ...}`; never writes the live bundle. */
export async function rehearseBundleStartup({ controlRoot = defaultControlRoot(), log = console.log, argv = process.argv } = {}) {
  const selectionFile = path.join(controlRoot, 'selection.json');
  if (!exists(selectionFile)) { log(`[rehearsal] skipped: no installed runtime bundle at ${controlRoot}`); return { status: 'skipped' }; }
  const { selectedBundleID } = readJSON(selectionFile);
  if (typeof selectedBundleID !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(selectedBundleID)) throw new Error('selection.json names no valid bundle');
  const { launch } = readJSON(path.join(controlRoot, 'bundles', selectedBundleID, 'descriptor.json'));
  const run = createRunRoot({ parent: scratchParent('qa'), prefix: 'bundle-rehearsal-', owner: 'bundle-startup-rehearsal', argv });
  let status = 'failed';
  try {
    const web = path.join(run.dir, 'web-data'), database = path.join(run.dir, 'opencode.db');
    fs.mkdirSync(web, { mode: 0o700 });
    for (const entry of ['harness', 'orchestration']) {
      const source = path.join(launch.webDataDirectory, entry);
      // The journal is diagnostics the check never reads.
      if (exists(source)) cloneTree(source, path.join(web, entry), { filter: file => !file.startsWith(path.join(launch.webDataDirectory, 'harness', 'journal')) });
    }
    if (exists(path.join(launch.webDataDirectory, 'settings.json'))) cloneFile(path.join(launch.webDataDirectory, 'settings.json'), path.join(web, 'settings.json'));
    const live = resolveSqliteDriver().open(launch.opencodeDatabasePath, { readonly: true });
    try { live.prepare('VACUUM INTO ?').run(database); } finally { live.close(); }
    const raw = resolveSqliteDriver().open(database, { readonly: true });
    const db = { raw, all: (sql, params = []) => raw.prepare(sql).all(...params), run: () => { throw new Error('read only'); } };
    try {
      const ids = sql => db.all(sql).map(row => row.id);
      const verifiedContinuations = await verifyBundleRecoveredInputs(db, web, { cancelledOnly: true });
      // Lease view paths name the live bundle; the copy stands in for it.
      const result = await inspectBundleHarness(web, { sourceWebDataDirectory: launch.webDataDirectory,
        sessionIDs: ids('SELECT id FROM session_v2'), messageIDs: ids('SELECT id FROM session_message'),
        verifiedContinuations, nativeUsers: nativeUsers(db), verifiedCancellations: verifiedNativeUserCancellations(db),
        archivedSessionIDs: ids('SELECT id FROM session_v2 WHERE time_archived IS NOT NULL ORDER BY id'),
      });
      for (const row of result.findings) log(`[rehearsal] isolated ${row.code} ${row.ledger}/${row.key}`);
      log(`[rehearsal] passed: bundle ${selectedBundleID} starts with this checkout (${result.findings.length} isolated records)`);
      status = 'passed';
      return { status: 'passed', bundleID: selectedBundleID, findings: result.findings };
    } catch (error) {
      if (typeof error?.code !== 'string') throw error;
      const record = error.detail?.key ? ` record ${error.detail.ledger}/${error.detail.key}` : '';
      log(`[rehearsal] REFUSED ${error.code}${record} (bundle ${selectedBundleID})`);
      return { status: 'refused', bundleID: selectedBundleID, code: error.code, detail: error.detail };
    } finally { raw.close(); }
  } finally { run.finish(status); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--control-root');
  const result = await rehearseBundleStartup(index > 0 ? { controlRoot: path.resolve(process.argv[index + 1]) } : {});
  process.exitCode = result.status === 'refused' ? 1 : 0;
}
