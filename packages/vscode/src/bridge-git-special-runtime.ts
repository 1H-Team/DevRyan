import * as fs from 'node:fs';
import * as path from 'node:path';
import * as gitService from './gitService';
import type { BridgeContext, BridgeResponse } from './bridge';
import { getVsCodeHarnessRuntime } from './harness-runtime-access';
import {
  COMMIT_DRAFT_DEADLINE_MS,
  buildPullRequestDiffContext,
  createFreeZenModelCatalog,
  createCommitModelCooldowns,
  generateCommitDraftWithDeadline,
  normalizePullRequestDraft,
  normalizeGeneratedCommitDraft,
  runFreeZenModelRotation,
  sharedFreeZenCooldowns,
  type FreeZenModel,
  type SharedCommitDraftContext,
} from '@openchamber/shared-runtime';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type ExecGitResult = { stdout: string; stderr: string; exitCode: number };

type SpecialGitDeps = {
  readSettings: (ctx?: BridgeContext) => Record<string, unknown>;
  execGit: (args: string[], cwd: string) => Promise<ExecGitResult>;
};

const BRIDGE_COMMIT_DEFAULT_ZEN_MODEL = 'nemotron-3.5-lightning-free';
const BRIDGE_COMMIT_ZEN_TIMEOUT_MS = COMMIT_DRAFT_DEADLINE_MS;
const BRIDGE_COMMIT_MAX_SELECTED_FILES = 200;
const BRIDGE_COMMIT_MAX_PATH_LENGTH = 1024;
const BRIDGE_COMMIT_RECENT_COUNT = 6;
const BRIDGE_COMMIT_MAX_TOTAL_DIFF_CHARS = 16_000;
const BRIDGE_COMMIT_DIFF_CONTEXT_LINES = 1;
const BRIDGE_COMMIT_DIFF_TRUNCATION_MARKER = '\n... [diff truncated]';
const BRIDGE_COMMIT_CONTEXT_DEADLINE_MS = 1_500;
const BRIDGE_PR_MODEL_TIMEOUT_MS = 15_000;
const BRIDGE_PR_MAX_TOKENS = 1_200;
// Bounded like the web route: three warm free models, 45 s in total.
const BRIDGE_PR_MAX_FREE_MODELS = 3;
const BRIDGE_PR_FREE_DEADLINE_MS = 45_000;
const BRIDGE_PR_DIFF_TIMEOUT_MS = 8_000;

const bridgeCommitModelCooldowns = createCommitModelCooldowns();
const bridgeFreeZenModelCatalog = createFreeZenModelCatalog({
  fetchImpl: (...args) => fetch(...args),
});

type BridgeCommitFileContext = {
  path: string;
  index: string;
  workingDir: string;
  diff?: string;
  diffNote?: string;
  insertions?: number;
  deletions?: number;
};

type BridgeCommitContextResult =
  | { status: 'ready'; context: SharedCommitDraftContext }
  | { status: 'blocked'; message: string };

const collectBridgeContextWithinDeadline = async ({
  promise,
  selectedFiles,
  stagedOnly,
}: {
  promise: Promise<BridgeCommitContextResult>;
  selectedFiles: string[];
  stagedOnly: boolean;
}): Promise<BridgeCommitContextResult> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<BridgeCommitContextResult>((resolve) => {
        timer = setTimeout(() => resolve({
          status: 'ready',
          context: {
            branch: '',
            tracking: null,
            scope: stagedOnly ? 'staged-only' : 'staged-and-unstaged',
            stagedOnly,
            selectedFiles: selectedFiles.map((filePath) => ({
              path: filePath,
              index: '?',
              workingDir: '?',
            })),
            recentCommitSubjects: [],
            contextWarning: 'Git context exceeded the speed budget; generated from selected file metadata',
          },
        }), BRIDGE_COMMIT_CONTEXT_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const normalizeBridgeGitPath = (value: string): string => value
  .replace(/\\/g, '/')
  .replace(/^\.\/+/, '')
  .trim();

const validateBridgeCommitFiles = (selectedFiles: unknown): string[] => {
  if (!Array.isArray(selectedFiles) || selectedFiles.length === 0) {
    throw new Error('At least one selected file is required');
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of selectedFiles) {
    if (typeof value !== 'string') throw new Error('Selected file paths must be strings');
    const filePath = normalizeBridgeGitPath(value);
    if (
      !filePath
      || filePath.length > BRIDGE_COMMIT_MAX_PATH_LENGTH
      || filePath === '..'
      || filePath.startsWith('../')
      || filePath.startsWith('/')
      || /^[a-z]:\//i.test(filePath)
      || filePath.split('/').includes('..')
      || filePath.includes('\0')
    ) {
      throw new Error('Selected file path is invalid');
    }
    if (!seen.has(filePath)) {
      seen.add(filePath);
      normalized.push(filePath);
      if (normalized.length > BRIDGE_COMMIT_MAX_SELECTED_FILES) {
        throw new Error(`At most ${BRIDGE_COMMIT_MAX_SELECTED_FILES} files can be used to generate a commit message`);
      }
    }
  }
  return normalized;
};

const parseBridgeNumstat = (text: string): Record<string, { insertions: number; deletions: number }> => {
  const stats: Record<string, { insertions: number; deletions: number }> = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const [insertionsText, deletionsText, ...pathParts] = line.split('\t');
    const filePath = normalizeBridgeGitPath(pathParts.join('\t'));
    if (!filePath) continue;
    const insertions = Number.parseInt(insertionsText, 10);
    const deletions = Number.parseInt(deletionsText, 10);
    const previous = stats[filePath] || { insertions: 0, deletions: 0 };
    stats[filePath] = {
      insertions: previous.insertions + (Number.isFinite(insertions) ? insertions : 0),
      deletions: previous.deletions + (Number.isFinite(deletions) ? deletions : 0),
    };
  }
  return stats;
};

const truncateBridgeCommitDiff = (diff: string, maxChars: number): { text: string; truncated: boolean } => {
  if (diff.length <= maxChars) return { text: diff, truncated: false };
  if (maxChars <= BRIDGE_COMMIT_DIFF_TRUNCATION_MARKER.length) {
    return { text: diff.slice(0, maxChars), truncated: true };
  }
  return {
    text: `${diff.slice(0, maxChars - BRIDGE_COMMIT_DIFF_TRUNCATION_MARKER.length)}${BRIDGE_COMMIT_DIFF_TRUNCATION_MARKER}`,
    truncated: true,
  };
};

const mergeBridgeDiffStats = (
  ...values: Array<Record<string, { insertions: number; deletions: number }>>
): Record<string, { insertions: number; deletions: number }> => {
  const merged: Record<string, { insertions: number; deletions: number }> = {};
  for (const value of values) {
    for (const [filePath, stats] of Object.entries(value)) {
      const previous = merged[filePath] || { insertions: 0, deletions: 0 };
      merged[filePath] = {
        insertions: previous.insertions + stats.insertions,
        deletions: previous.deletions + stats.deletions,
      };
    }
  }
  return merged;
};

const collectBridgeDiffStats = async (
  directory: string,
  stagedOnly: boolean,
  execGit: SpecialGitDeps['execGit'],
): Promise<Record<string, { insertions: number; deletions: number }>> => {
  const staged = execGit(['diff', '--cached', '--numstat'], directory)
    .then((result) => parseBridgeNumstat(result.stdout))
    .catch(() => ({}));
  if (stagedOnly) return staged;
  const unstaged = execGit(['diff', '--numstat'], directory)
    .then((result) => parseBridgeNumstat(result.stdout))
    .catch(() => ({}));
  return mergeBridgeDiffStats(await staged, await unstaged);
};

const collectBridgeCommitContext = async ({
  directory,
  selectedFiles,
  stagedOnly,
  execGit,
}: {
  directory: string;
  selectedFiles: unknown;
  stagedOnly: boolean;
  execGit: SpecialGitDeps['execGit'];
}): Promise<BridgeCommitContextResult> => {
  const selectedPaths = validateBridgeCommitFiles(selectedFiles);
  const allowlist = new Set(selectedPaths);
  const [status, log, diffStats] = await Promise.all([
    gitService.getGitStatus(directory),
    gitService.getGitLog(directory, { maxCount: BRIDGE_COMMIT_RECENT_COUNT }),
    collectBridgeDiffStats(directory, stagedOnly, execGit),
  ]);
  const statusFiles = Array.isArray(status.files) ? status.files : [];
  const hasConflict = statusFiles.some((file) => (
    String(file.index || '').toUpperCase().includes('U')
    || String(file.working_dir || '').toUpperCase().includes('U')
  ));
  if (status.mergeInProgress || status.rebaseInProgress || hasConflict) {
    return {
      status: 'blocked',
      message: 'Merge or rebase conflicts must be resolved before generating a commit message',
    };
  }

  const files: BridgeCommitFileContext[] = statusFiles
    .map((file) => ({
      path: normalizeBridgeGitPath(file.path),
      index: typeof file.index === 'string' ? file.index : '',
      workingDir: typeof file.working_dir === 'string' ? file.working_dir : '',
    }))
    .filter((file) => allowlist.has(file.path));
  const resolved = new Set(files.map((file) => file.path));
  for (const filePath of selectedPaths) {
    if (!resolved.has(filePath)) files.push({ path: filePath, index: '?', workingDir: '?' });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));

  const contexts = files.map((file) => {
    const stats = diffStats[file.path];
    return {
      ...file,
      ...(stats ? { insertions: stats.insertions, deletions: stats.deletions } : {}),
    };
  });
  const diffArgs = ['diff', '--no-color', `-U${BRIDGE_COMMIT_DIFF_CONTEXT_LINES}`];
  const stagedPatch = execGit([...diffArgs, '--cached', '--', ...selectedPaths], directory);
  const patchRequests = stagedOnly
    ? [stagedPatch]
    : [stagedPatch, execGit([...diffArgs, '--', ...selectedPaths], directory)];
  const patchResults = await Promise.allSettled(patchRequests);
  const combinedPatch = patchResults
    .filter((result): result is PromiseFulfilledResult<ExecGitResult> => result.status === 'fulfilled')
    .map((result) => result.value.stdout.trim())
    .filter(Boolean)
    .join('\n');
  const boundedPatch = truncateBridgeCommitDiff(combinedPatch, BRIDGE_COMMIT_MAX_TOTAL_DIFF_CHARS);

  const recentCommitSubjects = (Array.isArray(log.all) ? log.all : [])
    .map((entry) => (typeof entry?.message === 'string' ? entry.message.trim() : ''))
    .filter(Boolean)
    .slice(0, BRIDGE_COMMIT_RECENT_COUNT);
  return {
    status: 'ready',
    context: {
      branch: typeof status.current === 'string' ? status.current : '',
      tracking: typeof status.tracking === 'string' ? status.tracking : null,
      scope: stagedOnly ? 'staged-only' : 'staged-and-unstaged',
      stagedOnly,
      selectedFiles: contexts,
      recentCommitSubjects,
      ...(boundedPatch.text ? { patch: boundedPatch.text } : {}),
      ...(boundedPatch.truncated ? { patchNote: 'combined patch truncated' } : {}),
      ...(patchResults.some((result) => result.status === 'rejected')
        ? { contextWarning: 'some diff context was unavailable' }
        : {}),
    },
  };
};

const recordBridgeCommitTiming = (payload: Record<string, unknown>): void => {
  try {
    getVsCodeHarnessRuntime()?.record({
      type: 'timing',
      mark: 'git_commit_message_generation',
      payload: {
        durationMs: payload.totalMs,
        stages: [
          { phase: 'context', durationMs: payload.contextMs },
          { phase: 'model', durationMs: payload.modelMs },
          { phase: 'provider', durationMs: payload.providerMs },
          { phase: 'parsing', durationMs: payload.parseMs },
        ],
        count: payload.selectedFileCount,
        scope: payload.stagedOnly === true ? 'staged-only' : 'staged-and-unstaged',
        outcome: payload.outcome,
        model: payload.model,
        state: payload.catalogState,
        retry: payload.retried === true,
        source: payload.source,
        providerOutcome: payload.providerOutcome,
      },
    });
  } catch {
    // Diagnostics must never break commit-message generation.
  }
};

const extractZenResponseText = (data: unknown): string => {
  if (!data || typeof data !== 'object') return '';
  const record = data as Record<string, unknown>;
  const output = Array.isArray(record.output) ? record.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? (item as Record<string, unknown>).content as unknown[]
      : [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === 'string' && text.trim()) return text.trim();
    }
  }

  const choices = Array.isArray(record.choices) ? record.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue;
    const message = (choice as Record<string, unknown>).message;
    if (!message || typeof message !== 'object') continue;
    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .map((part) => part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
          ? (part as Record<string, unknown>).text as string
          : '')
        .join('')
        .trim();
      if (text) return text;
    }
  }
  return '';
};

export const generateBridgeTextWithZen = async ({
  prompt,
  zenModel,
  timeoutMs = BRIDGE_COMMIT_ZEN_TIMEOUT_MS,
  maxTokens = 220,
}: {
  prompt: string;
  zenModel?: string;
  timeoutMs?: number;
  maxTokens?: number;
}): Promise<string> => {
  const model = typeof zenModel === 'string' && zenModel.trim() ? zenModel.trim() : BRIDGE_COMMIT_DEFAULT_ZEN_MODEL;
  const endpoint = /^(?:gpt-|claude-|gemini-)/.test(model) ? 'responses' : 'chat/completions';
  const response = await fetch(`https://opencode.ai/zen/v1/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(endpoint === 'responses'
      ? {
          model,
          input: [{ role: 'user', content: prompt }],
          stream: false,
          reasoning: { effort: 'low' },
          max_output_tokens: Math.max(1, Math.trunc(maxTokens)),
        }
      : {
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          max_tokens: Math.max(1, Math.trunc(maxTokens)),
          reasoning_effort: 'none',
        }),
    signal: AbortSignal.timeout(Math.max(1, Math.trunc(timeoutMs))),
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const error = errorPayload?.error;
    const detail = typeof error === 'string'
      ? error
      : error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string'
        ? (error as Record<string, unknown>).message as string
        : response.statusText;
    throw new Error(`Zen API returned ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  const text = extractZenResponseText(await response.json().catch(() => null));
  if (!text) throw new Error('Zen API returned no text');
  return text;
};

export const normalizeBridgeCommitSubject = (value: string): string => {
  const normalized = normalizeGeneratedCommitDraft(value, {
    selectedFiles: [{ path: 'changes', index: 'M', workingDir: ' ' }],
  });
  if (normalized.source === 'local_fallback') {
    throw new Error('Generated commit subject is not a valid conventional commit');
  }
  return normalized.message.subject;
};

type BridgePullRequestAttempt = { tier: 'free_zen'; model: string | null; reason: string | null };

const raceWithin = async <T,>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

// The webview prompt only carries commit subjects and file paths; feed the
// real base...head diff (stat + capped unified diff, binaries skipped).
const collectBridgePullRequestDiff = async (
  deps: SpecialGitDeps,
  directory: string,
  base: string,
  head: string,
): Promise<string> => {
  const run = async (args: string[]): Promise<string> => {
    try {
      const result = await raceWithin<ExecGitResult | null>(
        Promise.resolve(deps.execGit(args, directory)),
        BRIDGE_PR_DIFF_TIMEOUT_MS,
        null,
      );
      return result && result.exitCode === 0 ? String(result.stdout || '') : '';
    } catch {
      return '';
    }
  };
  const [diff, stat] = await Promise.all([
    run(['diff', '--no-color', '-U2', `${base}...${head}`]),
    run(['diff', '--stat=120', '--no-color', `${base}...${head}`]),
  ]);
  return buildPullRequestDiffContext({ diff, stat }).text;
};

const pullRequestFailure = (
  id: string,
  type: string,
  code: 'FREE_ZEN_EXHAUSTED' | 'NO_FREE_MODELS' | 'CATALOG_UNAVAILABLE',
  error: string,
  attempts: BridgePullRequestAttempt[],
): BridgeResponse => {
  const response: BridgeResponse & { code: string } = {
    id,
    type,
    success: false,
    error,
    code,
    // Merged onto the webview-side Error so the UI can name the cause.
    errorData: { code, attempts },
  };
  return response;
};

export async function handleSpecialGitBridgeMessage(
  message: BridgeMessageInput,
  ctx: BridgeContext | undefined,
  deps: SpecialGitDeps,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'api:git/commit-message-draft': {
      const startedAt = Date.now();
      const {
        directory,
        selectedFiles,
        stagedOnly = false,
        guidance,
        zenModel: requestedZenModel,
      } = (payload || {}) as {
        directory?: string;
        selectedFiles?: unknown;
        stagedOnly?: boolean;
        guidance?: string;
        zenModel?: string;
      };
      if (!directory) {
        return { id, type, success: false, error: 'Directory is required' };
      }

      let contextMs = 0;
      let providerMs = 0;
      const parseMs = 0;
      const selectedFileCount = Array.isArray(selectedFiles) ? selectedFiles.length : 0;
      try {
        const contextStartedAt = Date.now();
        const validatedSelectedFiles = validateBridgeCommitFiles(selectedFiles);
        const contextResult = await collectBridgeContextWithinDeadline({
          promise: collectBridgeCommitContext({
            directory,
            selectedFiles: validatedSelectedFiles,
            stagedOnly: stagedOnly === true,
            execGit: deps.execGit,
          }),
          selectedFiles: validatedSelectedFiles,
          stagedOnly: stagedOnly === true,
        });
        contextMs = Date.now() - contextStartedAt;
        if (contextResult.status === 'blocked') {
          recordBridgeCommitTiming({
            contextMs,
            modelMs: 0,
            providerMs: 0,
            parseMs: 0,
            totalMs: Date.now() - startedAt,
            selectedFileCount,
            stagedOnly: stagedOnly === true,
            outcome: 'blocked',
            model: null,
            catalogState: 'not_applicable',
            retried: false,
          });
          return {
            id,
            type,
            success: true,
            data: { status: 'blocked', commits: [], message: contextResult.message },
          };
        }

        const primaryModel = typeof requestedZenModel === 'string' && requestedZenModel.trim()
          ? requestedZenModel.trim()
          : BRIDGE_COMMIT_DEFAULT_ZEN_MODEL;
        const zenModel = bridgeCommitModelCooldowns.select(primaryModel, BRIDGE_COMMIT_DEFAULT_ZEN_MODEL);
        const providerStartedAt = Date.now();
        const generated = await generateCommitDraftWithDeadline({
          context: contextResult.context,
          guidance,
          deadlineAt: startedAt + COMMIT_DRAFT_DEADLINE_MS,
          requestText: zenModel
            ? ({ prompt, timeoutMs }) => generateBridgeTextWithZen({ prompt, zenModel, timeoutMs })
            : undefined,
        });
        providerMs = Date.now() - providerStartedAt;
        if (generated.providerOutcome === 'deadline' || generated.providerOutcome === 'error') {
          bridgeCommitModelCooldowns.markUnhealthy(zenModel);
        }
        recordBridgeCommitTiming({
          contextMs,
          modelMs: 0,
          providerMs,
          parseMs,
          totalMs: Date.now() - startedAt,
          selectedFileCount,
          stagedOnly: stagedOnly === true,
          outcome: 'complete',
          model: zenModel,
          catalogState: 'not_applicable',
          retried: false,
          source: generated.source,
          providerOutcome: generated.providerOutcome,
        });
        return {
          id,
          type,
          success: true,
          data: {
            status: 'complete',
            commits: [generated.message],
            ...((generated.warning || contextResult.context.contextWarning) ? {
              warnings: [generated.warning, contextResult.context.contextWarning].filter((value): value is string => Boolean(value)),
            } : {}),
          },
        };
      } catch (error) {
        recordBridgeCommitTiming({
          contextMs,
          modelMs: 0,
          providerMs,
          parseMs,
          totalMs: Date.now() - startedAt,
          selectedFileCount,
          stagedOnly: stagedOnly === true,
          outcome: 'failed',
          model: typeof requestedZenModel === 'string' && requestedZenModel.trim()
            ? requestedZenModel.trim()
            : BRIDGE_COMMIT_DEFAULT_ZEN_MODEL,
          catalogState: 'not_applicable',
          retried: false,
        });
        return {
          id,
          type,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    case 'api:git/commit-message': {
      const startedAt = Date.now();
      const { directory, context, guidance, zenModel: requestedZenModel } = (payload || {}) as {
        directory?: string;
        context?: SharedCommitDraftContext;
        guidance?: string;
        zenModel?: string;
      };
      const selectedFiles = context && Array.isArray(context.selectedFiles) ? context.selectedFiles : [];
      if (!directory) {
        return { id, type, success: false, error: 'Directory is required' };
      }
      if (!context || selectedFiles.length === 0) {
        return { id, type, success: false, error: 'Worktree context is required' };
      }

      try {
        const primaryModel = typeof requestedZenModel === 'string' && requestedZenModel.trim()
          ? requestedZenModel.trim()
          : BRIDGE_COMMIT_DEFAULT_ZEN_MODEL;
        const zenModel = bridgeCommitModelCooldowns.select(primaryModel, BRIDGE_COMMIT_DEFAULT_ZEN_MODEL);
        const providerStartedAt = Date.now();
        const generated = await generateCommitDraftWithDeadline({
          context,
          guidance,
          deadlineAt: startedAt + COMMIT_DRAFT_DEADLINE_MS,
          requestText: zenModel
            ? ({ prompt, timeoutMs }) => generateBridgeTextWithZen({ prompt, zenModel, timeoutMs })
            : undefined,
        });
        const providerMs = Date.now() - providerStartedAt;
        if (generated.providerOutcome === 'deadline' || generated.providerOutcome === 'error') {
          bridgeCommitModelCooldowns.markUnhealthy(zenModel);
        }
        const parseMs = 0;
        recordBridgeCommitTiming({
          contextMs: 0,
          modelMs: 0,
          providerMs,
          parseMs,
          totalMs: Date.now() - startedAt,
          selectedFileCount: selectedFiles.length,
          stagedOnly: context.stagedOnly === true,
          outcome: 'complete',
          model: zenModel,
          catalogState: 'not_applicable',
          retried: false,
          source: generated.source,
          providerOutcome: generated.providerOutcome,
        });
        return {
          id,
          type,
          success: true,
          data: {
            ...generated.message,
            ...(generated.warning ? { warnings: [generated.warning] } : {}),
          },
        };
      } catch (error) {
        recordBridgeCommitTiming({
          contextMs: 0,
          modelMs: 0,
          providerMs: 0,
          parseMs: 0,
          totalMs: Date.now() - startedAt,
          selectedFileCount: selectedFiles.length,
          stagedOnly: context.stagedOnly === true,
          outcome: 'failed',
          model: typeof requestedZenModel === 'string' && requestedZenModel.trim()
            ? requestedZenModel.trim()
            : BRIDGE_COMMIT_DEFAULT_ZEN_MODEL,
          catalogState: 'not_applicable',
          retried: false,
        });
        return {
          id,
          type,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    case 'api:git/pr-description': {
      const { directory, base, head, prompt } = (payload || {}) as {
        directory?: string;
        base?: string;
        head?: string;
        prompt?: string;
      };
      if (!directory) {
        return { id, type, success: false, error: 'Directory is required' };
      }
      if (!base || !head) {
        return { id, type, success: false, error: 'base and head are required' };
      }

      const generationPrompt = typeof prompt === 'string' ? prompt.trim() : '';
      if (!generationPrompt || generationPrompt.length > 100_000) {
        return { id, type, success: false, error: 'Generate PR prompt is required' };
      }

      try {
        const diffContext = await collectBridgePullRequestDiff(deps, directory, base, head);
        const fullPrompt = diffContext ? `${generationPrompt}\n\n${diffContext}` : generationPrompt;

        let models: FreeZenModel[] = [];
        let catalogState: 'fresh' | 'stale' | 'unavailable' = 'fresh';
        try {
          models = await bridgeFreeZenModelCatalog.fetchModels();
        } catch {
          models = bridgeFreeZenModelCatalog.getCachedModels({ allowStale: true });
          catalogState = models.length > 0 ? 'stale' : 'unavailable';
        }
        if (models.length === 0) {
          return catalogState === 'unavailable'
            ? pullRequestFailure(id, type, 'CATALOG_UNAVAILABLE', 'Free Zen model catalog is unavailable', [])
            : pullRequestFailure(id, type, 'NO_FREE_MODELS', 'No free Zen models are currently available', []);
        }

        const result = await runFreeZenModelRotation({
          models,
          timeoutMs: BRIDGE_PR_MODEL_TIMEOUT_MS,
          maxModels: BRIDGE_PR_MAX_FREE_MODELS,
          deadlineMs: BRIDGE_PR_FREE_DEADLINE_MS,
          cooldowns: sharedFreeZenCooldowns,
          request: ({ model, timeoutMs }) => generateBridgeTextWithZen({
            prompt: fullPrompt,
            zenModel: model,
            timeoutMs,
            maxTokens: BRIDGE_PR_MAX_TOKENS,
          }),
          accept: (value) => normalizePullRequestDraft(value),
          onAttempt: (attempt) => {
            try {
              getVsCodeHarnessRuntime()?.record({
                type: 'timing',
                mark: 'git_pr_description_model_attempt',
                payload: {
                  durationMs: attempt.durationMs,
                  outcome: attempt.outcome,
                  model: attempt.model,
                  tier: 'free_zen',
                  state: catalogState,
                  retry: attempt.attempt > 1,
                  providerOutcome: attempt.reason || attempt.outcome,
                },
              });
            } catch {
              // Diagnostics must never block generation.
            }
          },
        });
        if (!result.ok || !result.value) {
          const attempts: BridgePullRequestAttempt[] = [
            ...result.failures.map((failure) => ({ tier: 'free_zen' as const, model: failure.model, reason: failure.reason })),
            ...result.skipped.map((entry) => ({ tier: 'free_zen' as const, model: entry.model, reason: entry.reason })),
          ];
          return pullRequestFailure(
            id,
            type,
            'FREE_ZEN_EXHAUSTED',
            result.deadlineExceeded
              ? 'Free Zen models ran out of time while generating the pull request description'
              : 'Unable to generate a pull request description with the available free Zen models',
            attempts,
          );
        }
        return { id, type, success: true, data: result.value };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: message };
      }
    }

    case 'api:git/conflict-details': {
      const { directory } = (payload || {}) as { directory?: string };
      if (!directory) {
        return { id, type, success: false, error: 'Directory is required' };
      }

      try {
        const statusResult = await deps.execGit(['status', '--porcelain'], directory);
        const statusPorcelain = statusResult.stdout;

        const unmergedResult = await deps.execGit(['diff', '--name-only', '--diff-filter=U'], directory);
        const unmergedFiles = unmergedResult.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);

        const diffResult = await deps.execGit(['diff'], directory);
        const diff = diffResult.stdout;

        let operation: 'merge' | 'rebase' = 'merge';
        let headInfo = '';

        const mergeHeadResult = await deps.execGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], directory);
        const mergeHeadExists = mergeHeadResult.exitCode === 0;

        if (mergeHeadExists) {
          operation = 'merge';
          const mergeHead = mergeHeadResult.stdout.trim();
          let mergeMsg = '';
          try {
            const mergeMsgPath = path.join(directory, '.git', 'MERGE_MSG');
            mergeMsg = await fs.promises.readFile(mergeMsgPath, 'utf8');
          } catch {
            // MERGE_MSG may not exist
          }
          headInfo = `MERGE_HEAD: ${mergeHead}${mergeMsg ? '\n' + mergeMsg : ''}`;
        } else {
          const rebaseHeadResult = await deps.execGit(['rev-parse', '--verify', '--quiet', 'REBASE_HEAD'], directory);
          const rebaseHeadExists = rebaseHeadResult.exitCode === 0;

          if (rebaseHeadExists) {
            operation = 'rebase';
            const rebaseHead = rebaseHeadResult.stdout.trim();
            headInfo = `REBASE_HEAD: ${rebaseHead}`;
          }
        }

        return {
          id,
          type,
          success: true,
          data: {
            statusPorcelain: statusPorcelain.trim(),
            unmergedFiles,
            diff: diff.trim(),
            headInfo: headInfo.trim(),
            operation,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: message };
      }
    }

    default:
      return null;
  }
}
