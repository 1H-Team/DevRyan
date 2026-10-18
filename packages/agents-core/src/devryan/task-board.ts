// DevRyan: background tasks are owned by the host. The host's job records are
// rendered with Slim's board text and injected with Slim's presentation
// algorithm; Slim's own task lifecycle never runs.
import { DEFAULT_MAX_RETAINED_SNAPSHOTS } from '../config/constants';
import {
  BACKGROUND_JOB_BOARD_METADATA_KEY,
  type BoardPresentationState,
  injectBackgroundJobBoard,
} from '../hooks/task-session-manager/board-injection';
import {
  type BackgroundJobRecord,
  renderBackgroundJobBoard,
} from '../utils/background-job-board';

type BoardMetadata = ReturnType<typeof renderBackgroundJobBoard>;
type BoardHook = (input: Record<string, unknown>, output: Record<string, unknown>) => Promise<void>;

/** The host maps its owned job rows to Slim's record shape (lastUsedAt included). */
export function formatReviewedSlimTaskBoard(input: {
  readonly jobs: readonly BackgroundJobRecord[];
  readonly reusable: readonly BackgroundJobRecord[];
  readonly readContextMaxFiles?: number;
  readonly now?: number;
}): NonNullable<BoardMetadata> | null {
  return (
    renderBackgroundJobBoard({
      jobs: input.jobs,
      reusable: input.reusable,
      readContextMaxFiles: input.readContextMaxFiles ?? 8,
      // DevRyan's delegation tools are the task_* family.
      delegationTool: 'task',
      now: input.now ?? Date.now(),
    }) ?? null
  );
}

export interface ReviewedSlimBoardOwners {
  readonly shouldManageSession: (sessionID: string) => boolean;
  readonly strategy?: 'latest' | 'checkpoint-compatible';
  readonly maxRetainedSnapshots?: number;
  readonly board: BoardPresentationState['backgroundJobBoard'];
}

export function createReviewedSlimTaskBoardRenderer(owner: ReviewedSlimBoardOwners): {
  readonly transform: BoardHook;
  readonly clearSession: (sessionID: string) => void;
} {
  if (
    !owner ||
    !owner.board ||
    typeof owner.shouldManageSession !== 'function' ||
    (['get', 'formatForPromptWithMetadata', 'markReconciled'] as const).some(
      (name) => typeof owner.board[name] !== 'function',
    )
  )
    throw new Error('reviewed_slim_task_board_owner_required');
  const board = owner.board;
  const state: BoardPresentationState = {
    backgroundJobBoard: {
      get: board.get.bind(board),
      formatForPromptWithMetadata: board.formatForPromptWithMetadata.bind(board),
      markReconciled: (...args) => {
        const result: unknown = board.markReconciled(...args);
        // Reconciliation must stay atomic within the synchronous inject path.
        if (result && typeof (result as { then?: unknown }).then === 'function')
          throw new Error('reviewed_slim_task_board_atomic_owner_required');
        return result as ReturnType<typeof board.markReconciled>;
      },
    },
    shouldManageSession: owner.shouldManageSession,
    strategy: owner.strategy ?? 'latest',
    maxRetainedSnapshots: owner.maxRetainedSnapshots ?? DEFAULT_MAX_RETAINED_SNAPSHOTS,
    // The host injects the board on every eligible request (DevRyan behavior).
    boardInjection: true,
    metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
    terminalJobsInjectedByParent: new Map(),
    pendingInjectedTerminalJobsByParent: new Map(),
    reportedTerminalRunsByParent: new Map(),
    retainedBoardSnapshots: new Map(),
    retainedTailBoards: new Map(),
  };
  const sessionKeys = [
    'terminalJobsInjectedByParent',
    'pendingInjectedTerminalJobsByParent',
    'reportedTerminalRunsByParent',
    'retainedBoardSnapshots',
    'retainedTailBoards',
  ] as const;
  return {
    transform: (input, output) =>
      injectBackgroundJobBoard(state, input as never, output as never),
    clearSession: (sessionID) => {
      for (const key of sessionKeys) state[key]?.delete(sessionID);
    },
  };
}
