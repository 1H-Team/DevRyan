import { describe, expect, test } from 'bun:test';

import type { QuestionInfo } from '@/types/question';
import {
  initialQuestionInputText,
  questionEntryError,
  questionInputType,
  questionLink,
  validateQuestionInput,
  validateQuestionSelection,
} from './questionCardInputs';

const base: QuestionInfo = { question: 'Q', header: 'Q', options: [] };
const state = (text: string, selectedOptions: string[] = []) => ({ isCustom: false, customText: undefined, selectedOptions, text });

describe('typed question input validation', () => {
  test('numbers honour kind, minimum and maximum', () => {
    const integer = { kind: 'integer' as const, minimum: 1, maximum: 5 };
    expect(validateQuestionInput(integer, '3', true)).toBeNull();
    expect(validateQuestionInput(integer, ' 5 ', true)).toBeNull();
    expect(validateQuestionInput(integer, '0', true)).toEqual({ code: 'minimum', limit: 1 });
    expect(validateQuestionInput(integer, '6', true)).toEqual({ code: 'maximum', limit: 5 });
    expect(validateQuestionInput(integer, '2.5', true)).toEqual({ code: 'integer' });
    expect(validateQuestionInput(integer, 'abc', true)).toEqual({ code: 'number' });
    expect(validateQuestionInput({ kind: 'number', maximum: 1 }, '0.5', true)).toBeNull();
    expect(validateQuestionInput({ kind: 'number' }, 'Infinity', true)).toEqual({ code: 'number' });
  });

  test('required and optional empty answers', () => {
    expect(validateQuestionInput({ kind: 'text' }, '   ', true)).toEqual({ code: 'required' });
    expect(validateQuestionInput({ kind: 'number', minimum: 3 }, '', false)).toBeNull();
  });

  test('string formats, lengths and patterns', () => {
    expect(validateQuestionInput({ kind: 'email' }, 'a@b.co', true)).toBeNull();
    expect(validateQuestionInput({ kind: 'email' }, 'not-an-email', true)).toEqual({ code: 'email' });
    expect(validateQuestionInput({ kind: 'uri' }, 'https://example.com/x', true)).toBeNull();
    expect(validateQuestionInput({ kind: 'uri' }, 'example', true)).toEqual({ code: 'uri' });
    expect(validateQuestionInput({ kind: 'date' }, '2026-02-28', true)).toBeNull();
    expect(validateQuestionInput({ kind: 'date' }, '2026-02-30', true)).toEqual({ code: 'date' });
    expect(validateQuestionInput({ kind: 'date-time' }, '2026-02-28T10:30', true)).toBeNull();
    expect(validateQuestionInput({ kind: 'date-time' }, 'soon', true)).toEqual({ code: 'dateTime' });
    expect(validateQuestionInput({ kind: 'text', minLength: 3 }, 'ab', true)).toEqual({ code: 'minLength', limit: 3 });
    expect(validateQuestionInput({ kind: 'text', maxLength: 2 }, 'abc', true)).toEqual({ code: 'maxLength', limit: 2 });
    expect(validateQuestionInput({ kind: 'text', pattern: '^[a-z]+$' }, 'abc', true)).toBeNull();
    expect(validateQuestionInput({ kind: 'text', pattern: '^[a-z]+$' }, 'ABC', true)).toEqual({ code: 'pattern' });
    expect(validateQuestionInput({ kind: 'text', pattern: '(' }, 'x', true)).toEqual({ code: 'pattern' });
  });

  test('maps kinds to native input types and prefills defaults', () => {
    expect(['text', 'number', 'integer', 'email', 'uri', 'date', 'date-time'].map((kind) => questionInputType(kind as never)))
      .toEqual(['text', 'number', 'number', 'email', 'url', 'date', 'datetime-local']);
    expect(initialQuestionInputText({ kind: 'integer', default: 2 })).toBe('2');
    expect(initialQuestionInputText({ kind: 'text' })).toBe('');
    expect(initialQuestionInputText(undefined)).toBe('');
  });

  test('selection bounds of a multiselect', () => {
    const question = { ...base, multiple: true, minItems: 1, maxItems: 2 };
    expect(validateQuestionSelection(question, 0)).toEqual({ code: 'required' });
    expect(validateQuestionSelection({ ...question, required: false, minItems: undefined }, 0)).toBeNull();
    expect(validateQuestionSelection(question, 3)).toEqual({ code: 'maxItems', limit: 2 });
    expect(validateQuestionSelection({ ...question, minItems: 2 }, 1)).toEqual({ code: 'minItems', limit: 2 });
  });
});

describe('link questions', () => {
  test('accept http(s) only and emphasise the parsed host', () => {
    expect(questionLink('https://linear.app/oauth?x=1')).toEqual({ href: 'https://linear.app/oauth?x=1', host: 'linear.app' });
    expect(questionLink('http://127.0.0.1:3000/cb')?.host).toBe('127.0.0.1:3000');
    expect(questionLink('https://bücher.example/')?.host).toBe('xn--bcher-kva.example');
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'https://user:pw@example.com/', 'relative']) {
      expect(questionLink(url)).toBeNull();
    }
  });

  test('a link answer needs the confirmation and a safe URL', () => {
    const link = { ...base, required: true, external: { url: 'https://linear.app/oauth' } };
    expect(questionEntryError(link, state(''))).toEqual({ code: 'required' });
    expect(questionEntryError(link, state('', ['Completed']))).toBeNull();
    expect(questionEntryError({ ...link, external: { url: 'javascript:alert(1)' } }, state('', ['Completed']))).toEqual({ code: 'required' });
  });

  test('question-tool questions stay required while optional form fields may be empty', () => {
    expect(questionEntryError(base, state(''))).toEqual({ code: 'required' });
    expect(questionEntryError({ ...base, required: false }, state(''))).toBeNull();
    expect(questionEntryError({ ...base, input: { kind: 'integer', minimum: 1 }, required: false }, state('0'))).toEqual({ code: 'minimum', limit: 1 });
  });
});
