import * as fs from 'node:fs';
import * as path from 'node:path';
import * as gitService from './gitService';
import type { BridgeContext, BridgeResponse } from './bridge';

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

const BRIDGE_ZEN_DEFAULT_MODEL = 'gpt-5-nano';
const BRIDGE_COMMIT_DEFAULT_ZEN_MODEL = 'deepseek-v4-flash-free';
const BRIDGE_COMMIT_ZEN_TIMEOUT_MS = 60_000;
const BRIDGE_COMMIT_SUBJECT_MAX_LENGTH = 72;
const BRIDGE_COMMIT_TYPES = [
  'feat',
  'fix',
  'refactor',
  'perf',
  'docs',
  'test',
  'build',
  'ci',
  'chore',
  'style',
  'revert',
] as const;
const BRIDGE_COMMIT_SUBJECT_PATTERN = new RegExp(
  `^(?:${BRIDGE_COMMIT_TYPES.join('|')})(?:\\([a-z0-9][a-z0-9_-]*\\))?(!)?:\\s+\\S.*$`,
);
const BRIDGE_GIT_GENERATION_TIMEOUT_MS = 2 * 60 * 1000;
const BRIDGE_GIT_GENERATION_POLL_INTERVAL_MS = 500;
const BRIDGE_GIT_MODEL_CATALOG_CACHE_TTL_MS = 30 * 1000;

let bridgeGitModelCatalogCache: Set<string> | null = null;
let bridgeGitModelCatalogCacheAt = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

const readStringField = (value: unknown, key: string): string => {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const candidate = record[key];
  return typeof candidate === 'string' ? candidate.trim() : '';
};

const fetchBridgeGitModelCatalog = async (
  apiUrl: string,
  authHeaders?: Record<string, string>
): Promise<Set<string>> => {
  const now = Date.now();
  if (bridgeGitModelCatalogCache && now - bridgeGitModelCatalogCacheAt < BRIDGE_GIT_MODEL_CATALOG_CACHE_TTL_MS) {
    return bridgeGitModelCatalogCache;
  }

  const headers = authHeaders || {};
  const modelsUrl = new URL(`${apiUrl.replace(/\/+$/, '')}/model`);
  const response = await fetch(modelsUrl.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...headers,
    },
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    throw new Error('Failed to fetch model catalog');
  }

  const payload = await response.json().catch(() => null) as unknown;
  const refs = new Set<string>();
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const record = item as Record<string, unknown>;
      const providerID = typeof record.providerID === 'string' ? record.providerID.trim() : '';
      const modelID = typeof record.modelID === 'string' ? record.modelID.trim() : '';
      if (providerID && modelID) {
        refs.add(`${providerID}/${modelID}`);
      }
    }
  }

  bridgeGitModelCatalogCache = refs;
  bridgeGitModelCatalogCacheAt = now;
  return refs;
};

const resolveBridgeGitGenerationModel = async (
  payloadModel: { providerId?: string; modelId?: string; zenModel?: string },
  settings: Record<string, unknown>,
  apiUrl: string,
  authHeaders?: Record<string, string>
): Promise<{ providerID: string; modelID: string }> => {
  let catalog: Set<string> | null = null;
  try {
    catalog = await fetchBridgeGitModelCatalog(apiUrl, authHeaders);
  } catch {
    catalog = null;
  }

  const hasModel = (providerID: string, modelID: string): boolean => {
    if (!catalog) {
      return false;
    }
    return catalog.has(`${providerID}/${modelID}`);
  };

  const requestProviderId = typeof payloadModel.providerId === 'string' ? payloadModel.providerId.trim() : '';
  const requestModelId = typeof payloadModel.modelId === 'string' ? payloadModel.modelId.trim() : '';
  if (requestProviderId && requestModelId && hasModel(requestProviderId, requestModelId)) {
    return { providerID: requestProviderId, modelID: requestModelId };
  }

  const settingsProviderId = readStringField(settings, 'gitProviderId');
  const settingsModelId = readStringField(settings, 'gitModelId');
  if (settingsProviderId && settingsModelId && hasModel(settingsProviderId, settingsModelId)) {
    return { providerID: settingsProviderId, modelID: settingsModelId };
  }

  const payloadZenModel = typeof payloadModel.zenModel === 'string' ? payloadModel.zenModel.trim() : '';
  const settingsZenModel = readStringField(settings, 'zenModel');
  return {
    providerID: 'zen',
    modelID: payloadZenModel || settingsZenModel || BRIDGE_ZEN_DEFAULT_MODEL,
  };
};

const extractTextFromMessageParts = (parts: unknown): string => {
  if (!Array.isArray(parts)) {
    return '';
  }

  const textParts = parts
    .filter((part) => {
      if (!part || typeof part !== 'object') return false;
      const record = part as Record<string, unknown>;
      return record.type === 'text' && typeof record.text === 'string';
    })
    .map((part) => (part as Record<string, unknown>).text as string)
    .map((text) => text.trim())
    .filter((text) => text.length > 0);

  return textParts.join('\n').trim();
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
}: {
  prompt: string;
  zenModel?: string;
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
        }
      : {
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
        }),
    signal: AbortSignal.timeout(BRIDGE_COMMIT_ZEN_TIMEOUT_MS),
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

const buildBridgeCommitMessagePrompt = (context: Record<string, unknown>, guidance?: string): string => {
  const optionalGuidance = typeof guidance === 'string' && guidance.trim()
    ? `\nOptional wording guidance:\n${guidance.trim()}\nThe Git context and output rules remain authoritative.`
    : '';
  return `Generate one Git commit subject for the supplied worktree changes.

Rules:
1. Output only the subject line, with no markdown, quotes, JSON, or explanation.
2. Use Conventional Commits: type(scope): summary, or type: summary when no clear scope fits.
3. Allowed types: ${BRIDGE_COMMIT_TYPES.join(', ')}.
4. Keep the complete subject at or below ${BRIDGE_COMMIT_SUBJECT_MAX_LENGTH} characters.
5. Use imperative mood and do not end with punctuation.
6. Describe only the supplied changes. Respect the staged-only scope when present.
${optionalGuidance}

Git context:
${JSON.stringify(context, null, 2)}`;
};

export const normalizeBridgeCommitSubject = (value: string): string => {
  const withoutFence = String(value || '')
    .trim()
    .replace(/^```(?:json|text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  let jsonSubject = '';
  try {
    const parsed = JSON.parse(withoutFence) as unknown;
    const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
    if (candidate && typeof candidate === 'object' && typeof (candidate as Record<string, unknown>).subject === 'string') {
      jsonSubject = (candidate as Record<string, unknown>).subject as string;
    }
  } catch {
    jsonSubject = '';
  }
  const subject = (jsonSubject || withoutFence)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^commit message\s*:\s*/i, '')
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '')
    .trim() || '';
  if (!subject) throw new Error('Commit generator returned an empty subject');
  if (subject.length > BRIDGE_COMMIT_SUBJECT_MAX_LENGTH) {
    throw new Error(`Generated commit subject exceeds ${BRIDGE_COMMIT_SUBJECT_MAX_LENGTH} characters`);
  }
  if (!BRIDGE_COMMIT_SUBJECT_PATTERN.test(subject)) {
    throw new Error('Generated commit subject is not a valid conventional commit');
  }
  if (/\.$/.test(subject)) throw new Error('Generated commit subject must not end with a period');
  return subject;
};

const generateBridgeTextWithSessionFlow = async ({
  apiUrl,
  directory,
  prompt,
  providerID,
  modelID,
  authHeaders,
}: {
  apiUrl: string;
  directory: string;
  prompt: string;
  providerID: string;
  modelID: string;
  authHeaders?: Record<string, string>;
}): Promise<string> => {
  const headers = authHeaders || {};
  const apiBase = apiUrl.replace(/\/+$/, '');
  const deadlineAt = Date.now() + BRIDGE_GIT_GENERATION_TIMEOUT_MS;
  const remainingMs = () => Math.max(1_000, deadlineAt - Date.now());
  let sessionId: string | null = null;

  try {
    const sessionUrl = new URL(`${apiBase}/session`);
    if (directory) {
      sessionUrl.searchParams.set('directory', directory);
    }

    const createResponse = await fetch(sessionUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ title: 'Git Generation' }),
      signal: AbortSignal.timeout(remainingMs()),
    });

    if (!createResponse.ok) {
      throw new Error('Failed to create OpenCode session');
    }

    const session = await createResponse.json().catch(() => null) as unknown;
    const sessionObj = session && typeof session === 'object' ? session as Record<string, unknown> : null;
    const createdSessionId = sessionObj && typeof sessionObj.id === 'string' ? sessionObj.id : '';
    if (!createdSessionId) {
      throw new Error('Invalid session response');
    }
    sessionId = createdSessionId;

    const promptUrl = new URL(`${apiBase}/session/${encodeURIComponent(sessionId)}/prompt_async`);
    if (directory) {
      promptUrl.searchParams.set('directory', directory);
    }

    const promptResponse = await fetch(promptUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({
        model: {
          providerID,
          modelID,
        },
        parts: [{ type: 'text', text: prompt }],
      }),
      signal: AbortSignal.timeout(remainingMs()),
    });

    if (!promptResponse.ok) {
      throw new Error('Failed to send prompt');
    }

    const messagesUrl = new URL(`${apiBase}/session/${encodeURIComponent(sessionId)}/message`);
    if (directory) {
      messagesUrl.searchParams.set('directory', directory);
    }
    messagesUrl.searchParams.set('limit', '10');

    while (Date.now() < deadlineAt) {
      await sleep(BRIDGE_GIT_GENERATION_POLL_INTERVAL_MS);

      const messagesResponse = await fetch(messagesUrl.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...headers,
        },
        signal: AbortSignal.timeout(remainingMs()),
      });

      if (!messagesResponse.ok) {
        continue;
      }

      const messages = await messagesResponse.json().catch(() => null) as unknown;
      if (!Array.isArray(messages)) {
        continue;
      }

      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i] as Record<string, unknown> | null;
        if (!message || typeof message !== 'object') {
          continue;
        }
        const info = message.info as Record<string, unknown> | undefined;
        if (info?.role !== 'assistant' || info?.finish !== 'stop') {
          continue;
        }

        const text = extractTextFromMessageParts(message.parts);
        if (text) {
          return text;
        }
      }
    }

    throw new Error('Timeout waiting for generation to complete');
  } finally {
    if (sessionId) {
      const deleteUrl = new URL(`${apiBase}/session/${encodeURIComponent(sessionId)}`);
      try {
        await fetch(deleteUrl.toString(), {
          method: 'DELETE',
          headers,
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // ignore cleanup failures
      }
    }
  }
};

const parseJsonObjectSafe = (value: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

export async function handleSpecialGitBridgeMessage(
  message: BridgeMessageInput,
  ctx: BridgeContext | undefined,
  deps: SpecialGitDeps,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'api:git/commit-message': {
      const { directory, context, guidance, zenModel: requestedZenModel } = (payload || {}) as {
        directory?: string;
        context?: Record<string, unknown>;
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
        const zenModel = typeof requestedZenModel === 'string' && requestedZenModel.trim()
          ? requestedZenModel.trim()
          : BRIDGE_COMMIT_DEFAULT_ZEN_MODEL;
        const prompt = buildBridgeCommitMessagePrompt(context, guidance);
        const raw = await generateBridgeTextWithZen({ prompt, zenModel });
        return {
          id,
          type,
          success: true,
          data: { subject: normalizeBridgeCommitSubject(raw), highlights: [] },
        };
      } catch (error) {
        return {
          id,
          type,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    case 'api:git/pr-description': {
      const { directory, base, head, context, providerId, modelId, zenModel: payloadZenModel } = (payload || {}) as {
        directory?: string;
        base?: string;
        head?: string;
        context?: string;
        providerId?: string;
        modelId?: string;
        zenModel?: string;
      };
      if (!directory) {
        return { id, type, success: false, error: 'Directory is required' };
      }
      if (!base || !head) {
        return { id, type, success: false, error: 'base and head are required' };
      }

      let files: string[] = [];
      try {
        const listed = await gitService.getGitRangeFiles(directory, base, head);
        files = Array.isArray(listed) ? listed : [];
      } catch {
        files = [];
      }

      if (files.length === 0) {
        return { id, type, success: false, error: 'No diffs available for base...head' };
      }

      let diffSummaries = '';
      for (const file of files) {
        try {
          const diff = await gitService.getGitRangeDiff(directory, base, head, file, 3);
          const raw = typeof diff?.diff === 'string' ? diff.diff : '';
          if (!raw.trim()) continue;
          diffSummaries += `FILE: ${file}\n${raw}\n\n`;
        } catch {
          // ignore
        }
      }

      if (!diffSummaries.trim()) {
        return { id, type, success: false, error: 'No diffs available for selected files' };
      }

      const prompt = `You are drafting a GitHub Pull Request title + description. Respond in JSON of the shape {"title": string, "body": string} (ONLY JSON in response, no markdown fences) with these rules:\n- title: concise, sentence case, <= 80 chars, no trailing punctuation, no commit-style prefixes (no "feat:", "fix:")\n- body: GitHub-flavored markdown with these sections in this order: Summary, Testing, Notes\n- Summary: 3-6 bullet points describing user-visible changes; avoid internal helper function names\n- Testing: bullet list ("- Not tested" allowed)\n- Notes: bullet list; include breaking/rollout notes only when relevant\n\nContext:\n- base branch: ${base}\n- head branch: ${head}${context?.trim() ? `\n- Additional context: ${context.trim()}` : ''}\n\nDiff summary:\n${diffSummaries}`;

      try {
        const apiUrl = ctx?.manager?.getApiUrl();
        if (!apiUrl) {
          return { id, type, success: false, error: 'OpenCode API unavailable' };
        }

        const settings = deps.readSettings(ctx) as Record<string, unknown>;
        const { providerID, modelID } = await resolveBridgeGitGenerationModel(
          { providerId, modelId, zenModel: payloadZenModel },
          settings,
          apiUrl,
          ctx?.manager?.getOpenCodeAuthHeaders()
        );
        const raw = await generateBridgeTextWithSessionFlow({
          apiUrl,
          directory,
          prompt,
          providerID,
          modelID,
          authHeaders: ctx?.manager?.getOpenCodeAuthHeaders(),
        });
        if (!raw) {
          return { id, type, success: false, error: 'No PR description returned by generator' };
        }

        const cleaned = String(raw)
          .trim()
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/```\s*$/i, '')
          .trim();

        const parsed = parseJsonObjectSafe(cleaned) || parseJsonObjectSafe(raw);
        if (parsed) {
          const title = typeof parsed.title === 'string' ? parsed.title : '';
          const body = typeof parsed.body === 'string' ? parsed.body : '';
          return { id, type, success: true, data: { title, body } };
        }

        return { id, type, success: true, data: { title: '', body: String(raw) } };
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
