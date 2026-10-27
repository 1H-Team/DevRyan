import { MERIDIAN_HANDOFF_V1_EDITS, MERIDIAN_PREFIX_EDITS } from './meridian-passthrough-hotfix.js';

// Reviewed 1.68.0 already forks passthrough checkpoints. Keep that upstream
// logic, including its explicit target session IDs and replay provenance.
// Publication now accepts a session ID; retain its generation/pinning guards.
export const MERIDIAN_168_HANDOFF_EDITS = [
  ...MERIDIAN_HANDOFF_V1_EDITS.slice(0, 7),
  ...[
    ['                ', '\n              }\n            }\n          }\n          finalizePriorityPublication();'],
    ['                      ', '\n                    }\n                  }\n                }\n                if (pendingStructuredFrames.length > 0)'],
  ].map(([indent, suffix]) => {
    const before = `\n${indent}commitSessionTurn(currentSessionId);`;
    return [before + suffix, before + `\n${indent}if (checkpointTurn) requestMeta.passthroughHandoff?.diagnostic("passthrough.checkpoint_retained", { reason: "verified_handoff", toolCount: nextPassthroughToolCallIds?.length ?? 0 });` + suffix];
  }),
];

export const MERIDIAN_168_PREFIX_EDITS = [
  [
    '              return {\n                decision: "block",\n                reason: PASSTHROUGH_DENY_REASON',
    '              return {\n                ...earlyStopEnabled ? { continue: false, stopReason: "Awaiting client tool results." } : {},\n                decision: "block",\n                reason: PASSTHROUGH_DENY_REASON',
  ],
  MERIDIAN_PREFIX_EDITS[1],
  MERIDIAN_PREFIX_EDITS[3],
  [
    '    const append2 = [clientContext, cwdNote, GIT_STATUS_PROVENANCE_NOTE, REPLAY_PROVENANCE_NOTE].filter(Boolean).join("");',
    '    const append2 = [clientContext, cwdNote, passthrough ? "\\n\\n<meridian-note>Read Git state with the client tools when needed. Use conversation history and your previous tool results to distinguish your changes from pre-existing work.</meridian-note>" : GIT_STATUS_PROVENANCE_NOTE, REPLAY_PROVENANCE_NOTE].filter(Boolean).join("");',
  ],
];

export const MERIDIAN_168_EDITS = [...MERIDIAN_168_HANDOFF_EDITS, ...MERIDIAN_168_PREFIX_EDITS];

// Meridian 1.79.0 retains upstream fork targets/publication guards. Its scratchpad
// environment opt-in must not re-enable the hidden status-classifier inference.
export const MERIDIAN_179_PREFIX_EDITS = [
  MERIDIAN_168_PREFIX_EDITS[0],
  [
    '        ...passthrough && process.env.MERIDIAN_SUPPRESS_SCRATCHPAD !== "0" && process.env.MERIDIAN_SUPPRESS_SCRATCHPAD_ENV === "1" ? { CLAUDE_CODE_SESSION_KIND: "bg" } : {},',
    '        // DevRyan: keep normal SDK mode; background mode submits status-classifier inference.',
  ],
  MERIDIAN_PREFIX_EDITS[3],
  [
    '    const append2 = [clientContext, cwdNote, GIT_STATUS_PROVENANCE_NOTE, REPLAY_PROVENANCE_NOTE, scratchpadNote].filter(Boolean).join("");',
    MERIDIAN_168_PREFIX_EDITS[3][1].replace('REPLAY_PROVENANCE_NOTE]', 'REPLAY_PROVENANCE_NOTE, scratchpadNote]'),
  ],
];
export const MERIDIAN_179_PROCESS_GATE_GUARD = [
  '      if (process.env.MERIDIAN_TEST_DISABLE_SDK_PROCESS_GATE !== "1") {',
  '      if (process.env.DEVRYAN_EXECUTION_BOUNDARY === "1") throw new Error("native_claude_process_gate_required");\n      if (process.env.MERIDIAN_TEST_DISABLE_SDK_PROCESS_GATE !== "1") {',
];
export const MERIDIAN_179_EDITS = [...MERIDIAN_168_HANDOFF_EDITS, ...MERIDIAN_179_PREFIX_EDITS, MERIDIAN_179_PROCESS_GATE_GUARD];
