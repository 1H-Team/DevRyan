import { parse as parseJsonc, stripComments } from 'jsonc-parser';

const INVALID_JSONC_CODE = 'INVALID_JSONC';

const fileIdentity = (value) => {
  if (typeof value !== 'string' || !value.trim()) return 'configuration';
  const normalized = value.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || 'configuration';
};

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const formatDiagnostics = (diagnostics) => diagnostics
  .map((diagnostic) => `${diagnostic.error}@${diagnostic.offset}:${diagnostic.length}`)
  .join(',');

export class InvalidJsoncError extends Error {
  constructor(file, diagnostics) {
    const identity = fileIdentity(file);
    super(`Invalid JSONC configuration "${identity}" (${formatDiagnostics(diagnostics)})`);
    this.name = 'InvalidJsoncError';
    this.code = INVALID_JSONC_CODE;
    this.file = identity;
    this.diagnostics = diagnostics.map((diagnostic) => ({ ...diagnostic }));
  }
}

export const isInvalidJsoncError = (error) => (
  Boolean(error)
  && typeof error === 'object'
  && error.code === INVALID_JSONC_CODE
);

export const parseConfigJsonc = (content, file = 'configuration') => {
  const source = typeof content === 'string' ? content : String(content ?? '');
  const uncommented = stripComments(source);
  if (!uncommented.trim()) return {};

  const diagnostics = [];
  const parsed = parseJsonc(source, diagnostics, { allowTrailingComma: true });
  if (diagnostics.length > 0) {
    throw new InvalidJsoncError(file, diagnostics);
  }

  if (!isPlainObject(parsed)) {
    const offset = source.search(/\S/);
    throw new InvalidJsoncError(file, [{
      error: 'ROOT_NOT_OBJECT',
      offset: Math.max(0, offset),
      length: Math.max(1, source.trim().length),
    }]);
  }

  return parsed;
};

export { INVALID_JSONC_CODE };
