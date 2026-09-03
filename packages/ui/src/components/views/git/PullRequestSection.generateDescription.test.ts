import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { dict } from '@/lib/i18n/messages/en';

const source = readFileSync(
  fileURLToPath(new URL('./PullRequestSection.tsx', import.meta.url)),
  'utf8',
);

describe('PullRequestSection PR description generation', () => {
  test('names the cause of a failed generation per error code', () => {
    for (const [code, key] of [
      ['FREE_ZEN_EXHAUSTED', 'gitView.pr.toast.generateDescriptionCause.exhausted'],
      ['NO_FREE_MODELS', 'gitView.pr.toast.generateDescriptionCause.noFreeModels'],
      ['CATALOG_UNAVAILABLE', 'gitView.pr.toast.generateDescriptionCause.catalogUnavailable'],
      ['SESSION_MODEL_FAILED', 'gitView.pr.toast.generateDescriptionCause.sessionModelFailed'],
      ['TIMEOUT', 'gitView.pr.toast.generateDescriptionCause.timeout'],
    ] as const) {
      expect(source).toContain(`${code}: '${key}'`);
      expect(dict[key]).toBeTruthy();
    }
    expect(source).toContain('const code = readGenerationErrorCode(e);');
    expect(source).toContain('description: causeKey ? `${t(causeKey)} ${message}` : message,');
  });

  test('offers a Retry action that re-runs the generation', () => {
    expect(source).toContain("label: t('gitView.pr.toast.generateDescriptionRetry'),");
    expect(source).toContain('void generateDescriptionRef.current();');
    expect(source).toContain('generateDescriptionRef.current = generateDescription;');
    expect(dict['gitView.pr.toast.generateDescriptionRetry']).toBe('Retry');
  });

  test('never leaves one field stale next to a fresh one', () => {
    expect(source).toContain('setTitle(nextTitle);\n      setBody(nextBody);');
    expect(source).toContain("toast.warning(t('gitView.pr.toast.generateDescriptionPartial'), {");
    expect(source).toContain("? 'gitView.pr.toast.generateDescriptionPartialBody'");
    expect(source).toContain(": 'gitView.pr.toast.generateDescriptionPartialTitle'),");
    expect(source).toContain("throw new Error('The model returned an empty pull request description');");
  });
});
