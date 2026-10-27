import type { QuestionInfo, QuestionInputHint, QuestionInputKind } from '@/types/question';
import { isQuestionAnswerComplete, type QuestionNavigationAnswer } from './questionCardNavigation';

/** Why a typed answer cannot be submitted yet; `limit` feeds the message. */
export type QuestionInputError =
  | { code: 'required' | 'number' | 'integer' | 'pattern' | 'email' | 'uri' | 'date' | 'dateTime' }
  | { code: 'minimum' | 'maximum' | 'minLength' | 'maxLength' | 'minItems' | 'maxItems'; limit: number };

/** The confirmation answer of a link question (any non-empty answer acknowledges it). */
export const QUESTION_LINK_COMPLETED = 'Completed';

const INPUT_TYPES: Record<QuestionInputKind, 'text' | 'number' | 'email' | 'url' | 'date' | 'datetime-local'> = {
  text: 'text', number: 'number', integer: 'number', email: 'email', uri: 'url', date: 'date', 'date-time': 'datetime-local',
};

export const questionInputType = (kind: QuestionInputKind) => INPUT_TYPES[kind] ?? 'text';

/** The prefilled text of a typed field: its declared default, else empty. */
export const initialQuestionInputText = (input: QuestionInputHint | undefined): string => (
  input?.default === undefined ? '' : String(input.default)
);

/** Optional only when the form says so; question-tool questions stay required. */
export const isQuestionRequired = (question: QuestionInfo): boolean => question.required !== false;

const isDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const isUri = (value: string): boolean => {
  try {
    return Boolean(new URL(value));
  } catch {
    return false;
  }
};

/** Mirrors OpenCode's own form validation so a submit never round-trips to fail. */
export function validateQuestionInput(input: QuestionInputHint, text: string, required: boolean): QuestionInputError | null {
  const value = text.trim();
  if (!value) return required ? { code: 'required' } : null;
  if (input.kind === 'number' || input.kind === 'integer') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return { code: 'number' };
    if (input.kind === 'integer' && !Number.isSafeInteger(parsed)) return { code: 'integer' };
    if (input.minimum !== undefined && parsed < input.minimum) return { code: 'minimum', limit: input.minimum };
    if (input.maximum !== undefined && parsed > input.maximum) return { code: 'maximum', limit: input.maximum };
    return null;
  }
  if (input.minLength !== undefined && value.length < input.minLength) return { code: 'minLength', limit: input.minLength };
  if (input.maxLength !== undefined && value.length > input.maxLength) return { code: 'maxLength', limit: input.maxLength };
  if (input.pattern !== undefined) {
    try {
      if (!new RegExp(input.pattern).test(value)) return { code: 'pattern' };
    } catch {
      return { code: 'pattern' };
    }
  }
  if (input.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { code: 'email' };
  if (input.kind === 'uri' && !isUri(value)) return { code: 'uri' };
  if (input.kind === 'date' && !isDate(value)) return { code: 'date' };
  if (input.kind === 'date-time' && Number.isNaN(new Date(value).getTime())) return { code: 'dateTime' };
  return null;
}

/** Selection bounds of a multiselect question; a custom answer counts as one. */
export function validateQuestionSelection(question: QuestionInfo, count: number): QuestionInputError | null {
  if (count === 0) return isQuestionRequired(question) ? { code: 'required' } : null;
  if (question.minItems !== undefined && count < question.minItems) return { code: 'minItems', limit: question.minItems };
  if (question.maxItems !== undefined && count > question.maxItems) return { code: 'maxItems', limit: question.maxItems };
  return null;
}

/**
 * An http(s) link safe to show: credentials and every other scheme are
 * refused. `host` is the URL parser's (punycode) host, shown emphasised.
 */
export function questionLink(url: string): { href: string; host: string } | null {
  try {
    const parsed = new URL(url);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) return null;
    return { href: parsed.toString(), host: parsed.host };
  } catch {
    return null;
  }
}

/** The answer state a question card keeps per question. */
export type QuestionEntryState = QuestionNavigationAnswer & { text: string };

/** The first reason this question's answer cannot be submitted, or `null`. */
export function questionEntryError(question: QuestionInfo, state: QuestionEntryState): QuestionInputError | null {
  if (question.external) {
    return questionLink(question.external.url) && (state.selectedOptions?.length ?? 0) > 0 ? null : { code: 'required' };
  }
  if (question.input) return validateQuestionInput(question.input, state.text, isQuestionRequired(question));
  if (question.multiple && (question.minItems !== undefined || question.maxItems !== undefined)) {
    const count = state.isCustom ? (state.customText?.trim() ? 1 : 0) : state.selectedOptions?.length ?? 0;
    return validateQuestionSelection(question, count);
  }
  if (isQuestionAnswerComplete(state)) return null;
  return isQuestionRequired(question) ? { code: 'required' } : null;
}
