#!/usr/bin/env node
// The closure check over the product recording (package C0d): records the
// product families of the port map from the product's own tests (the family
// command, set up for the product), then replays every case against the
// TypeScript modules in file order and alone (replay.mjs). Planted
// differences in copies of the product modules (PRODUCT_PLANTS) must each be
// caught by a named check. Writes only into scratch.
//
//   node scripts/client-conformance/replay-product.mjs [--from=<directory of containers>] [--modes=file,isolated] [--families=a,b] [--json=<file>] [--plants[=a,b]] [--keep-artifacts]
//
// Without --from it records first (two recordings, compared byte for byte, as
// the family command does); a recording that is not clean (its exit code is
// not 0) makes the closure inconclusive. With --plants it also runs the
// planted differences (all, or those named) against the same recording, in
// file order only (a planted difference is deterministic: a case alone adds
// nothing), and prints for each whether its named check caught it. Exit
// codes: as replay.mjs; with --plants, 1 also when a planted difference is
// not caught.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordFamilies } from './family-run.mjs';
import { loadCensus } from './census.mjs';
import { PRODUCT_CENSUS, PRODUCT_PORT_MAP, PRODUCT_SETUP, UI_DIR } from './product.mjs';
import { loadPortMap } from './port-map.mjs';
import { createScratch, EXIT, parseOptions, REPOSITORY_ROOT } from './record.mjs';
import { formatCase, judgeReplay, MODES, planContainers, readContainerDir, readRecording, replayPlanned, reportLines, summarize } from './replay.mjs';
import { typescriptEngine } from './engine.mjs';

const SYNC = 'packages/ui/src/sync';
const LIB = 'packages/ui/src/lib';
/**
 * Planted differences in copies of product modules (design file 29 §4.5,
 * mutants 1 to 6, then this package's own): `file` (repository-relative) is
 * loaded with `anchor` (which must occur exactly once) replaced; `families`
 * are replayed; `expect` is the named check (and kind, and family) that must
 * report it in some case. The file itself is never written.
 */
export const PRODUCT_PLANTS = Object.freeze([
  // Design mutants 1 to 6.
  { name: 'design-1-part-delta-limit-in-utf8-bytes', origin: 'design 1', file: `${SYNC}/part-delta.ts`, families: ['part-delta', 'reducer'],
    anchor: '  if (value.length > MAX_JAMMED_DUPLICATE_SCAN_LENGTH) {', replacement: '  if (Buffer.byteLength(value) > MAX_JAMMED_DUPLICATE_SCAN_LENGTH) {',
    expect: { check: 'result', kind: 'value', family: 'part-delta' } },
  // No part-delta case holds non-ASCII whitespace where part-delta trims (its four trims were each planted): the
  // ASCII-only trim is planted where a recorded case has it, session-working's finish (C0d report, coverage gaps).
  { name: 'design-2-ascii-only-trim', origin: 'design 2 (landed: session-working; part-delta has no such case)', file: `${SYNC}/session-working.ts`, families: ['session-working'],
    anchor: '  const normalized = finish.trim().toLowerCase()\n', replacement: '  const normalized = finish.replace(/^[ \\t\\n\\r]+|[ \\t\\n\\r]+$/g, "").toLowerCase()\n',
    expect: { check: 'result', kind: 'value', family: 'session-working' } },
  { name: 'design-3-reducer-key-moved-to-end', origin: 'design 3', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: '        ...existing,\n        [props.field]: nextValue,', replacement: '        ...Object.fromEntries(Object.entries(existing).filter(([key]) => key !== props.field)),\n        [props.field]: nextValue,',
    expect: { check: 'after', kind: 'key-order', family: 'reducer' } },
  { name: 'design-4-reducer-undefined-as-null', origin: 'design 4', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: 'partDeltaNoParts(props.messageID, props.partID)\n        return {\n          changed: false,\n          materialization: { type: "incomplete-session-snapshot", sessionID, ',
    replacement: 'partDeltaNoParts(props.messageID, props.partID)\n        return {\n          changed: false,\n          materialization: { type: "incomplete-session-snapshot", sessionID: sessionID ?? null, ',
    expect: { check: 'result', kind: 'undefined-null', family: 'reducer' } },
  { name: 'design-5-reducer-clones-one-field-too-many', origin: 'design 5', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: '      draft.todo[props.sessionID] = props.todos\n', replacement: '      draft.todo[props.sessionID] = props.todos\n      draft.session_status = { ...draft.session_status }\n',
    expect: { check: 'change-set', family: 'reducer' } },
  { name: 'design-6-provisional-time-plus-one', origin: 'design 6 (landed: the reducer\'s provisional message, not optimistic)', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: 'const created = getPartStartTime(part) ?? Date.now()', replacement: 'const created = getPartStartTime(part) ?? Date.now() + 1',
    expect: { check: 'after', kind: 'time-oracle', family: 'reducer' } },
  // This package's own.
  { name: 'reducer-mutates-parts-in-place', origin: 'C0d', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: '      // Create new Part object + new array so React detects the change\n      const next = [...parts]', replacement: '      // Create new Part object + new array so React detects the change\n      const next = parts',
    expect: { check: 'change-set', family: 'reducer' } },
  { name: 'reducer-kept-branch-replaced-by-equal-copy', origin: 'C0d', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: '      if (draft.vcs?.branch === props.branch) return false\n', replacement: '      if (draft.vcs?.branch === props.branch) { draft.vcs = { ...draft.vcs }; return false }\n',
    expect: { check: 'change-set', family: 'reducer' } },
  { name: 'reducer-todo-callback-dropped', origin: 'C0d', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: '      callbacks?.onSetSessionTodo?.(props.sessionID, props.todos)\n      return true', replacement: '      return true',
    expect: { check: 'effects', kind: 'missing', family: 'reducer' } },
  { name: 'reducer-todo-callback-gets-a-copy', origin: 'C0d', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: '      callbacks?.onSetSessionTodo?.(props.sessionID, props.todos)\n      return true', replacement: '      callbacks?.onSetSessionTodo?.(props.sessionID, [...props.todos])\n      return true',
    expect: { check: 'effects', kind: 'identity', family: 'reducer' } },
  { name: 'reducer-abort-guard-answer-ignored', origin: 'C0d', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: '      const status = filteredStatus\n', replacement: '      const status = props.status\n',
    expect: { check: 'after', kind: 'members', family: 'reducer' } },
  { name: 'reducer-extra-clock-read', origin: 'C0d', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: 'const created = getPartStartTime(part) ?? Date.now()', replacement: 'const created = getPartStartTime(part) ?? (Date.now(), Date.now())',
    expect: { check: 'halt', kind: 'unanswered', family: 'reducer' } },
  { name: 'reducer-guard-cleared-twice', origin: 'C0d', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: '      const props = event.properties as { sessionID: string }\n      clearAbortGuard(props.sessionID)\n      const status = { type: "idle" } as const\n      if (areSessionStatusesEqual(draft.session_status[props.sessionID], status)) {\n        return false\n      }\n      draft.session_status[props.sessionID] = status\n      return true\n    }\n\n    case "session.error"',
    replacement: '      const props = event.properties as { sessionID: string }\n      clearAbortGuard(props.sessionID)\n      clearAbortGuard(props.sessionID)\n      const status = { type: "idle" } as const\n      if (areSessionStatusesEqual(draft.session_status[props.sessionID], status)) {\n        return false\n      }\n      draft.session_status[props.sessionID] = status\n      return true\n    }\n\n    case "session.error"',
    expect: { check: 'halt', kind: 'unanswered', family: 'reducer' } },
  { name: 'part-delta-full-frame-floor-off-by-one', origin: 'C0d', file: `${SYNC}/part-delta.ts`, families: ['part-delta'],
    anchor: 'const MIN_FULL_FRAME_DUPLICATE_LENGTH = 32', replacement: 'const MIN_FULL_FRAME_DUPLICATE_LENGTH = 33',
    expect: { check: 'result', kind: 'value', family: 'part-delta' } },
  { name: 'part-delta-jammed-scan-limit-off-by-one', origin: 'C0d', file: `${SYNC}/part-delta.ts`, families: ['part-delta'],
    anchor: 'const MAX_JAMMED_DUPLICATE_SCAN_LENGTH = 2_048', replacement: 'const MAX_JAMMED_DUPLICATE_SCAN_LENGTH = 2_047',
    expect: { check: 'result', kind: 'value', family: 'part-delta' } },
  { name: 'message-fetch-limit-off-by-one', origin: 'C0d', file: `${SYNC}/message-fetch.ts`, families: ['message-fetch'],
    anchor: '  return Math.floor(limit)\n', replacement: '  return Math.floor(limit) + 1\n',
    expect: { check: 'result', kind: 'value', family: 'message-fetch' } },
  { name: 'message-order-tie-reversed', origin: 'C0d', file: `${SYNC}/message-order.ts`, families: ['message-order'],
    anchor: 'return timeDelta === 0 ? compareIDs(left.id, right.id) : timeDelta', replacement: 'return timeDelta === 0 ? compareIDs(right.id, left.id) : timeDelta',
    expect: { check: 'result', kind: 'value', family: 'message-order' } },
  { name: 'session-diff-stats-parse-int', origin: 'C0d', file: `${LIB}/sessionDiffStats.ts`, families: ['session-diff-stats'],
    anchor: '    const parsed = Number(value)\n', replacement: '    const parsed = Number.parseInt(value, 10)\n',
    expect: { check: 'result', kind: 'value', family: 'session-diff-stats' } },
  { name: 'tool-status-keeps-hyphens', origin: 'C0d', file: `${LIB}/toolStatus.ts`, families: ['tool-status'],
    anchor: ".replace(/[\\s_-]+/g, '')", replacement: ".replace(/[\\s_]+/g, '')",
    expect: { check: 'result', kind: 'value', family: 'tool-status' } },
  { name: 'session-working-finish-case-kept', origin: 'C0d', file: `${SYNC}/session-working.ts`, families: ['session-working'],
    anchor: '  const normalized = finish.trim().toLowerCase()\n', replacement: '  const normalized = finish.trim()\n',
    expect: { check: 'result', kind: 'value', family: 'session-working' } },
  { name: 'tool-output-equal-part-copied', origin: 'C0d', file: `${SYNC}/tool-output.ts`, families: ['tool-output'],
    anchor: '  return JSON.stringify(restored) === JSON.stringify(existing) ? existing : restored\n', replacement: '  return restored\n',
    expect: { check: 'result', kind: 'identity', family: 'tool-output' } },
  { name: 'revert-failed-transaction-still-hides', origin: 'C0d', file: `${SYNC}/revert-transactions.ts`, families: ['revert-transactions'],
    anchor: '  if (transaction?.status !== "failed" && transaction?.hiddenMessageIDs?.has(messageID)) {', replacement: '  if (transaction?.hiddenMessageIDs?.has(messageID)) {',
    expect: { check: 'result', kind: 'value', family: 'revert-transactions' } },
  { name: 'optimistic-copies-where-it-mutated', origin: 'C0d', file: `${SYNC}/optimistic.ts`, families: ['optimistic'],
    anchor: '      messages.splice(0, messages.length, ...inserted)\n', replacement: '      draft.message[input.sessionID] = inserted\n',
    expect: { check: 'change-set', family: 'optimistic' } },
  { name: 'materialization-order-reversed', origin: 'C0d', file: `${SYNC}/materialization.ts`, families: ['materialization'],
    anchor: '.sort((left, right) => compareMessagesChronologically(left.info, right.info))', replacement: '.sort((left, right) => compareMessagesChronologically(right.info, left.info))',
    expect: { check: 'result', kind: 'value', family: 'materialization' } },
  // C0d fix (the review's S3): a port call moved three macrotasks later is a difference of the cases that make it, and
  // contained to them: no case of the unit is lost (`contained`: none inconclusive).
  { name: 'reducer-todo-callback-three-jobs-later', origin: 'C0d fix', file: `${SYNC}/event-reducer.ts`, families: ['reducer'],
    anchor: '      callbacks?.onSetSessionTodo?.(props.sessionID, props.todos)\n      return true', replacement: '      setImmediate(() => setImmediate(() => setImmediate(() => callbacks?.onSetSessionTodo?.(props.sessionID, props.todos))))\n      return true',
    expect: { check: 'effects', kind: 'missing', family: 'reducer' }, contained: true },
  // Package C0e: the store and time-driven families (requirement 7 of its brief), each caught by its named check.
  { name: 'c0e-store-mutates-in-place-where-it-replaced', origin: 'C0e', file: `${SYNC}/selection-store.ts`, families: ['selection-store'],
    anchor: '      const map = new Map(s.draftPlanModeSelections)\n      map.set(draftId, enabled)\n', replacement: '      const map = s.draftPlanModeSelections\n      map.set(draftId, enabled)\n',
    expect: { check: 'state-changes', kind: 'value', family: 'selection-store' } },
  { name: 'c0e-store-replaces-where-it-kept', origin: 'C0e', file: `${SYNC}/selection-store.ts`, families: ['selection-store'],
    anchor: '    set((s) => (s.defaultPlanModeSelection === enabled ? s : { defaultPlanModeSelection: enabled })),', replacement: '    set((s) => (s.defaultPlanModeSelection === enabled ? { ...s } : { defaultPlanModeSelection: enabled })),',
    expect: { check: 'effects', kind: 'extra', family: 'selection-store' } },
  { name: 'c0e-module-state-replaced-where-it-mutated', origin: 'C0e', file: `${SYNC}/abort-retry-guard.ts`, families: ['abort-guard'],
    anchor: '  record.reabortCount += 1\n  record.lastReabortAt = now\n', replacement: '  record.reabortCount += 1\n  record.lastReabortAt = now\n  records.set(sessionId, { ...record })\n',
    expect: { check: 'state-changes', kind: 'value', family: 'abort-guard' } },
  { name: 'c0e-notification-skipped', origin: 'C0e', file: `${SYNC}/session-worktree-store.ts`, families: ['session-worktree-store'],
    anchor: '      const next = new Map(s.attachments);\n      next.set(sessionId, attachment);\n      return { attachments: next };', replacement: '      s.attachments.set(sessionId, attachment);\n      return s;',
    expect: { check: 'effects', kind: 'missing', family: 'session-worktree-store' } },
  { name: 'c0e-notification-doubled', origin: 'C0e', file: `${SYNC}/global-sync-store.ts`, families: ['global-sync-store'],
    anchor: '    set: (patch) => set(patch),', replacement: '    set: (patch) => { set(patch); set({ ...patch }) },',
    expect: { check: 'effects', kind: 'extra', family: 'global-sync-store' } },
  { name: 'c0e-notification-before-the-state-is-set', origin: 'C0e', file: `${SYNC}/selection-store.ts`, families: ['selection-store'],
    anchor: '      const map = new Map(s.sessionModelSelections)\n      map.set(sessionId, { providerId, modelId })\n      return { sessionModelSelections: map, lastUsedProvider: { providerID: providerId, modelID: modelId } }',
    replacement: '      set({ lastUsedProvider: { providerID: providerId, modelID: modelId } })\n      const map = new Map(s.sessionModelSelections)\n      map.set(sessionId, { providerId, modelId })\n      return { sessionModelSelections: map }',
    expect: { check: 'effects', kind: 'extra', family: 'selection-store' } },
  { name: 'c0e-persisted-store-writes-one-action-late', origin: 'C0e', file: `${SYNC}/session-creation.ts`, families: ['session-creation'],
    anchor: "  useSessionCreationStore.setState((state) => ({ attempts: { ...state.attempts, [attempt.draftId]: { ...current, ...patch } } }))\n  persistAttempts()\n",
    replacement: "  persistAttempts()\n  useSessionCreationStore.setState((state) => ({ attempts: { ...state.attempts, [attempt.draftId]: { ...current, ...patch } } }))\n",
    expect: { check: 'effects', kind: 'order', family: 'session-creation' } },
  { name: 'c0e-timer-delay-off-by-one', origin: 'C0e', file: `${SYNC}/abort-retry-guard.ts`, families: ['abort-guard'],
    anchor: '      // Best effort — the next retry/busy status will trigger another attempt\n      // while the bounded budget lasts.\n    })\n  }, 0)', replacement: '      // Best effort — the next retry/busy status will trigger another attempt\n      // while the bounded budget lasts.\n    })\n  }, 1)',
    expect: { check: 'effects', kind: 'value', family: 'abort-guard' } },
  { name: 'c0e-accounting-delay-off-by-one', origin: 'C0e', file: `${SYNC}/history-cache-budget.ts`, families: ['child-store'],
    anchor: 'const ACCOUNTING_DELAY_MS = 500\n', replacement: 'const ACCOUNTING_DELAY_MS = 501\n',
    expect: { check: 'effects', kind: 'value', family: 'child-store' } },
  { name: 'c0e-timer-not-cleared', origin: 'C0e', file: `${SYNC}/history-cache-budget.ts`, families: ['child-store'],
    anchor: '  flush() {\n    if (this.timer) clearTimeout(this.timer)\n', replacement: '  flush() {\n',
    expect: { check: 'effects', kind: 'missing', family: 'child-store' } },
  { name: 'c0e-timer-cleared-twice', origin: 'C0e', file: `${SYNC}/history-cache-budget.ts`, families: ['child-store'],
    anchor: '  flush() {\n    if (this.timer) clearTimeout(this.timer)\n', replacement: '  flush() {\n    if (this.timer) { clearTimeout(this.timer); clearTimeout(this.timer) }\n',
    expect: { check: 'effects', kind: 'extra', family: 'child-store' } },
  { name: 'c0e-timer-cleared-after-it-fired', origin: 'C0e', file: `${SYNC}/abort-retry-guard.ts`, families: ['abort-guard'],
    anchor: '  const executor = abortExecutor\n  // Defer so callers (event reducers) stay synchronous and side-effect free.\n  setTimeout(() => {\n',
    replacement: '  const executor = abortExecutor\n  // Defer so callers (event reducers) stay synchronous and side-effect free.\n  const handle = setTimeout(() => {\n    clearTimeout(handle)\n',
    expect: { check: 'effects', kind: 'extra', family: 'abort-guard' } },
  { name: 'c0e-deadline-timer-not-cleared', origin: 'C0e', file: `${SYNC}/directory-bootstrap-request.ts`, families: ['directory-bootstrap-request'],
    anchor: '  } finally {\n    clearTimeout(timer)\n', replacement: '  } finally {\n',
    expect: { check: 'effects', kind: 'missing', family: 'directory-bootstrap-request' } },
  { name: 'c0e-sleep-schedule-drifts', origin: 'C0e', file: `${SYNC}/claude-catalog-recovery.ts`, families: ['claude-catalog-recovery'],
    anchor: '          await sleep(delay)\n', replacement: '          await sleep(delay + delays.indexOf(delay))\n',
    expect: { check: 'effects', kind: 'value', family: 'claude-catalog-recovery' } },
  { name: 'c0e-clock-read-at-another-point', origin: 'C0e', file: `${SYNC}/session-creation.ts`, families: ['session-creation'],
    anchor: "  const attempt: CreationAttempt = { id: crypto.randomUUID(), draftId: snapshot.draftId, startedAt: Date.now(), phase: 'preparing',",
    replacement: "  const startedAt = Date.now()\n  const attempt: CreationAttempt = { id: crypto.randomUUID(), draftId: snapshot.draftId, startedAt, phase: 'preparing',",
    expect: { check: 'halt', kind: 'effect-order', family: 'session-creation' } },
  { name: 'c0e-timer-callback-reads-the-clock', origin: 'C0e', file: `${SYNC}/abort-retry-guard.ts`, families: ['abort-guard'],
    anchor: '    // The guard may have been cleared (idle arrived / new send) while waiting.\n    if (records.get(sessionId) !== record) return\n',
    replacement: '    // The guard may have been cleared (idle arrived / new send) while waiting.\n    if (records.get(sessionId) !== record || Date.now() < 0) return\n',
    expect: { check: 'halt', kind: 'unanswered', family: 'abort-guard' } },
  { name: 'c0e-ttl-off-by-one', origin: 'C0e', file: `${SYNC}/abort-retry-guard.ts`, families: ['abort-guard'],
    anchor: 'export const ABORT_GUARD_TTL_MS = 60_000\n', replacement: 'export const ABORT_GUARD_TTL_MS = 60_001\n',
    expect: { check: 'state', kind: 'value', family: 'abort-guard' } },
  { name: 'c0e-reabort-cap-off-by-one', origin: 'C0e', file: `${SYNC}/abort-retry-guard.ts`, families: ['abort-guard'],
    anchor: 'export const ABORT_GUARD_MAX_REABORTS = 3\n', replacement: 'export const ABORT_GUARD_MAX_REABORTS = 2\n',
    expect: { check: 'effects', kind: 'missing', family: 'abort-guard' } },
  { name: 'c0e-module-map-not-written', origin: 'C0e', file: `${SYNC}/selection-store.ts`, families: ['selection-store'],
    anchor: '    restoredSessionUserChoices.set(sessionId, choiceKey)\n', replacement: '',
    expect: { check: 'state', kind: 'value', family: 'selection-store' } },
  { name: 'c0e-epoch-off-by-one', origin: 'C0e', file: `${SYNC}/global-sync-store.ts`, families: ['global-sync-store'],
    anchor: 'bootstrapEpoch: state.bootstrapEpoch + 1 })),', replacement: 'bootstrapEpoch: state.bootstrapEpoch + 2 })),',
    expect: { check: 'effects', kind: 'value', family: 'global-sync-store' } },
  { name: 'c0e-history-estimate-off-by-one', origin: 'C0e', file: `${SYNC}/history-cache-budget.ts`, families: ['child-store'],
    anchor: '    if (typeof value === "string") return 16 + value.length * 2\n', replacement: '    if (typeof value === "string") return 17 + value.length * 2\n',
    expect: { check: 'result', kind: 'value', family: 'child-store' } },
  { name: 'c0e-eviction-order-reversed', origin: 'C0e', file: `${SYNC}/history-cache-budget.ts`, families: ['child-store'],
    anchor: '        .sort((a, b) => a.accessed - b.accessed)\n', replacement: '        .sort((a, b) => b.accessed - a.accessed)\n',
    expect: { check: 'effects', family: 'child-store' } },
  { name: 'c0e-recovery-skips-its-recheck', origin: 'C0e', file: `${SYNC}/claude-catalog-recovery.ts`, families: ['claude-catalog-recovery'],
    anchor: '          // A newer load may have listed the models while this one waited.\n          if (deps.hasClaudeModels(directory)) return\n', replacement: '',
    expect: { check: 'halt', kind: 'effect-order', family: 'claude-catalog-recovery' } },
  { name: 'c0e-superseded-cleanup-runs', origin: 'C0e', file: `${SYNC}/directory-disposal.ts`, families: ['directory-disposal'],
    anchor: '        if (generation === activeGeneration) {\n', replacement: '        if (generation >= activeGeneration) {\n',
    expect: { check: 'halt', kind: 'unanswered', family: 'directory-disposal' } },
  { name: 'c0e-creation-deadline-off-by-one', origin: 'C0e', file: `${SYNC}/session-creation.ts`, families: ['session-creation'],
    anchor: 'export const SESSION_CREATION_DEADLINE_MS = 120_000\n', replacement: 'export const SESSION_CREATION_DEADLINE_MS = 119_999\n',
    expect: { check: 'effects', kind: 'value', family: 'session-creation' } },
  { name: 'c0e-notify-after-the-action-returned', origin: 'C0e', file: `${SYNC}/session-worktree-store.ts`, families: ['session-worktree-store'],
    anchor: '  clearAttachment: (sessionId) =>\n    set((s) => {\n      const next = new Map(s.attachments);\n      next.delete(sessionId);\n      return { attachments: next };\n    }),\n',
    replacement: '  clearAttachment: (sessionId) =>\n    void Promise.resolve().then(() => set((s) => {\n      const next = new Map(s.attachments);\n      next.delete(sessionId);\n      return { attachments: next };\n    })),\n',
    expect: { check: 'effects', kind: 'return-position', family: 'session-worktree-store' } },
  // Package C0f: the transport families (event-pipeline, bootstrap). Design mutant 8 on the pipeline. Open (C0f fix
  // round, named so no plant counts under a mutation it does not make): 7 as written (FLUSH_FRAME_MS 33 -> 34, by the
  // timer delay) escapes, since no product test flushes within a frame of the last flush (a tests-only package's);
  // 9 (a loader page limit) waits for the loader's family; 10 as written (effect order on session actions) waits for
  // that family. In their place, on the pipeline, the flush clamp and two cleanup calls swapped, counted as C0f's.
  { name: 'c0f-flush-delay-clamp-off-by-one', origin: 'C0f', file: `${SYNC}/event-pipeline.ts`, families: ['event-pipeline'],
    anchor: 'Math.max(0, flushFrameMs - elapsed)', replacement: 'Math.max(1, flushFrameMs - elapsed)', expect: { check: 'effects', kind: 'value', family: 'event-pipeline' } },
  { name: 'c0f-design-8-deltas-coalesced-across-fields', origin: 'design 8', file: `${SYNC}/event-pipeline.ts`, families: ['event-pipeline'],
    anchor: '      return `message.part.delta:${props.messageID}:${props.partID}:${props.field}`', replacement: '      return `message.part.delta:${props.messageID}:${props.partID}`',
    expect: { check: 'effects', kind: 'value', family: 'event-pipeline' } },
  // Two port calls swapped, as design mutant 10's, but on the pipeline's cleanup, and caught as a missing effect (the
  // swapped removal no longer matches at its position), not by the effect-order check design 10 names.
  { name: 'c0f-cleanup-calls-swapped', origin: 'C0f', file: `${SYNC}/event-pipeline.ts`, families: ['event-pipeline'],
    anchor: '      document.removeEventListener("visibilitychange", onVisibility)\n      window.removeEventListener("pageshow", onPageShow)', replacement: '      window.removeEventListener("pageshow", onPageShow)\n      document.removeEventListener("visibilitychange", onVisibility)',
    expect: { check: 'effects', kind: 'missing', family: 'event-pipeline' } },
  { name: 'c0f-heartbeat-default-off-by-one', origin: 'C0f', file: `${SYNC}/event-pipeline.ts`, families: ['event-pipeline'],
    anchor: 'const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000', replacement: 'const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_001', expect: { check: 'effects', kind: 'value', family: 'event-pipeline' } },
  // The WebSocket URL's cursor and the WebSocket gap frame escape: no product test reconnects a socket after an event
  // id or sends a gap frame (C0f.md lists the tests). These two are the SSE paths that are tested.
  { name: 'c0f-reconnect-header-loses-the-cursor', origin: 'C0f', file: `${SYNC}/event-pipeline.ts`, families: ['event-pipeline'],
    anchor: '{ "Last-Event-ID": lastEventId }', replacement: '{ "Last-Event-Id": lastEventId }', expect: { check: 'effects', kind: 'members', family: 'event-pipeline' } },
  { name: 'c0f-replay-gap-header-dropped', origin: 'C0f', file: `${SYNC}/event-pipeline.ts`, families: ['event-pipeline'],
    anchor: '"X-DevRyan-Replay-Gap": "1", ', replacement: '', expect: { check: 'effects', kind: 'members', family: 'event-pipeline' } },
  { name: 'c0f-reconnect-event-not-dispatched', origin: 'C0f', file: `${SYNC}/event-pipeline.ts`, families: ['event-pipeline'],
    anchor: '    globalThis.window?.dispatchEvent(new globalThis.Event("devryan:primary-recovery-reconnect"))', replacement: '', expect: { check: 'effects', kind: 'missing', family: 'event-pipeline' } },
  { name: 'c0f-reconnect-event-renamed', origin: 'C0f', file: `${SYNC}/event-pipeline.ts`, families: ['event-pipeline'],
    anchor: 'new globalThis.Event("devryan:primary-recovery-reconnect")', replacement: 'new globalThis.Event("devryan:primary-recovery-reconnected")', expect: { check: 'effects', kind: 'value', family: 'event-pipeline' } },
  { name: 'c0f-sse-gap-not-reported', origin: 'C0f', file: `${SYNC}/event-pipeline.ts`, families: ['event-pipeline'],
    anchor: '        if (event.event === "devryan.replay-gap") {\n          onReplayGap?.()', replacement: '        if (event.event === "devryan.replay-gap") {', expect: { check: 'effects', kind: 'missing', family: 'event-pipeline' } },
  { name: 'c0f-bootstrap-retry-backoff-off-by-one', origin: 'C0f', file: `${SYNC}/retry.ts`, families: ['bootstrap'],
    anchor: '    delay = 500,', replacement: '    delay = 501,', expect: { check: 'effects', kind: 'value', family: 'bootstrap' } },
  { name: 'c0f-bootstrap-partial-status-not-set', origin: 'C0f', file: `${SYNC}/bootstrap.ts`, families: ['bootstrap'],
    anchor: '  if (loading) set({ status: "partial" })', replacement: '', expect: { check: 'effects', kind: 'missing', family: 'bootstrap' } },
]);

/** The planted copy's source (`anchor` exactly once), or an error naming the plant. */
export function plantedSource(plant, root = REPOSITORY_ROOT) {
  const file = path.join(root, plant.file);
  const source = readFileSync(file, 'utf8');
  let planted = source;
  for (const [anchor, replacement] of [[plant.anchor, plant.replacement], ...(plant.extra ? [[plant.extra.anchor, plant.extra.replacement]] : [])]) {
    const occurrences = planted.split(anchor).length - 1;
    if (occurrences !== 1) throw new Error(`planted difference ${plant.name}: its anchor occurs ${occurrences} times in ${plant.file}`);
    planted = planted.replace(anchor, () => replacement);
  }
  return { module: file, source: planted };
}

/** Whether `result` (a replay of the plant's families) holds the difference the plant must cause. */
export function plantCaught(plant, result) {
  const { check, kind, family } = plant.expect;
  return result.cases.some((kase) => (!family || kase.family === family) && Object.values(kase.modes).some((entry) => entry.outcome === 'different'
    && entry.differences.some((difference) => difference.check === check && (kind === undefined || difference.kind === kind))));
}

/**
 * Runs each plant (all, or `only`) against the containers of `directory`:
 * a copy written into `workDir` for the record, its families replayed in file
 * order with the copy loaded in place of the module; `parallel` plants at a
 * time, each on an engine of its own. Resolves, in list order,
 * `[{ plant, caught, differences, inconclusive, error? }]`.
 */
export async function runProductPlants({ directory, workDir, only = null, plants = PRODUCT_PLANTS, concurrency, parallel = 3 }) {
  const portMap = loadPortMap(PRODUCT_PORT_MAP, { root: REPOSITORY_ROOT });
  const list = plants.filter((plant) => !only || only.includes(plant.name));
  const containers = readContainerDir(directory);
  const results = new Array(list.length);
  const run = async (plant) => {
    try {
      const planted = plantedSource(plant);
      const copy = path.join(workDir, 'plants', plant.name, plant.file);
      mkdirSync(path.dirname(copy), { recursive: true });
      writeFileSync(copy, planted.source);
      const planned = planContainers(containers, portMap, { families: plant.families });
      const result = await replayPlanned(planned, { engine: typescriptEngine({ cwd: UI_DIR }), modes: ['file'], plants: [planted], concurrency });
      const differences = result.cases.filter((kase) => kase.outcome === 'different').map(formatCase);
      const inconclusive = [...planned.problems, ...result.problems].map((problem) => problem.detail).concat(result.cases.filter((kase) => kase.outcome === 'inconclusive').map(formatCase));
      // A contained plant must leave every case judged: one it loses would hide the cases after it.
      const caught = plantCaught(plant, result) && (!plant.contained || inconclusive.length === 0);
      return { plant, caught, differences, inconclusive };
    } catch (error) {
      return { plant, caught: false, differences: [], inconclusive: [], error: String(error?.stack ?? error) };
    }
  };
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, list.length)) }, async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      results[index] = await run(list[index]);
    }
  }));
  return results;
}

/** The families a product closure must judge: those asked for, or every family of the map the census does not waive as untested. */
export function requiredFamilies(portMap, families = null) {
  const waived = new Set(loadCensus(PRODUCT_CENSUS).families.map((item) => item.family));
  return (families ?? portMap.families.map((family) => family.name)).filter((name) => !waived.has(name));
}

/** Records the product families into `out` (scratch); resolves the family command's `{ code, report }`. */
export async function recordProduct({ workDir, out, families = null }) {
  return recordFamilies({ setup: PRODUCT_SETUP, runs: 2, families, workDir, out, parallel: PRODUCT_SETUP.parallel });
}

export async function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  const usage = 'usage: replay-product.mjs [--from=<directory of containers>] [--modes=file,isolated] [--families=a,b] [--json=<file>] [--plants[=a,b]] [--concurrency=N] [--keep-artifacts]';
  const parsed = parseOptions(argv, { flags: ['keep-artifacts', 'plants'], values: ['from', 'modes', 'families', 'json', 'plants', 'concurrency'] });
  if (parsed.error || parsed.positionals.length) { error(`${parsed.error ?? 'no positional arguments'}\n${usage}`); return EXIT.usage; }
  const { options } = parsed;
  const modes = options.modes ? options.modes.split(',').filter(Boolean) : [...MODES];
  if (modes.length === 0 || modes.some((mode) => !MODES.includes(mode))) { error(`--modes takes ${MODES.join(', ')}\n${usage}`); return EXIT.usage; }
  const families = options.families ? options.families.split(',').filter(Boolean) : null;
  const plantNames = options.plants === undefined ? null : options.plants === '' || options.plants === true ? [] : String(options.plants).split(',').filter(Boolean);
  for (const name of plantNames ?? []) if (!PRODUCT_PLANTS.some((plant) => plant.name === name)) { error(`--plants: no planted difference ${name}\n${usage}`); return EXIT.usage; }
  const concurrency = options.concurrency !== undefined ? Number(options.concurrency) : undefined;
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) { error(`--concurrency must be a positive integer\n${usage}`); return EXIT.usage; }
  const scratch = createScratch('client-conformance-replay-product', { keepArtifacts: options['keep-artifacts'] === true });
  let status = 'failed';
  try {
    let directory = options.from ? path.resolve(options.from) : null;
    const recordingProblems = [];
    if (!directory) {
      directory = path.join(scratch.dir, 'containers');
      const recorded = await recordProduct({ workDir: path.join(scratch.dir, 'record'), out: directory, families });
      log(`recording: exit ${recorded.code}; ${recorded.report.cases} cases, ${recorded.report.steps} steps (${recorded.report.outcomes.recorded} recorded, ${recorded.report.outcomes.unrecordable} unrecordable, ${recorded.report.outcomes.inconclusive} inconclusive), ${recorded.report.unstableCases.length} unstable, ${recorded.report.files} files`);
      if (recorded.code !== EXIT.pass) recordingProblems.push({ check: 'recording', detail: `the product recording exited ${recorded.code}: ${[...recorded.report.incomplete.map((entry) => entry.detail), ...recorded.report.failures.map((entry) => entry.detail)].slice(0, 5).join('; ')}` });
    }
    const portMap = loadPortMap(PRODUCT_PORT_MAP, { root: REPOSITORY_ROOT });
    // The directory must be what its recording's manifest lists (manifest.mjs), whether recorded here or given.
    const recording = readRecording(directory, portMap, { families });
    const planned = planContainers(recording.list, portMap, { families });
    const result = await replayPlanned(planned, { engine: typescriptEngine({ cwd: UI_DIR }), modes, concurrency });
    result.problems.unshift(...recordingProblems, ...recording.problems, ...planned.problems);
    const verdict = judgeReplay(result, { modes, requireFamilies: [...new Set([...requiredFamilies(portMap, families), ...recording.requireFamilies])].sort() });
    for (const line of verdict.inconclusive) error(`inconclusive: ${line}`);
    for (const line of verdict.failures) error(`different: ${line}`);
    for (const line of reportLines(result, verdict, modes)) log(line);
    let code = verdict.code;
    let plants = null;
    if (plantNames !== null) {
      plants = await runProductPlants({ directory, workDir: scratch.dir, only: plantNames.length ? plantNames : null, concurrency });
      for (const entry of plants) {
        log(`planted ${entry.plant.name}: ${entry.caught ? `caught by ${entry.plant.expect.check}${entry.plant.expect.kind ? `/${entry.plant.expect.kind}` : ''}` : 'NOT caught'}; ${entry.differences.length} cases differ${entry.error ? `; error: ${entry.error}` : ''}${entry.inconclusive.length ? `; ${entry.inconclusive.length} inconclusive` : ''}`);
        if (!entry.caught) for (const line of entry.differences.slice(0, 3)) log(`  ${line.slice(0, 600)}`);
      }
      if (code === EXIT.pass && plants.some((entry) => !entry.caught)) code = EXIT.fail;
      log(`${plants.filter((entry) => entry.caught).length}/${plants.length} planted differences caught by their named check`);
    }
    if (options.json) writeFileSync(options.json, `${JSON.stringify({ code, families: summarize(result.cases, modes), verdict, cases: result.cases, plants: plants?.map((entry) => ({ name: entry.plant.name, caught: entry.caught, differences: entry.differences.slice(0, 5), inconclusive: entry.inconclusive.slice(0, 5), error: entry.error ?? null })) ?? null }, null, 2)}\n`);
    status = code === EXIT.pass ? 'passed' : 'failed';
    return code;
  } finally {
    scratch.finish(status);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
