

import type { GitPullResult, GitPushResult, GitRemote, GitStatus, RuntimeAPIs } from './api/types';
import * as gitHttp from './gitApiHttp';
import { opencodeClient } from './opencode/client';
import { renderMagicPrompt, type MagicPromptId } from './magicPrompts';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { createSessionRecord } from '@/sync/session-actions';
import { useContextStore } from '@/stores/contextStore';
import { useConfigStore } from '@/stores/useConfigStore';
import {
  buildCommitPlanContext,
  serializeCommitPlanContext,
  COMMIT_DRAFT_CONTEXT_LIMITS,
} from './git/commitPlanContext';
import { GIT_GENERATION_SESSION_TITLE, unregisterGitGenerationSession } from './git/gitGenerationSessions';

export { isGitGenerationSession } from './git/gitGenerationSessions';

export type {
  GitStatus,
  GitDiffResponse,
  GetGitDiffOptions,
  GitBranchDetails,
  GitBranch,
  GitCommitResult,
  GitPushResult,
  GitPullResult,
  GitIdentityProfile,
  GitIdentityAuthType,
  GitIdentitySummary,
  GitLogEntry,
  GitLogResponse,
  GitWorktreeInfo,
  CreateGitWorktreePayload,
  GitWorktreeCreateResult,
  RemoveGitWorktreePayload,
  GitWorktreeValidationError,
  GitWorktreeValidationResult,
  GitDeleteBranchPayload,
  GitDeleteRemoteBranchPayload,
  GitRemoveRemotePayload,
  DiscoveredGitCredential,
  GitRemote,
  GitMergeResult,
  GitRebaseResult,
  MergeConflictDetails,
} from './api/types';

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

const getRuntimeGit = () => {
  if (typeof window !== 'undefined' && window.__OPENCHAMBER_RUNTIME_APIS__?.git) {
    return window.__OPENCHAMBER_RUNTIME_APIS__.git;
  }
  return null;
};

const STRUCTURED_OUTPUT_TOOL_NAMES = new Set(['structuredoutput', 'structured_output']);

const extractJsonValue = (value: string): unknown | null => {
  const text = value.trim();
  if (!text) {
    return null;
  }

  const candidates = new Set<string>();
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) {
      candidates.add(match[1].trim());
    }
  }

  candidates.add(text);

  for (const candidate of candidates) {
    const objectStart = candidate.indexOf('{');
    const arrayStart = candidate.indexOf('[');
    const starts = [objectStart, arrayStart].filter((index) => index >= 0).sort((a, b) => a - b);
    const start = starts[0] ?? -1;
    if (start < 0) {
      continue;
    }

    for (let end = candidate.length; end > start; end -= 1) {
      const last = candidate[end - 1];
      if (last !== '}' && last !== ']') {
        continue;
      }

      try {
        const parsed = JSON.parse(candidate.slice(start, end)) as unknown;
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      } catch {
        // Models can include prose around JSON; keep scanning candidate endings.
      }
    }
  }

  return null;
};

const extractJsonObject = (value: string): Record<string, unknown> | null => {
  const parsed = extractJsonValue(value);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return null;
};

const readPartText = (part: {
  type?: unknown;
  text?: unknown;
  content?: unknown;
  value?: unknown;
  tool?: unknown;
  state?: unknown;
  output?: unknown;
}): string => {
  if (part.type === 'text') {
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    if (typeof part.value === 'string') return part.value;
    return '';
  }

  if (part.type !== 'tool') {
    return '';
  }

  const toolName = typeof part.tool === 'string' ? part.tool.trim().toLowerCase() : '';
  const state = part.state && typeof part.state === 'object'
    ? part.state as { output?: unknown; status?: unknown }
    : null;
  const output = typeof state?.output === 'string'
    ? state.output
    : typeof part.output === 'string'
      ? part.output
      : '';

  if (!output.trim()) {
    return '';
  }

  if (STRUCTURED_OUTPUT_TOOL_NAMES.has(toolName)) {
    return output;
  }

  const trimmed = output.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return output;
  }

  return '';
};

const extractGenerationResponseText = (response: unknown): string => {
  const data = (response as { data?: { parts?: unknown[] } } | null)?.data;
  const parts = Array.isArray(data?.parts) ? data.parts : [];
  return parts
    .map((part) => readPartText(part as Parameters<typeof readPartText>[0]))
    .filter((textPart) => textPart.trim().length > 0)
    .join('\n')
    .trim();
};

export async function checkIsGitRepository(directory: string): Promise<boolean> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.checkIsGitRepository(directory);
  return gitHttp.checkIsGitRepository(directory);
}

export async function getGitStatus(directory: string, options?: { mode?: 'light' }): Promise<import('./api/types').GitStatus> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitStatus(directory, options);
  return gitHttp.getGitStatus(directory, options);
}

export async function getGitDiff(directory: string, options: import('./api/types').GetGitDiffOptions): Promise<import('./api/types').GitDiffResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitDiff(directory, options);
  return gitHttp.getGitDiff(directory, options);
}

export async function getGitFileDiff(
  directory: string,
  options: import('./api/types').GetGitFileDiffOptions
): Promise<import('./api/types').GitFileDiffResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitFileDiff(directory, options);
  return gitHttp.getGitFileDiff(directory, options);
}

export async function revertGitFile(directory: string, filePath: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.revertGitFile(directory, filePath);
  return gitHttp.revertGitFile(directory, filePath);
}

export async function stageGitFile(directory: string, filePath: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.stageGitFile(directory, filePath);
  return gitHttp.stageGitFile(directory, filePath);
}

export async function unstageGitFile(directory: string, filePath: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.unstageGitFile(directory, filePath);
  return gitHttp.unstageGitFile(directory, filePath);
}

export async function stageGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.stageGitHunk) return runtime.stageGitHunk(directory, filePath, patch);
  return gitHttp.stageGitHunk(directory, filePath, patch);
}

export async function unstageGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.unstageGitHunk) return runtime.unstageGitHunk(directory, filePath, patch);
  return gitHttp.unstageGitHunk(directory, filePath, patch);
}

export async function revertGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.revertGitHunk) return runtime.revertGitHunk(directory, filePath, patch);
  return gitHttp.revertGitHunk(directory, filePath, patch);
}

export async function isLinkedWorktree(directory: string): Promise<boolean> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.isLinkedWorktree(directory);
  return gitHttp.isLinkedWorktree(directory);
}

export async function getGitBranches(directory: string): Promise<import('./api/types').GitBranch> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitBranches(directory);
  return gitHttp.getGitBranches(directory);
}

export async function deleteGitBranch(directory: string, payload: import('./api/types').GitDeleteBranchPayload): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.deleteGitBranch(directory, payload);
  return gitHttp.deleteGitBranch(directory, payload);
}

export async function deleteRemoteBranch(directory: string, payload: import('./api/types').GitDeleteRemoteBranchPayload): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.deleteRemoteBranch(directory, payload);
  return gitHttp.deleteRemoteBranch(directory, payload);
}

type CommitGenerationPromptIds = {
  visible: MagicPromptId;
  instructions: MagicPromptId;
};

type CommitGenerationOptions = {
  zenModel?: string;
  providerId?: string;
  modelId?: string;
  stagedOnly?: boolean;
  commitMessageGuidance?: string;
};

export type CommitGenerationChatPromptPayload =
  | {
    status: 'ready';
    visiblePrompt: string;
    syntheticParts: Array<{ text: string; synthetic: true }>;
  }
  | {
    status: 'blocked';
    message: string;
  };

const COMMIT_PLAN_PREVIEW_DISABLED_TOOLS: Record<string, boolean> = {
  bash: false,
  read: false,
  write: false,
  edit: false,
  multiedit: false,
  apply_patch: false,
  grep: false,
  glob: false,
  list: false,
  task: false,
  webfetch: false,
  question: false,
};

const COMMIT_GENERATION_PROMPTS: CommitGenerationPromptIds = {
  visible: 'git.commit.generate.visible',
  instructions: 'git.commit.generate.instructions',
};

const buildCommitDraftOutputContract = (): string => `Output contract for a single commit message draft:
Return exactly one JSON array and nothing else.

The JSON array must contain one object:
[{"subject": string, "highlights": string[]}]`;

const buildCommitPlanPreviewOutputContract = (): string => `Output contract for a commit plan preview:
Return either:
- a JSON array of planned commits, or
- {"status":"blocked","message":"<blocking reason>","commits":[]}

Each planned commit object must contain:
{"subject": string, "highlights": string[], "files"?: string[]}

Workflow:
1. Read the supplied git context, selected files, and recent commit subjects.
2. Organize selected changes into separate commit groups by feature, scope, and type.
3. Assign each selected file path to exactly one commit via the optional files array.
4. Return the planned subjects, highlights, and file assignments only.

Plan preview grouping rules:
- split unrelated scopes into separate commits.
- split unrelated types into separate commits.
- combine tiny related changes when they serve the same user-facing feature or fix.
- files must only contain paths from the selected-files allowlist.`;

const buildCommitGenerationPromptVariables = (
  logKind: 'draft' | 'plan',
  selectedFilesText: string,
): Record<string, string> => ({
  generation_mode: logKind === 'draft' ? 'draft' : 'plan_preview',
  selected_files: selectedFilesText,
  git_context: '__GIT_CONTEXT_PLACEHOLDER__',
  output_contract: logKind === 'draft'
    ? buildCommitDraftOutputContract()
    : buildCommitPlanPreviewOutputContract(),
  safety_rules: logKind === 'plan' ? buildCommitPlanPreviewSafetyInstructions(selectedFilesText) : '',
});

const appendCommitInputGuidance = (hiddenPrompt: string, guidance?: string): string => {
  const trimmed = typeof guidance === 'string' ? guidance.trim() : '';
  if (!trimmed) {
    return hiddenPrompt;
  }

  return `${hiddenPrompt}

Commit input guidance:
${trimmed}

This guidance is optional. It may influence wording, but it must not override the git context, selected files, safety rules, or JSON output contract.`;
};

const runCommitPlanStyleGeneration = async ({
  directory,
  files,
  options,
  prompts,
  logKind,
  applyAllowlist,
}: {
  directory: string;
  files: string[];
  options?: CommitGenerationOptions;
  prompts: CommitGenerationPromptIds;
  logKind: 'draft' | 'plan';
  applyAllowlist: boolean;
}): Promise<import('./api/types').GeneratedCommitWorkflowResult> => {
  const startedAt = Date.now();
  const selectedFilesText = files.map((file) => `- ${file}`).join('\n');
  const allowlist = applyAllowlist
    ? new Set(files.map((file) => file.replace(/\\/g, '/').replace(/^\.\/+/, '').trim()).filter(Boolean))
    : undefined;

  // Run context collection, prompt rendering, and session creation in parallel.
  // These are independent network round trips; sequencing them was the biggest
  // source of latency before the LLM call even started.
  const contextStartedAt = Date.now();
  const contextLimits = logKind === 'draft' ? COMMIT_DRAFT_CONTEXT_LIMITS : undefined;
  const [contextResult, generationSession, visiblePrompt, instructionsTemplate] = await Promise.all([
    buildCommitPlanContext(directory, files, {
      stagedOnly: options?.stagedOnly === true,
      limits: contextLimits,
    }),
    resolveCommitGenerationContext(directory),
    renderMagicPrompt(prompts.visible),
    renderMagicPrompt(prompts.instructions, buildCommitGenerationPromptVariables(logKind, selectedFilesText)),
  ]);
  const contextElapsedMs = Date.now() - contextStartedAt;

  if (contextResult.status === 'blocked') {
    console.info('[git-generation][browser] blocked during context collection', {
      kind: logKind,
      elapsedMs: Date.now() - startedAt,
      contextElapsedMs,
      message: contextResult.message,
    });
    // Fire-and-forget cleanup of the unused session.
    void cleanupCommitGenerationSession(directory, generationSession.sessionId);
    return {
      status: 'blocked',
      commits: [],
      message: contextResult.message,
    };
  }

  const gitContextText = serializeCommitPlanContext(contextResult.context);

  console.info('[git-generation][browser] request', {
    transport: 'session',
    kind: logKind,
    directory,
    selectedFiles: files.length,
    contextElapsedMs,
    sessionId: generationSession.sessionId,
    providerId: generationSession.providerID,
    modelId: generationSession.modelID,
    agent: generationSession.agent,
    sessionCreatedForGeneration: generationSession.sessionCreatedForGeneration === true,
    stagedOnly: options?.stagedOnly === true,
  });

  const hiddenPrompt = appendCommitInputGuidance(
    instructionsTemplate.replace('__GIT_CONTEXT_PLACEHOLDER__', gitContextText),
    logKind === 'draft' ? options?.commitMessageGuidance : undefined,
  );

  const promptStartedAt = Date.now();
  try {
    const structured = await runJsonGenerationInActiveSession({
      directory,
      visiblePrompt,
      hiddenPrompt,
      generationSession,
      kind: 'commit',
      tools: COMMIT_PLAN_PREVIEW_DISABLED_TOOLS,
    });
    const promptElapsedMs = Date.now() - promptStartedAt;

    const parseStartedAt = Date.now();
    const result = normalizeCommitWorkflowResult(structured, allowlist);
    const finalResult = logKind === 'draft' && result.status === 'complete'
      ? { ...result, commits: result.commits.slice(0, 1) }
      : result;
    const parseElapsedMs = Date.now() - parseStartedAt;

    console.info('[git-generation][browser] success', {
      transport: 'session',
      kind: logKind,
      elapsedMs: Date.now() - startedAt,
      contextElapsedMs,
      promptElapsedMs,
      parseElapsedMs,
      status: finalResult.status,
      commitsCount: finalResult.commits.length,
    });
    return finalResult;
  } catch (error) {
    if (isGitGenerationCancelledError(error)) {
      console.info('[git-generation][browser] cancelled', {
        transport: 'session',
        kind: logKind,
        elapsedMs: Date.now() - startedAt,
        contextElapsedMs,
        promptElapsedMs: Date.now() - promptStartedAt,
      });
      throw error;
    }
    console.error('[git-generation][browser] failed', {
      transport: 'session',
      kind: logKind,
      elapsedMs: Date.now() - startedAt,
      contextElapsedMs,
      promptElapsedMs: Date.now() - promptStartedAt,
      message: error instanceof Error ? error.message : String(error),
      error,
    });
    throw error;
  } finally {
    // Fire-and-forget — the user already has their result; don't block on the
    // server confirming the session delete.
    void cleanupCommitGenerationSession(directory, generationSession.sessionId);
  }
};

export async function buildCommitGenerationChatPromptPayload(
  directory: string,
  files: string[],
  options?: Pick<CommitGenerationOptions, 'stagedOnly'>,
): Promise<CommitGenerationChatPromptPayload> {
  const selectedFilesText = files.map((file) => `- ${file}`).join('\n');
  const contextResult = await buildCommitPlanContext(directory, files, {
    stagedOnly: options?.stagedOnly === true,
    limits: COMMIT_DRAFT_CONTEXT_LIMITS,
  });

  if (contextResult.status === 'blocked') {
    return {
      status: 'blocked',
      message: contextResult.message,
    };
  }

  const [visiblePrompt, instructionsTemplate] = await Promise.all([
    renderMagicPrompt(COMMIT_GENERATION_PROMPTS.visible),
    renderMagicPrompt(
      COMMIT_GENERATION_PROMPTS.instructions,
      buildCommitGenerationPromptVariables('draft', selectedFilesText),
    ),
  ]);

  return {
    status: 'ready',
    visiblePrompt,
    syntheticParts: [
      {
        synthetic: true,
        text: instructionsTemplate.replace(
          '__GIT_CONTEXT_PLACEHOLDER__',
          serializeCommitPlanContext(contextResult.context),
        ),
      },
    ],
  };
}

export async function generateCommitMessageDraft(
  directory: string,
  files: string[],
  options?: CommitGenerationOptions
): Promise<import('./api/types').GeneratedCommitWorkflowResult> {
  return runCommitPlanStyleGeneration({
    directory,
    files,
    options,
    prompts: COMMIT_GENERATION_PROMPTS,
    logKind: 'draft',
    applyAllowlist: false,
  });
}

export async function generateCommitPlanPreview(
  directory: string,
  files: string[],
  options?: CommitGenerationOptions
): Promise<import('./api/types').GeneratedCommitWorkflowResult> {
  return runCommitPlanStyleGeneration({
    directory,
    files,
    options,
    prompts: COMMIT_GENERATION_PROMPTS,
    logKind: 'plan',
    applyAllowlist: true,
  });
}

export async function executeApprovedCommitPlan(
  directory: string,
  commits: import('./api/types').GeneratedCommitMessage[],
  options: { selectedFiles: string[]; stagedOnly?: boolean } = { selectedFiles: [] },
): Promise<import('./api/types').GeneratedCommitWorkflowResult> {
  const normalizePath = (value: string): string => value.replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
  const allowlist = new Set(options.selectedFiles.map(normalizePath).filter(Boolean));
  const used = new Set<string>();
  const groups: Array<{ subject: string; files: string[] }> = [];

  for (const commit of commits) {
    const subject = typeof commit.subject === 'string' ? commit.subject.trim() : '';
    if (!subject) continue;
    const requested = Array.isArray(commit.files) ? commit.files.map(normalizePath) : [];
    const files = requested
      .filter((file) => file.length > 0)
      .filter((file) => allowlist.size === 0 || allowlist.has(file))
      .filter((file) => !used.has(file));
    files.forEach((file) => used.add(file));
    groups.push({ subject, files });
  }

  const leftover = Array.from(allowlist).filter((file) => !used.has(file));
  if (leftover.length > 0 && groups.length > 0) {
    groups[groups.length - 1].files.push(...leftover);
  }

  const executable = groups.filter((group) => group.files.length > 0 || options.stagedOnly);
  if (executable.length === 0) {
    return { status: 'blocked', commits: [], message: 'No commit groups had files to commit' };
  }

  for (const group of executable) {
    await createGitCommit(directory, group.subject, {
      files: group.files,
      stagedOnly: options.stagedOnly ?? false,
    });
  }

  try {
    await gitPush(directory);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to push';
    if (/no upstream|set-upstream/i.test(message)) {
      const branch = (await getGitStatus(directory)).current;
      if (typeof branch === 'string' && branch.length > 0) {
        await gitPush(directory, { options: ['--set-upstream', 'origin', branch] });
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  }

  return {
    status: 'complete',
    commits: executable.map((group) => ({ subject: group.subject, highlights: [], files: group.files })),
  };
}

export async function generatePullRequestDescription(
  directory: string,
  payload: { base: string; head: string; context?: string; zenModel?: string; providerId?: string; modelId?: string }
): Promise<import('./api/types').GeneratedPullRequestDescription> {
  const startedAt = Date.now();
  const generationSession = resolveSessionGenerationContext();
  if (!generationSession) {
    throw new Error('Select existing session for generation');
  }

  const commitLog = await getGitLog(directory, {
    from: payload.base,
    to: payload.head,
    maxCount: 50,
  });
  const commits = (Array.isArray(commitLog?.all) ? commitLog.all : [])
    .filter((entry) => typeof entry?.hash === 'string' && entry.hash.length > 0)
    .map((entry) => ({
      hash: entry.hash,
      subject: typeof entry.message === 'string' ? entry.message.trim() : '',
    }));

  if (commits.length === 0) {
    throw new Error(`No commits found in range ${payload.base}...${payload.head}`);
  }

  const filesSet = new Set<string>();
  await Promise.all(commits.map(async (commit) => {
    try {
      const response = await getCommitFiles(directory, commit.hash);
      const files = Array.isArray(response?.files) ? response.files : [];
      for (const file of files) {
        if (typeof file?.path === 'string' && file.path.trim().length > 0) {
          filesSet.add(file.path.trim());
        }
      }
    } catch (error) {
      console.warn('[git-generation][browser] failed to collect commit files', {
        hash: commit.hash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));
  const changedFiles = Array.from(filesSet).sort().slice(0, 300);

  console.info('[git-generation][browser] request', {
    transport: 'session',
    kind: 'pr',
    directory,
    sessionId: generationSession.sessionId,
    providerId: generationSession.providerID,
    modelId: generationSession.modelID,
    agent: generationSession.agent,
    base: payload.base,
    head: payload.head,
    commits: commits.length,
    changedFiles: changedFiles.length,
  });

  const visiblePrompt = await renderMagicPrompt('git.pr.generate.visible');
  const hiddenPrompt = await renderMagicPrompt('git.pr.generate.instructions', {
    base_branch: payload.base,
    head_branch: payload.head,
    commits: commits.map((commit) => `- ${commit.hash.slice(0, 7)} ${commit.subject || '(no subject)'}`).join('\n'),
    changed_files: changedFiles.length > 0 ? changedFiles.map((file) => `- ${file}`).join('\n') : '- none detected',
    additional_context_block: payload.context?.trim() ? `\nAdditional context:\n${payload.context.trim()}` : '',
  });

  try {
    const structured = await runJsonGenerationInActiveSession({
      directory,
      visiblePrompt,
      hiddenPrompt,
      generationSession,
      kind: 'pr',
    });

    const structuredRecord = structured && typeof structured === 'object' && !Array.isArray(structured)
      ? structured as Record<string, unknown>
      : {};
    const result = {
      title: typeof structuredRecord.title === 'string' ? structuredRecord.title.trim() : '',
      body: typeof structuredRecord.body === 'string' ? structuredRecord.body.trim() : '',
    };
    console.info('[git-generation][browser] success', {
      transport: 'session',
      kind: 'pr',
      elapsedMs: Date.now() - startedAt,
      titleLength: result.title.length,
      bodyLength: result.body.length,
    });
    return result;
  } catch (error) {
    if (isGitGenerationCancelledError(error)) {
      console.info('[git-generation][browser] cancelled', {
        transport: 'session',
        kind: 'pr',
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    }
    console.error('[git-generation][browser] failed', {
      transport: 'session',
      kind: 'pr',
      elapsedMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
      error,
    });
    throw error;
  }
}

type SessionGenerationContext = {
  sessionId: string;
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
  sessionCreatedForGeneration?: boolean;
};

type GenerationModelSelection = { providerId: string; modelId: string };

const NO_GENERATION_MODEL_MESSAGE = 'Select a model before generating with AI';

export class GitGenerationCancelledError extends Error {
  constructor() {
    super('Generation was cancelled');
    this.name = 'GitGenerationCancelledError';
  }
}

export const isGitGenerationCancelledError = (error: unknown): error is GitGenerationCancelledError =>
  error instanceof Error && error.name === 'GitGenerationCancelledError';

const resolveCurrentGenerationSessionId = (): string | null => {
  const sessionId = useSessionUIStore.getState().currentSessionId;
  return typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId : null;
};

const resolveGenerationAgent = (sessionId: string | null): string | undefined => {
  const context = useContextStore.getState();
  const config = useConfigStore.getState();
  const agent = sessionId ? context.getSessionAgentSelection(sessionId) : null;
  return agent || config.currentAgentName || undefined;
};

const resolveGenerationModel = (
  sessionId: string | null,
  agent: string | undefined,
): GenerationModelSelection | null => {
  const context = useContextStore.getState();
  const config = useConfigStore.getState();

  const sessionModel = sessionId ? context.getSessionModelSelection(sessionId) : null;
  const agentModel = sessionId && agent ? context.getAgentModelForSession(sessionId, agent) : null;
  return agentModel || sessionModel || (config.currentProviderId && config.currentModelId
    ? { providerId: config.currentProviderId, modelId: config.currentModelId }
    : null);
};

const resolveCurrentGenerationVariant = (): string | undefined => {
  const variant = useConfigStore.getState().currentVariant;
  return typeof variant === 'string' && variant.trim().length > 0 ? variant.trim() : undefined;
};

const buildSessionGenerationContext = (
  sessionId: string,
  options?: { sessionCreatedForGeneration?: boolean },
): SessionGenerationContext => {
  const agent = resolveGenerationAgent(sessionId);
  const selectedModel = resolveGenerationModel(sessionId, agent);

  if (!selectedModel?.providerId || !selectedModel?.modelId) {
    throw new Error(NO_GENERATION_MODEL_MESSAGE);
  }

  return {
    sessionId,
    providerID: selectedModel.providerId,
    modelID: selectedModel.modelId,
    agent,
    variant: resolveCurrentGenerationVariant(),
    ...(options?.sessionCreatedForGeneration ? { sessionCreatedForGeneration: true } : {}),
  };
};

const resolveSessionGenerationContext = (): SessionGenerationContext | null => {
  const sessionId = resolveCurrentGenerationSessionId();
  if (!sessionId) {
    return null;
  }

  return buildSessionGenerationContext(sessionId);
};

const resolveCommitGenerationContext = async (directory: string): Promise<SessionGenerationContext> => {
  // Commit generation is intentionally isolated from the active chat so its
  // raw JSON transcript never pollutes the user's current session. We also
  // intentionally do not attach the user's chat agent — agent system prompts
  // (e.g. role-play, language preferences) commonly break strict JSON output.
  const fallbackModel = resolveGenerationModel(null, undefined);
  if (!fallbackModel?.providerId || !fallbackModel?.modelId) {
    throw new Error(NO_GENERATION_MODEL_MESSAGE);
  }

  const session = await createSessionRecord(
    GIT_GENERATION_SESSION_TITLE,
    directory,
    null,
    { isGitGenerationSession: true },
  );
  if (!session?.id) {
    throw new Error('Unable to create a session for commit generation workflow');
  }

  return {
    sessionId: session.id,
    providerID: fallbackModel.providerId,
    modelID: fallbackModel.modelId,
    variant: resolveCurrentGenerationVariant(),
    sessionCreatedForGeneration: true,
  };
};

const buildCommitPlanPreviewSafetyInstructions = (selectedFilesText: string): string => `Commit plan preview safety rules:
- Do not stage, commit, pull, rebase, or push. This preview must not mutate repository state.
- Treat the selected files list above as a fixed allowlist for this preview.
- If conflicts or unsafe git state prevent a reliable plan, return {"status":"blocked","message":"<blocking reason>","commits":[]}.

Selected files allowlist:
${selectedFilesText}`;

const normalizeGitPathForAllowlist = (value: string): string =>
  value.replace(/\\/g, '/').replace(/^\.\/+/, '').trim();

const normalizeCommitWorkflowCommit = (
  value: unknown,
  allowlist?: Set<string>,
): import('./api/types').GeneratedCommitMessage | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const subject = typeof record.subject === 'string' ? record.subject.trim() : '';
  if (!subject) {
    return null;
  }
  const highlights = Array.isArray(record.highlights)
    ? record.highlights
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 3)
    : [];
  const files = Array.isArray(record.files)
    ? record.files
      .filter((item): item is string => typeof item === 'string')
      .map((item) => normalizeGitPathForAllowlist(item))
      .filter((item) => item.length > 0)
      .filter((item, index, all) => all.indexOf(item) === index)
      .filter((item) => !allowlist || allowlist.has(item))
    : [];
  return {
    subject,
    highlights,
    ...(files.length > 0 ? { files } : {}),
  };
};

const normalizeCommitWorkflowResult = (
  value: unknown,
  allowlist?: Set<string>,
): import('./api/types').GeneratedCommitWorkflowResult => {
  if (Array.isArray(value)) {
    const commits = value
      .map((item) => normalizeCommitWorkflowCommit(item, allowlist))
      .filter((item): item is import('./api/types').GeneratedCommitMessage => Boolean(item));
    if (commits.length === 0) {
      throw new Error('Structured workflow output missing commits');
    }
    return { status: 'complete', commits };
  }

  if (!value || typeof value !== 'object') {
    throw new Error('Structured workflow output must be an array or object');
  }

  const record = value as Record<string, unknown>;
  const status = record.status === 'blocked' ? 'blocked' : 'complete';
  const commits = Array.isArray(record.commits)
    ? record.commits
      .map((item) => normalizeCommitWorkflowCommit(item, allowlist))
      .filter((item): item is import('./api/types').GeneratedCommitMessage => Boolean(item))
    : [];
  const message = typeof record.message === 'string' && record.message.trim().length > 0
    ? record.message.trim()
    : undefined;

  if (status === 'blocked') {
    return { status, commits, ...(message ? { message } : {}) };
  }

  const singleCommit = normalizeCommitWorkflowCommit(record, allowlist);
  const normalizedCommits = commits.length > 0 ? commits : (singleCommit ? [singleCommit] : []);
  if (normalizedCommits.length === 0) {
    throw new Error('Structured workflow output missing commits');
  }

  return { status, commits: normalizedCommits, ...(message ? { message } : {}) };
};

const cleanupCommitGenerationSession = async (directory: string, sessionId: string): Promise<void> => {
  unregisterGitGenerationSession(sessionId);
  const trimmedDirectory = typeof directory === 'string' ? directory.trim() : '';
  try {
    await opencodeClient.withDirectory(directory, async () => {
      await opencodeClient.getApiClient().session.delete({
        sessionID: sessionId,
        ...(trimmedDirectory.length > 0 ? { directory: trimmedDirectory } : {}),
      });
    });
  } catch (error) {
    console.warn('[git-generation][browser] failed to clean up commit workflow session', {
      sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

const extractGenerationErrorMessage = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }

  const error = value as { data?: unknown; message?: unknown; name?: unknown };
  if (typeof error.data === 'object' && error.data) {
    const dataMessage = (error.data as { message?: unknown }).message;
    if (typeof dataMessage === 'string') {
      return dataMessage;
    }
  }
  if (typeof error.message === 'string') {
    return error.message;
  }
  if (typeof error.name === 'string') {
    return error.name;
  }
  return null;
};

const isAbortErrorMessage = (message: string | null): boolean => {
  if (!message) {
    return false;
  }
  const normalized = message.trim().toLowerCase();
  return normalized === 'aborted' || normalized === 'aborterror';
};

const isAbortedGenerationResponse = (
  info?: { finish?: unknown; error?: unknown },
  responseError?: unknown,
): boolean => {
  const finish = typeof info?.finish === 'string' ? info.finish.trim().toLowerCase() : '';
  return finish === 'abort'
    || finish === 'aborted'
    || isAbortErrorMessage(extractGenerationErrorMessage(info?.error))
    || isAbortErrorMessage(extractGenerationErrorMessage(responseError));
};

const runJsonGenerationInActiveSession = async ({
  directory,
  visiblePrompt,
  hiddenPrompt,
  generationSession,
  kind,
  format,
  tools,
}: {
  directory: string;
  visiblePrompt: string;
  hiddenPrompt?: string;
  generationSession: SessionGenerationContext;
  kind: 'commit' | 'pr';
  format?: {
    type: 'json_schema';
    schema: Record<string, unknown>;
    retryCount?: number;
  };
  tools?: Record<string, boolean>;
}): Promise<unknown> => {
  const requestStartedAt = Date.now();
  console.info('[git-generation][browser] runJsonGenerationInActiveSession start', {
    kind,
    directory,
    sessionId: generationSession.sessionId,
    providerID: generationSession.providerID,
    modelID: generationSession.modelID,
    agent: generationSession.agent,
    variant: generationSession.variant,
  });
  const trimmedDirectory = typeof directory === 'string' ? directory.trim() : '';
  const visiblePromptText = typeof visiblePrompt === 'string' ? visiblePrompt.trim() : '';
  const hiddenPromptText = typeof hiddenPrompt === 'string' ? hiddenPrompt.trim() : '';
  const promptParts: Array<{ type: 'text'; text: string; synthetic?: boolean }> = [];
  if (visiblePromptText) {
    promptParts.push({ type: 'text', text: visiblePromptText, synthetic: false });
  }
  if (hiddenPromptText) {
    promptParts.push({ type: 'text', text: hiddenPromptText, synthetic: true });
  }
  if (promptParts.length === 0) {
    throw new Error('Generation prompts are empty');
  }

  const response = await opencodeClient.withDirectory(directory, async () => {
    return opencodeClient.getApiClient().session.prompt({
      sessionID: generationSession.sessionId,
      ...(trimmedDirectory.length > 0 ? { directory: trimmedDirectory } : {}),
      model: {
        providerID: generationSession.providerID,
        modelID: generationSession.modelID,
      },
      ...(generationSession.agent ? { agent: generationSession.agent } : {}),
      ...(generationSession.variant ? { variant: generationSession.variant } : {}),
      ...(format ? { format } : {}),
      ...(tools ? { tools } : {}),
      parts: promptParts,
    });
  });

  const responseError = response?.error as { message?: string } | undefined;
  if (isAbortedGenerationResponse(undefined, responseError)) {
    throw new GitGenerationCancelledError();
  }
  if (!response?.data) {
    throw new Error(responseError?.message || `Failed to generate ${kind} output`);
  }

  const info = response.data.info as { finish?: unknown; error?: unknown };
  if (isAbortedGenerationResponse(info, responseError)) {
    throw new GitGenerationCancelledError();
  }
  const generationText = extractGenerationResponseText(response);
  const parsedOutput = kind === 'commit'
    ? extractJsonValue(generationText)
    : extractJsonObject(generationText);
  if (!parsedOutput) {
    console.error('[git-generation][browser] invalid JSON output', {
      kind,
      sessionId: generationSession.sessionId,
      elapsedMs: Date.now() - requestStartedAt,
      finish: info?.finish,
      generationText,
      messageInfo: response.data.info,
      messageParts: response.data.parts,
    });
    const snippet = generationText.slice(0, 240).replace(/\s+/g, ' ').trim();
    const reason = snippet.length > 0
      ? `model did not return JSON (got: "${snippet}${generationText.length > snippet.length ? '…' : ''}")`
      : 'model returned no parseable output';
    throw new Error(kind === 'commit'
      ? `Commit generation failed: ${reason}`
      : `Generation failed: ${reason}`);
  }

  return parsedOutput;
};

export async function listGitWorktrees(directory: string): Promise<import('./api/types').GitWorktreeInfo[]> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.list) {
    return runtime.worktree.list(directory);
  }
  if (runtime) return runtime.listGitWorktrees(directory);
  return gitHttp.listGitWorktrees(directory);
}

export async function getPrimaryWorktreeRoot(directory: string): Promise<string> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.primaryRoot) {
    return runtime.worktree.primaryRoot(directory);
  }
  if (runtime?.getPrimaryWorktreeRoot) {
    return runtime.getPrimaryWorktreeRoot(directory);
  }
  return gitHttp.getPrimaryWorktreeRoot(directory);
}

export async function validateGitWorktree(
  directory: string,
  payload: import('./api/types').CreateGitWorktreePayload
): Promise<import('./api/types').GitWorktreeValidationResult> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.validate) {
    return runtime.worktree.validate(directory, payload);
  }
  if (runtime?.validateGitWorktree) {
    return runtime.validateGitWorktree(directory, payload);
  }
  return gitHttp.validateGitWorktree(directory, payload);
}

export async function getGitWorktreeBootstrapStatus(
  directory: string,
): Promise<import('./api/types').GitWorktreeBootstrapStatus> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.bootstrapStatus) {
    return runtime.worktree.bootstrapStatus(directory);
  }
  if (runtime?.getGitWorktreeBootstrapStatus) {
    return runtime.getGitWorktreeBootstrapStatus(directory);
  }
  return gitHttp.getGitWorktreeBootstrapStatus(directory);
}

export async function previewGitWorktree(
  directory: string,
  payload: import('./api/types').CreateGitWorktreePayload
): Promise<import('./api/types').GitWorktreeCreateResult> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.preview) {
    return runtime.worktree.preview(directory, payload);
  }
  if (runtime?.previewGitWorktree) {
    return runtime.previewGitWorktree(directory, payload);
  }
  return gitHttp.previewGitWorktree(directory, payload);
}

export async function createGitWorktree(
  directory: string,
  payload: import('./api/types').CreateGitWorktreePayload
): Promise<import('./api/types').GitWorktreeCreateResult> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.create) {
    return runtime.worktree.create(directory, payload);
  }
  if (runtime?.createGitWorktree) {
    return runtime.createGitWorktree(directory, payload);
  }
  return gitHttp.createGitWorktree(directory, payload);
}

export async function deleteGitWorktree(
  directory: string,
  payload: import('./api/types').RemoveGitWorktreePayload
): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime?.worktree?.remove) {
    return runtime.worktree.remove(directory, payload);
  }
  if (runtime?.deleteGitWorktree) {
    return runtime.deleteGitWorktree(directory, payload);
  }
  return gitHttp.deleteGitWorktree(directory, payload);
}

export const git = {
  worktree: {
    list: listGitWorktrees,
    primaryRoot: getPrimaryWorktreeRoot,
    validate: validateGitWorktree,
    create: createGitWorktree,
    remove: deleteGitWorktree,
  },
};

export async function createGitCommit(
  directory: string,
  message: string,
  options: import('./api/types').CreateGitCommitOptions = {}
): Promise<import('./api/types').GitCommitResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.createGitCommit(directory, message, options);
  return gitHttp.createGitCommit(directory, message, options);
}

export async function gitPush(
  directory: string,
  options: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> } = {}
): Promise<import('./api/types').GitPushResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.gitPush(directory, options);
  return gitHttp.gitPush(directory, options);
}

export async function gitPull(
  directory: string,
  options: import('./api/types').GitPullOptions = {}
): Promise<import('./api/types').GitPullResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.gitPull(directory, options);
  return gitHttp.gitPull(directory, options);
}

export async function gitFetch(
  directory: string,
  options: { remote?: string; branch?: string } = {}
): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.gitFetch(directory, options);
  return gitHttp.gitFetch(directory, options);
}

export type GitPushSyncResult = {
  remote: string;
  branch?: string;
  fetched: boolean;
  pulledFileCount: number;
  pushedChanges: boolean;
  pullResult: GitPullResult | null;
  pushResult: GitPushResult | null;
  statusAfterFetch: GitStatus;
  statusAfterPull: GitStatus;
};

type GitPushSyncDeps = {
  getGitStatus: typeof getGitStatus;
  getRemotes: typeof getRemotes;
  gitFetch: typeof gitFetch;
  gitPull: typeof gitPull;
  gitPush: typeof gitPush;
};

const getRemoteNameForPushSync = (optionsRemote: string | undefined, status: GitStatus, remotes: GitRemote[]): string => {
  const requested = optionsRemote?.trim();
  if (requested) return requested;
  const trackingRemote = typeof status.tracking === 'string' && status.tracking.includes('/')
    ? status.tracking.split('/')[0]
    : '';
  if (trackingRemote) return trackingRemote;
  return remotes.find((remote) => remote.name === 'origin')?.name || remotes[0]?.name || 'origin';
};

const getTrackedBranchForRemote = (status: GitStatus, remoteName: string, requestedBranch?: string): string | undefined => {
  const branch = requestedBranch?.trim();
  if (branch) return branch;
  const trackingPrefix = `${remoteName}/`;
  if (typeof status.tracking === 'string' && status.tracking.startsWith(trackingPrefix)) {
    return status.tracking.slice(trackingPrefix.length) || undefined;
  }
  return status.current || undefined;
};

const isWorkingTreeDirty = (status: GitStatus): boolean => {
  return status.isClean === false || (Array.isArray(status.files) && status.files.length > 0);
};

export async function syncGitBranchForPush(
  directory: string,
  options: { remote?: string; branch?: string; rebase?: boolean } = {},
  deps?: Partial<GitPushSyncDeps>,
): Promise<GitPushSyncResult> {
  const gitDeps: GitPushSyncDeps = {
    getGitStatus,
    getRemotes,
    gitFetch,
    gitPull,
    gitPush,
    ...deps,
  };

  const [initialStatus, remotes] = await Promise.all([
    gitDeps.getGitStatus(directory),
    gitDeps.getRemotes(directory).catch(() => [] as GitRemote[]),
  ]);
  const remoteName = getRemoteNameForPushSync(options.remote, initialStatus, remotes);
  const branch = getTrackedBranchForRemote(initialStatus, remoteName, options.branch);

  await gitDeps.gitFetch(directory, { remote: remoteName });
  const statusAfterFetch = await gitDeps.getGitStatus(directory);

  let pullResult: GitPullResult | null = null;
  let statusAfterPull = statusAfterFetch;
  if ((statusAfterFetch.behind ?? 0) > 0) {
    if (isWorkingTreeDirty(statusAfterFetch)) {
      throw new Error(
        `Branch is behind ${statusAfterFetch.tracking || remoteName} and the working tree is dirty. Commit, stash, or discard local changes before pulling.`
      );
    }
    const pullBranch = getTrackedBranchForRemote(statusAfterFetch, remoteName, branch);
    if (!pullBranch) {
      throw new Error(`Branch is behind ${remoteName}, but no branch name is available for pull.`);
    }
    pullResult = await gitDeps.gitPull(directory, {
      remote: remoteName,
      branch: pullBranch,
      rebase: options.rebase ?? true,
    });
    statusAfterPull = await gitDeps.getGitStatus(directory);
  }

  const shouldPush = (statusAfterPull.ahead ?? 0) > 0 || !statusAfterPull.tracking;
  let pushResult: GitPushResult | null = null;
  if (shouldPush) {
    pushResult = await gitDeps.gitPush(directory, {
      remote: remoteName,
      ...(options.branch ? { branch: options.branch } : {}),
    });
  }

  return {
    remote: remoteName,
    branch,
    fetched: true,
    pulledFileCount: pullResult?.files.length ?? 0,
    pushedChanges: Boolean(pushResult),
    pullResult,
    pushResult,
    statusAfterFetch,
    statusAfterPull,
  };
}

export async function listGitStashes(directory: string): Promise<{ stashes: import('./api/types').GitStashEntry[] }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.listGitStashes(directory);
  return gitHttp.listGitStashes(directory);
}

export async function countGitStashFiles(directory: string, refs: string[]): Promise<{ counts: Record<string, number> }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.countGitStashFiles(directory, refs);
  return gitHttp.countGitStashFiles(directory, refs);
}

export async function stashGitChanges(directory: string, options: { message?: string } = {}): Promise<{ success: boolean; created: boolean; message: string; output: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.stashGitChanges(directory, options);
  return gitHttp.stashGitChanges(directory, options);
}

export async function applyGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.applyGitStash(directory, options);
  return gitHttp.applyGitStash(directory, options);
}

export async function popGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.popGitStash(directory, options);
  return gitHttp.popGitStash(directory, options);
}

export async function dropGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.dropGitStash(directory, options);
  return gitHttp.dropGitStash(directory, options);
}

export async function checkoutBranch(directory: string, branch: string): Promise<{ success: boolean; branch: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.checkoutBranch(directory, branch);
  return gitHttp.checkoutBranch(directory, branch);
}

export async function createBranch(
  directory: string,
  name: string,
  startPoint?: string
): Promise<{ success: boolean; branch: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.createBranch(directory, name, startPoint);
  return gitHttp.createBranch(directory, name, startPoint);
}

export async function renameBranch(
  directory: string,
  oldName: string,
  newName: string
): Promise<{ success: boolean; branch: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.renameBranch(directory, oldName, newName);
  return gitHttp.renameBranch(directory, oldName, newName);
}

export async function getGitLog(
  directory: string,
  options: import('./api/types').GitLogOptions = {}
): Promise<import('./api/types').GitLogResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitLog(directory, options);
  return gitHttp.getGitLog(directory, options);
}

export async function getCommitFiles(
  directory: string,
  hash: string
): Promise<import('./api/types').GitCommitFilesResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getCommitFiles(directory, hash);
  return gitHttp.getCommitFiles(directory, hash);
}

export async function getGitIdentities(): Promise<import('./api/types').GitIdentityProfile[]> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitIdentities();
  return gitHttp.getGitIdentities();
}

export async function createGitIdentity(profile: import('./api/types').GitIdentityProfile): Promise<import('./api/types').GitIdentityProfile> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.createGitIdentity(profile);
  return gitHttp.createGitIdentity(profile);
}

export async function updateGitIdentity(id: string, updates: import('./api/types').GitIdentityProfile): Promise<import('./api/types').GitIdentityProfile> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.updateGitIdentity(id, updates);
  return gitHttp.updateGitIdentity(id, updates);
}

export async function deleteGitIdentity(id: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.deleteGitIdentity(id);
  return gitHttp.deleteGitIdentity(id);
}

export async function getCurrentGitIdentity(directory: string): Promise<import('./api/types').GitIdentitySummary | null> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getCurrentGitIdentity(directory);
  return gitHttp.getCurrentGitIdentity(directory);
}

export async function hasLocalIdentity(directory: string): Promise<boolean> {
  const runtime = getRuntimeGit();
  if (runtime?.hasLocalIdentity) return runtime.hasLocalIdentity(directory);
  return gitHttp.hasLocalIdentity(directory);
}

export async function setGitIdentity(
  directory: string,
  profileId: string
): Promise<{ success: boolean; profile: import('./api/types').GitIdentityProfile }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.setGitIdentity(directory, profileId);
  return gitHttp.setGitIdentity(directory, profileId);
}

export async function discoverGitCredentials(): Promise<import('./api/types').DiscoveredGitCredential[]> {
  const runtime = getRuntimeGit();
  if (runtime?.discoverGitCredentials) return runtime.discoverGitCredentials();
  return gitHttp.discoverGitCredentials();
}

export async function getGlobalGitIdentity(): Promise<import('./api/types').GitIdentitySummary | null> {
  const runtime = getRuntimeGit();
  if (runtime?.getGlobalGitIdentity) return runtime.getGlobalGitIdentity();
  return gitHttp.getGlobalGitIdentity();
}

export async function getRemoteUrl(directory: string, remote?: string): Promise<string | null> {
  const runtime = getRuntimeGit();
  if (runtime?.getRemoteUrl) return runtime.getRemoteUrl(directory, remote);
  return gitHttp.getRemoteUrl(directory, remote);
}

export async function getRemotes(directory: string): Promise<import('./api/types').GitRemote[]> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getRemotes(directory);
  return gitHttp.getRemotes(directory);
}

export async function removeRemote(
  directory: string,
  payload: import('./api/types').GitRemoveRemotePayload
): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.removeRemote(directory, payload);
  return gitHttp.removeRemote(directory, payload);
}

export async function rebase(
  directory: string,
  options: { onto: string }
): Promise<import('./api/types').GitRebaseResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.rebase(directory, options);
  return gitHttp.rebase(directory, options);
}

export async function abortRebase(directory: string): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.abortRebase(directory);
  return gitHttp.abortRebase(directory);
}

export async function merge(
  directory: string,
  options: { branch: string }
): Promise<import('./api/types').GitMergeResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.merge(directory, options);
  return gitHttp.merge(directory, options);
}

export async function abortMerge(directory: string): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.abortMerge(directory);
  return gitHttp.abortMerge(directory);
}

export async function continueRebase(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.continueRebase(directory);
  return gitHttp.continueRebase(directory);
}

export async function continueMerge(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.continueMerge(directory);
  return gitHttp.continueMerge(directory);
}

export async function stash(
  directory: string,
  options?: { message?: string; includeUntracked?: boolean }
): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.stash(directory, options);
  return gitHttp.stash(directory, options);
}

export async function stashPop(directory: string): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.stashPop(directory);
  return gitHttp.stashPop(directory);
}

export async function getConflictDetails(directory: string): Promise<import('./api/types').MergeConflictDetails> {
  const runtime = getRuntimeGit();
  if (runtime?.getConflictDetails) return runtime.getConflictDetails(directory);
  return gitHttp.getConflictDetails(directory);
}

export async function validateWorktreeDirectory(
  directory: string,
  worktreeRoot: string
): Promise<{
  valid: boolean;
  insideWorktreeRoot: boolean;
  resolvedWorktreeRoot: string | null;
  resolvedCwd: string | null;
}> {
  const runtime = getRuntimeGit();
  if (runtime?.validateWorktreeDirectory) {
    return runtime.validateWorktreeDirectory(directory, worktreeRoot);
  }
  return gitHttp.validateWorktreeDirectory(directory, worktreeRoot);
}

export async function canonicalizeWorktreeState(
  directory: string
): Promise<{
  worktreeRoot: string | null;
  cwd: string | null;
  branch: string | null;
  headState: 'branch' | 'detached' | 'unborn';
  worktreeStatus: 'ready' | 'missing' | 'invalid' | 'not-a-repo';
  legacy: boolean;
  degraded: boolean;
  attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
}> {
  const runtime = getRuntimeGit();
  if (runtime?.canonicalizeWorktreeState) {
    return runtime.canonicalizeWorktreeState(directory);
  }
  return gitHttp.canonicalizeWorktreeState(directory);
}
