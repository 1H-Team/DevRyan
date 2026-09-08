// Exact, reversible edits to the source-hash-checked Meridian 1.62.6 bundle.
// The HTTP installer owns the single atomic entrypoint replacement.
export const MERIDIAN_HANDOFF_HELPER = 'devryan-meridian-passthrough-handoff.js';
export const MERIDIAN_HANDOFF_IMPORT = `import { settlePassthroughQuery } from "./${MERIDIAN_HANDOFF_HELPER}";\n`;
// Keep the previous revision independently reconstructible so provisioning can
// upgrade complete installed patches without accepting partially patched code.
export const MERIDIAN_HANDOFF_V1_EDITS = [
  ...[
    '              claudeLog("passthrough.noncanonical_session_evicted", { mode: "non_stream" });',
    '                    claudeLog("passthrough.noncanonical_session_evicted", { mode: "stream" });',
  ].map(before => [before, before + '\n' + before.match(/^ */)[0] + 'requestMeta.passthroughHandoff?.diagnostic("passthrough.checkpoint_rejected", { reason: requestAbort.controller.signal.aborted ? "client_abort" : "noncanonical_session_evicted", toolCount: 0 });']),
  [
    '          claudeLog("passthrough.checkpoint_replay", {',
    '          diagnosticLog2.session(requestMeta.requestId + " passthrough.checkpoint_replay reason=incomplete_or_mismatched_results", requestMeta.requestId);\n          claudeLog("passthrough.checkpoint_replay", {',
  ],
  [
    '      yield* guardUpstreamIdle(sdkQuery, UPSTREAM_IDLE_MS,',
    '      yield* guardUpstreamIdle(settlePassthroughQuery(sdkQuery, { signal, queryOptions: params.options, ...requestMeta.passthroughHandoff }), UPSTREAM_IDLE_MS,',
  ],
  [
    '        let earlyStopFired = false;\n        const envelopeViolations = [];',
    `        let earlyStopFired = false;
        requestMeta.passthroughHandoff = earlyStopEnabled ? {
          checkpoint: () => earlyStopFired ? {
            assistantUuid: earlyStop.toolCallAssistantUuid,
            toolCallIds: [...earlyStop.expected]
          } : null,
          verified: (checkpoint) => { requestMeta.passthroughHandoff.verifiedCheckpoint = checkpoint; },
          diagnostic: (event, detail) => diagnosticLog2.session(
            requestMeta.requestId + " " + event + " reason=" + detail.reason + " tools=" + detail.toolCount,
            requestMeta.requestId
          )
        } : undefined;
        const envelopeViolations = [];`,
  ],
  [
    '            if (checkpointTurn && (!earlyStopFired || !sawCanonicalResult)) {',
    '            if (requestAbort.controller.signal.aborted || checkpointTurn && (!earlyStopFired || (!sawCanonicalResult && requestMeta.passthroughHandoff?.verifiedCheckpoint?.sessionId !== currentSessionId))) {',
  ],
  [
    '                  if (exitedBeforeCanonicalTerminal || checkpointTurn && (!earlyStopFired || !sawCanonicalResult)) {',
    '                  if (requestAbort.controller.signal.aborted || exitedBeforeCanonicalTerminal || checkpointTurn && (!earlyStopFired || (!sawCanonicalResult && requestMeta.passthroughHandoff?.verifiedCheckpoint?.sessionId !== currentSessionId))) {',
  ],
  [
    '              commitSessionTurn();\n            }\n          }\n          const responseSessionId',
    '              commitSessionTurn();\n              if (checkpointTurn) requestMeta.passthroughHandoff?.diagnostic("passthrough.checkpoint_retained", { reason: "verified_handoff", toolCount: nextPassthroughToolCallIds?.length ?? 0 });\n            }\n          }\n          const responseSessionId',
  ],
  [
    '                    commitSessionTurn();\n                  }\n                }\n                const classifyNow',
    '                    commitSessionTurn();\n                    if (checkpointTurn) requestMeta.passthroughHandoff?.diagnostic("passthrough.checkpoint_retained", { reason: "verified_handoff", toolCount: nextPassthroughToolCallIds?.length ?? 0 });\n                  }\n                }\n                const classifyNow',
  ],
];

export const MERIDIAN_PREFIX_EDITS = [
  [
    '              return {\n                decision: "block",\n                reason: "This tool call has been forwarded to the client for execution. ',
    // Blocking a tool only feeds a denial back to the model. Stop processing
    // at the completed hook boundary as well, so the SDK cannot race another
    // inference before the asynchronous interrupt is handled. The existing
    // complete-envelope/checkpoint verification still owns session retention.
    '              return {\n                ...earlyStopEnabled ? { continue: false, stopReason: "Awaiting client tool results." } : {},\n                decision: "block",\n                reason: "This tool call has been forwarded to the client for execution. ',
  ],
  [
    '        ...passthrough && process.env.MERIDIAN_SUPPRESS_SCRATCHPAD !== "0" ? { CLAUDE_CODE_SESSION_KIND: "bg" } : {},',
    // Native background mode also runs a Haiku status classifier, outside the
    // client request/usage stream. Native tools are disabled in passthrough;
    // no native scratchpad is advertised without this mode on the pinned CLI.
    '        // DevRyan: keep normal SDK mode; background mode submits status-classifier inference.',
  ],
  [
    '      ...isUndo || forkSession ? { forkSession: true } : {},',
    // resumeSessionAt truncates the in-memory conversation, but does not remove
    // the denied-tool branch from its native file. On the next resume Claude
    // can reattach those older denials over real client results. A native fork
    // persists only the selected branch, including its actual previous results.
    '      ...isUndo || forkSession || (passthrough && resumeSessionId && resumeSessionAtUuid) ? { forkSession: true } : {},',
  ],
  [
    '        ...ctx.envOverrides\n      },',
    // Passthrough disables native tools, so this removes the mutable startup
    // Git snapshot, without removing native Git tool instructions. The client
    // tool surface and explicit project/client instructions remain unchanged.
    '        ...ctx.envOverrides,\n        ...passthrough ? { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1" } : {}\n      },',
  ],
  [
    '    const append2 = [clientContext, cwdNote, GIT_STATUS_PROVENANCE_NOTE].filter(Boolean).join("");',
    '    const append2 = [clientContext, cwdNote, passthrough ? "\\n\\n<meridian-note>Read Git state with the client tools when needed. Use conversation history and your previous tool results to distinguish your changes from pre-existing work.</meridian-note>" : GIT_STATUS_PROVENANCE_NOTE].filter(Boolean).join("");',
  ],
];

export const MERIDIAN_HANDOFF_EDITS = [...MERIDIAN_HANDOFF_V1_EDITS, ...MERIDIAN_PREFIX_EDITS];

export const stripMeridianHandoffPatch = source => {
  let original = source.replace(MERIDIAN_HANDOFF_IMPORT, '');
  for (const [before, after] of MERIDIAN_HANDOFF_EDITS) original = original.replace(after, before);
  return original;
};

export const patchMeridianHandoff = (source, { includePrefixFix = true } = {}) => {
  let patched = source;
  for (const [before, after] of includePrefixFix ? MERIDIAN_HANDOFF_EDITS : MERIDIAN_HANDOFF_V1_EDITS) {
    if (patched.split(before).length !== 2) throw new Error('Meridian handoff source anchors are incompatible');
    patched = patched.replace(before, after);
  }
  return MERIDIAN_HANDOFF_IMPORT + patched;
};
