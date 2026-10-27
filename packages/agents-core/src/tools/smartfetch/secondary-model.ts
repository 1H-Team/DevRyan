import { requireReviewedWebfetchOwner } from '../../devryan/owners';
import { MAX_MODEL_CONTENT_CHARS } from './constants';
import { runWithScopedTimeout } from './network';
import type { CachedFetch, SecondaryModel } from './types';

interface SecondaryModelResolutionInput {
  /** Dedicated webfetch model(s) from the plugin config (highest priority). */
  webfetchModels?: ReadonlyArray<{ id: string; variant?: string }>;
  /** `small_model` from the host's already-loaded merged OpenCode config. */
  smallModel?: string;
  /** Explorer agent model id, resolved from in-memory config at construction. */
  explorerModel?: string;
  /** Librarian agent model id, resolved from in-memory config at construction. */
  librarianModel?: string;
}

function parseModelRef(value: string | undefined) {
  if (!value) return undefined;
  const [providerID, ...rest] = value.split('/');
  const modelID = rest.join('/');
  if (!providerID || !modelID) return undefined;
  return { providerID, modelID };
}

export function pickAgentModelRef(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') return entry;
      if (
        entry &&
        typeof entry === 'object' &&
        'id' in entry &&
        typeof (entry as { id?: unknown }).id === 'string'
      ) {
        return (entry as { id: string }).id;
      }
    }
  }
  return undefined;
}

/**
 * Resolve the secondary-model chain purely from in-memory inputs.
 *
 * No filesystem or config-file access: every value is captured once at
 * plugin construction (`src/index.ts`) from the already-loaded plugin config
 * and the host's merged OpenCode config. Keeps the webfetch hot path free of
 * disk reads.
 */
export function resolveSecondaryModels(
  input: SecondaryModelResolutionInput = {},
): SecondaryModel[] {
  const models: SecondaryModel[] = [];
  const seen = new Set<string>();
  const refs: Array<{ id: string | undefined; variant?: string }> = [
    ...(input.webfetchModels ?? []),
    ...[input.smallModel, input.explorerModel, input.librarianModel].map(
      (id) => ({ id }),
    ),
  ];
  for (const ref of refs) {
    const parsed = parseModelRef(ref.id);
    if (!parsed) continue;
    const model: SecondaryModel =
      'variant' in ref ? { ...parsed, variant: ref.variant } : parsed;
    const key = `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(model);
  }
  return models;
}

function buildPrompt(content: string, prompt: string) {
  return [
    'Use only the fetched content below.',
    'Do not use tools, outside knowledge, or unstated assumptions.',
    'Answer concisely and directly.',
    'If the requested information is missing from the content, say that clearly.',
    'Preserve code examples or exact values only when they are relevant to the task.',
    '',
    'Fetched content:',
    '---',
    content,
    '---',
    '',
    'Task:',
    prompt,
  ].join('\n');
}

function prepareInput(content: string, prompt: string) {
  const sourceChars = content.length;
  const truncatedContent = content.slice(0, MAX_MODEL_CONTENT_CHARS);
  const inputChars = truncatedContent.length;
  const inputTruncated = inputChars < sourceChars;
  const effectivePrompt = inputTruncated
    ? `${prompt}\n\nNote: only the first ${inputChars} characters of a longer fetched document were provided.`
    : prompt;
  return {
    truncatedContent,
    effectivePrompt,
    inputTruncated,
    inputChars,
    sourceChars,
  };
}

export function decideSecondaryModelUse(
  fetchResult: CachedFetch,
  prompt: string | undefined,
  secondaryModels: SecondaryModel[],
) {
  if (!prompt?.trim()) return { use: false, reason: 'no_prompt' as const };
  if (!secondaryModels.length) {
    return {
      use: false,
      reason: 'no_secondary_model_configured' as const,
    };
  }
  if (!fetchResult.markdown.trim()) {
    return { use: false, reason: 'empty_content' as const };
  }
  if (fetchResult.wordCount > 0 && fetchResult.wordCount < 25) {
    return { use: false, reason: 'content_too_short' as const };
  }
  return { use: true, reason: 'prompt_present' as const };
}

const SECONDARY_MODEL_TIMEOUT_MS = 30_000;

/**
 * DevRyan: the secondary model runs through the invocation owner, which owns
 * provider authority and must abort and settle its work before returning
 * after cancellation. No temporary session is created by this module.
 */
async function runSecondaryModel(
  _input: object,
  model: SecondaryModel,
  prompt: string,
  content: string,
  parentSessionID?: string,
) {
  const owner = requireReviewedWebfetchOwner();
  if (parentSessionID !== owner.sessionID)
    throw new Error('reviewed_webfetch_session_mismatch');
  const { truncatedContent, effectivePrompt, ...inputStats } = prepareInput(
    content,
    prompt,
  );
  const text = await runWithScopedTimeout(
    owner.signal,
    SECONDARY_MODEL_TIMEOUT_MS,
    (signal) =>
      owner.secondary({
        sessionID: parentSessionID,
        model,
        prompt: buildPrompt(truncatedContent, effectivePrompt),
        signal,
      }),
  );
  return { text: text.trim(), ...inputStats };
}

export async function runSecondaryModelWithFallback(
  input: object,
  models: SecondaryModel[],
  prompt: string,
  content: string,
  parentSessionID?: string,
) {
  let lastError: unknown;
  for (const model of models) {
    try {
      const result = await runSecondaryModel(
        input,
        model,
        prompt,
        content,
        parentSessionID,
      );
      if (
        !result.text.trim() ||
        /^no response from secondary model\.?$/i.test(result.text.trim())
      ) {
        lastError = new Error('Secondary model returned no usable text');
        continue;
      }
      return { ...result, model };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? 'Secondary model failed'));
}
