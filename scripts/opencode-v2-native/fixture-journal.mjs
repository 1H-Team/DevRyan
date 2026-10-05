import assert from 'node:assert/strict';
import path from 'node:path';
import { createWebHarnessRuntime } from '../../packages/web/server/lib/harness/runtime.js';

// Short, low-entropy labels survive the diagnostic sanitizer unchanged and
// identify each writer of a shared journal root for tee reconciliation.
export const FIXTURE_JOURNAL_LABEL = /^fixture-[a-z0-9-]{1,22}$/;

/** The production web harness journal on a compiled fixture's descriptor web
 * data. Each source mirrors its application.js mapping; the in-memory fixture
 * arrays stay the callers' own. The tee counts what the journal accepted, per
 * written runtime label, and what it refused before or after drain. */
export async function createFixtureJournal({ webDataDirectory, label }) {
  assert.ok(typeof webDataDirectory === 'string' && path.isAbsolute(webDataDirectory), 'Fixture journal requires an absolute web data directory');
  assert.match(label, FIXTURE_JOURNAL_LABEL, 'Fixture journal label must be short and low-entropy');
  const runtime = createWebHarnessRuntime({ dataDirectory: webDataDirectory, runtime: label });
  await runtime.initialize();
  const accepted = {};
  let rejectedBeforeDrain = 0, rejectedAfterDrain = 0, drainStarted = false, drainPromise = null, drained = false;
  const count = (result, writtenLabel) => {
    if (result) accepted[writtenLabel] = (accepted[writtenLabel] ?? 0) + 1;
    else if (drainStarted) rejectedAfterDrain += 1;
    else rejectedBeforeDrain += 1;
    return result;
  };
  // runtime.record spreads the entry after its own runtime label.
  const record = entry => count(runtime.record(entry), typeof entry?.runtime === 'string' ? entry.runtime : label);
  return {
    label,
    journalDirectory: runtime.paths.journalDir,
    // createNativeRuntimeOwner recordDiagnostic: harnessRuntime.record(entry).
    ownerDiagnostic: entry => record(entry),
    // OpenCode client/admission dependencies' recordDiagnostic.
    clientDiagnostic: payload => record({ type: 'lifecycle', event: 'opencode_client', payload }),
    // createSessionExecutionHost onDiagnostic.
    sessionExecution: event => count(runtime.recordSessionExecution(event), label),
    // createWebPrimaryRecoveryRuntime recordIncident.
    primaryRecoveryIncident: incident => record({ type: 'lifecycle', event: incident?.event,
      sessionID: incident?.sessionID, messageID: incident?.messageID, payload: incident }),
    // Production checkpoint closeAdmission begins the harness drain.
    beginDrain: () => runtime.beginDrain(),
    // Makes every record accepted so far durable without sealing its chunk.
    flush: () => runtime.journal.flush(),
    // Production checkpoint drainStores and shutdown: seals open chunks.
    drain: () => {
      drainStarted = true;
      drainPromise ??= runtime.drain().then(() => { drained = true; });
      return drainPromise;
    },
    summary: () => ({ label, journalDirectory: runtime.paths.journalDir, accepted: { ...accepted },
      rejectedBeforeDrain, rejectedAfterDrain, drained }),
  };
}
