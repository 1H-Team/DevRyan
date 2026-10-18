// DevRyan: the secondary model runs through the invocation owner's
// `secondary` call (provider authority stays in the host), so these tests
// replace upstream's temporary-session and generateText pipeline tests.
import { describe, expect, mock, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import {
  type ReviewedWebfetchOwners,
  withReviewedWebfetchOwner,
} from '../../devryan/owners';
import { createReviewedWebfetchCache } from './cache';
import { MAX_MODEL_CONTENT_CHARS } from './constants';
import { runSecondaryModelWithFallback } from './secondary-model';
import type { SecondaryModel } from './types';

type Secondary = ReviewedWebfetchOwners['secondary'];
// The owner-routed path never reads the plugin input.
const input = {} as PluginInput;
const models: SecondaryModel[] = [
  { providerID: 'provider', modelID: 'first' },
  { providerID: 'provider', modelID: 'second', variant: 'low' },
];

function withOwner<T>(
  secondary: ReviewedWebfetchOwners['secondary'],
  action: () => Promise<T>,
  signal = new AbortController().signal,
): Promise<T> {
  return withReviewedWebfetchOwner(
    {
      sessionID: 'parent',
      signal,
      cache: createReviewedWebfetchCache(),
      fetch: () => Promise.reject(new Error('unused')),
      loadJSDOM: () => Promise.reject(new Error('unused')),
      saveBinary: () => Promise.reject(new Error('unused')),
      secondary,
    },
    action,
  );
}

describe('smartfetch/secondary-model (owner-routed)', () => {
  test('falls back when the first model returns empty text or throws', async () => {
    const secondary = mock<Secondary>(async ({ model }) => {
      if (model.modelID === 'first') return '  ';
      return ' Final answer ';
    });
    const result = await withOwner(secondary, () =>
      runSecondaryModelWithFallback(input, models, 'Task', 'Content', 'parent'),
    );
    expect(result.text).toBe('Final answer');
    expect(result.model).toEqual(models[1]);
    expect(secondary).toHaveBeenCalledTimes(2);

    const throwing = mock<Secondary>(async ({ model }) => {
      if (model.modelID === 'first') throw new Error('provider down');
      return 'Recovered';
    });
    const recovered = await withOwner(throwing, () =>
      runSecondaryModelWithFallback(input, models, 'Task', 'Content', 'parent'),
    );
    expect(recovered.text).toBe('Recovered');
  });

  test('passes the parent session, model and embedded content to the owner', async () => {
    const secondary = mock<Secondary>(async () => 'ok');
    await withOwner(secondary, () =>
      runSecondaryModelWithFallback(
        input,
        [models[1]],
        'Extract X',
        'Body',
        'parent',
      ),
    );
    const [call] = secondary.mock.calls[0] ?? [];
    if (!call) throw new Error('secondary not called');
    expect(call.sessionID).toBe('parent');
    expect(call.model).toEqual(models[1]);
    expect(call.prompt).toContain('Fetched content:\n---\nBody\n---');
    expect(call.prompt).toContain('Task:\nExtract X');
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  test('truncates long content and appends the note', async () => {
    const secondary = mock<Secondary>(async () => 'ok');
    const content = 'x'.repeat(MAX_MODEL_CONTENT_CHARS + 10);
    const result = await withOwner(secondary, () =>
      runSecondaryModelWithFallback(input, [models[0]], 'Task', content, 'parent'),
    );
    expect(result.inputTruncated).toBe(true);
    expect(result.inputChars).toBe(MAX_MODEL_CONTENT_CHARS);
    expect(result.sourceChars).toBe(MAX_MODEL_CONTENT_CHARS + 10);
    const prompt = secondary.mock.calls[0]?.[0]?.prompt;
    expect(prompt).toContain(
      `only the first ${MAX_MODEL_CONTENT_CHARS} characters of a longer fetched document were provided`,
    );
  });

  test('refuses a parent session other than the owner session', async () => {
    const secondary = mock<Secondary>(async () => 'ok');
    await expect(
      withOwner(secondary, () =>
        runSecondaryModelWithFallback(input, [models[0]], 'Task', 'C', 'other'),
      ),
    ).rejects.toThrow('reviewed_webfetch_session_mismatch');
    expect(secondary).not.toHaveBeenCalled();
  });

  test('reports the last failure when every model fails', async () => {
    const secondary = mock<Secondary>(async ({ model }) => {
      throw new Error(`failed ${model.modelID}`);
    });
    await expect(
      withOwner(secondary, () =>
        runSecondaryModelWithFallback(input, models, 'Task', 'C', 'parent'),
      ),
    ).rejects.toThrow('failed second');
  });
});
