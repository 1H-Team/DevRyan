import { parse as parseJsonc, stripComments, type ParseError } from 'jsonc-parser';

export const INVALID_JSONC_CODE = 'INVALID_JSONC' as const;

export type JsoncConfigDiagnostic = Pick<ParseError, 'error' | 'offset' | 'length'> | {
  error: 'ROOT_NOT_OBJECT';
  offset: number;
  length: number;
};

const fileIdentity = (value: string): string => {
  if (!value.trim()) return 'configuration';
  const normalized = value.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || 'configuration';
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const formatDiagnostics = (diagnostics: readonly JsoncConfigDiagnostic[]): string => diagnostics
  .map((diagnostic) => `${diagnostic.error}@${diagnostic.offset}:${diagnostic.length}`)
  .join(',');

export class InvalidJsoncError extends Error {
  readonly code = INVALID_JSONC_CODE;
  readonly file: string;
  readonly diagnostics: JsoncConfigDiagnostic[];

  constructor(file: string, diagnostics: readonly JsoncConfigDiagnostic[]) {
    const identity = fileIdentity(file);
    super(`Invalid JSONC configuration "${identity}" (${formatDiagnostics(diagnostics)})`);
    this.name = 'InvalidJsoncError';
    this.file = identity;
    this.diagnostics = diagnostics.map((diagnostic) => ({ ...diagnostic }));
  }
}

export const isInvalidJsoncError = (error: unknown): error is InvalidJsoncError => (
  error !== null
  && typeof error === 'object'
  && 'code' in error
  && error.code === INVALID_JSONC_CODE
);

export const parseConfigJsonc = (
  content: string,
  file = 'configuration',
): Record<string, unknown> => {
  const uncommented = stripComments(content);
  if (!uncommented.trim()) return {};

  const diagnostics: ParseError[] = [];
  const parsed = parseJsonc(content, diagnostics, { allowTrailingComma: true }) as unknown;
  if (diagnostics.length > 0) {
    throw new InvalidJsoncError(file, diagnostics);
  }

  if (!isPlainObject(parsed)) {
    const offset = content.search(/\S/);
    throw new InvalidJsoncError(file, [{
      error: 'ROOT_NOT_OBJECT',
      offset: Math.max(0, offset),
      length: Math.max(1, content.trim().length),
    }]);
  }

  return parsed;
};
