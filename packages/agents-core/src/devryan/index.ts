// DevRyan agents core: the built-in agent orchestration derived from
// Oh My OpenCode Slim (see NOTICE / UPSTREAM.md). This module is the only
// entry point the DevRyan runtime host compiles; its declared surface is
// ../../index.d.ts. Authority (files, network, processes, configuration,
// provider calls) is always lent by the host through ./owners.
import type { AgentOverrideConfig } from '../config';
import { InterviewConfigSchema } from '../config/schema';
import { createInterviewService as createUpstreamInterviewService } from '../interview/service';
import { createV2Setup } from '../v2/setup';
import {
  createDisplayNameMentionRewriter as createUpstreamMentionRewriter,
  type DisplayNameMentionRewriter,
} from '../utils/agent-variant';

export default {
  id: 'devryan-agents-core',
  setup: createV2Setup(),
};

// Host authority seams.
export {
  bindReviewedAstGrepAsset,
  bindReviewedSlimConfiguration,
  bindReviewedSlimHost,
  bindReviewedSlimImageWorker,
  withReviewedSlimPathOwner,
  withReviewedWebfetchOwner,
} from './owners';

// Agents, fallback and the task board.
export { resolveReviewedSlimAgents } from './agent-configuration';
export { isReviewedSlimFailoverError, selectReviewedSlimFallback } from './fallback';
export { createReviewedSlimTaskBoardRenderer, formatReviewedSlimTaskBoard } from './task-board';
export { createFilterAvailableSkillsHook } from './filter-available-skills';
export { processReviewedSlimImageAttachments } from './images';

// Tools.
export { ast_grep_replace, ast_grep_search } from '../tools/ast-grep';
export { createWebfetchTool } from '../tools/smartfetch';
export { createReviewedWebfetchCache } from '../tools/smartfetch/cache';
export { saveReviewedWebfetchBinary } from '../tools/smartfetch/binary';

// Commands and pure hooks composed by the host.
export { createDeepworkCommandHook } from '../hooks/deepwork';
export { createLoopCommandHook } from '../hooks/loop-command';
export { createReflectCommandHook } from '../hooks/reflect';
export { createToolLoopGuardHook } from '../hooks/tool-loop-guard/hook';
export { createJsonErrorRecoveryHook } from '../hooks/json-error-recovery/hook';
export { createPhaseReminderHook } from '../hooks/phase-reminder';
export { createChatHeadersHook } from '../hooks/chat-headers';
export { createApplyPatchHook } from '../hooks/apply-patch';
export { createAbsolutePathRescueHook } from '../hooks/absolute-path-rescue';
export { createSearchPathGuardHook } from '../hooks/search-path-guard';
export {
  collapseSystemInPlace,
  collapseSystemPartsInPlace,
} from '../utils/system-collapse';

/** The host passes its snapshot agent map; only display names are read. */
export function createDisplayNameMentionRewriter(runtime: {
  readonly customAgentNames: readonly string[];
  readonly agents: () => Readonly<Record<string, unknown>>;
}): DisplayNameMentionRewriter {
  return createUpstreamMentionRewriter({
    customAgentNames: [...runtime.customAgentNames],
    agents: () => {
      const result: Record<string, AgentOverrideConfig> = {};
      for (const [name, value] of Object.entries(runtime.agents())) {
        const displayName =
          value && typeof value === 'object' && typeof (value as { displayName?: unknown }).displayName === 'string'
            ? (value as { displayName: string }).displayName
            : undefined;
        result[name] = displayName === undefined ? {} : { displayName };
      }
      return result;
    },
  });
}

// Interview: the service runs in the host owner; documents in its worker.
/** The host passes the saved `interview` section; it is parsed (with
 * defaults) through the original schema before the service sees it. */
export function createInterviewService(
  context: Parameters<typeof createUpstreamInterviewService>[0],
  configuration: Readonly<Record<string, unknown>> | undefined,
  dependencies: Parameters<typeof createUpstreamInterviewService>[2],
): ReturnType<typeof createUpstreamInterviewService> {
  return createUpstreamInterviewService(
    context,
    InterviewConfigSchema.parse(configuration ?? {}),
    dependencies,
  );
}
export { createInterviewHandler } from '../interview/server';
export {
  appendInterviewAnswers,
  claimInterviewDocument,
  ensureInterviewFile,
  InterviewDocumentOwnershipError,
  InterviewPatchApplyError,
  InterviewPatchRequiredError,
  markInterviewDocumentComplete,
  markInterviewDocumentIncomplete,
  readInterviewDocument,
  resolveExistingInterviewPath,
  resolveReviewedExistingInterviewPath,
  rewriteInterviewDocument,
  rewriteInterviewDocumentWithFinalSpec,
} from '../interview/document';
export {
  createReviewedSlimInterviewBridge,
  reviewedSlimInterviewCommandDeclaration,
} from '../v2/interview-bridge';
