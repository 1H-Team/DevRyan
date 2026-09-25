import { applyEdits, modify, parse as parseJsonc, stripComments } from 'jsonc-parser';

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

const getAtKeyPath = (root, keyPath) => keyPath.reduce(
  (value, key) => (isPlainObject(value) ? value[key] : undefined),
  root,
);

// Key paths that remove `keys` from the object at `parentPath`. A parent that
// would be left empty is removed instead, up to (never including) the root.
export const collapseRemovalKeyPaths = (root, parentPath, keys) => {
  const parent = getAtKeyPath(root, parentPath);
  if (!isPlainObject(parent)) return [];
  const present = keys.filter((key) => Object.prototype.hasOwnProperty.call(parent, key));
  if (present.length === 0) return [];
  const remaining = Object.keys(parent).filter((key) => !present.includes(key));
  if (remaining.length === 0 && parentPath.length > 0) {
    return collapseRemovalKeyPaths(root, parentPath.slice(0, -1), [parentPath.at(-1)]);
  }
  return present.map((key) => [...parentPath, key]);
};

// Pure: returns a copy of `config` without the given key paths.
export const removeKeyPathsFromObject = (config, keyPaths) => {
  const next = structuredClone(config);
  for (const keyPath of keyPaths) {
    const parent = getAtKeyPath(next, keyPath.slice(0, -1));
    if (isPlainObject(parent)) delete parent[keyPath.at(-1)];
  }
  return next;
};

// Removes key paths from JSON/JSONC text in place, keeping comments and the
// formatting of everything that is not removed.
export const removeJsoncKeyPaths = (source, keyPaths) => {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return keyPaths.reduce((text, keyPath) => applyEdits(
    text,
    modify(text, keyPath, undefined, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } }),
  ), source);
};

export { INVALID_JSONC_CODE };
