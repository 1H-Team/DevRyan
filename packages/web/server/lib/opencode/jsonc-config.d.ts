export const INVALID_JSONC_CODE: 'INVALID_JSONC';

export interface JsoncConfigDiagnostic {
  error: number | 'ROOT_NOT_OBJECT';
  offset: number;
  length: number;
}

export class InvalidJsoncError extends Error {
  readonly code: 'INVALID_JSONC';
  readonly file: string;
  readonly diagnostics: JsoncConfigDiagnostic[];
}

export function isInvalidJsoncError(error: unknown): error is InvalidJsoncError;
export function parseConfigJsonc(content: string, file?: string): Record<string, unknown>;
