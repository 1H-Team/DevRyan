// ---------------------------------------------------------------------------
// Gen-2 location translation per operation (DESIGN.md C.1).
//
// Each 2.0.20 route declares how it is scoped (`routes.generated.js` `location`):
//   header           `x-opencode-directory: encodeURIComponent(dir)`. A missing
//                    directory fails closed with `opencode_location_required`:
//                    2.0.20 would otherwise fall back to its process cwd ([http M3], F9).
//   session          nothing; the session id scopes the request.
//   query-directory  `?directory=` when given (session.list), otherwise unscoped.
//   body-location    `location: {directory}` in the JSON body (session.create);
//                    fails closed like `header`.
//   none             nothing.
// DevRyan host routes (`/devryan/*`) use `query-directory` or `none` and may
// require the directory themselves.
//
// Directories must be absolute and free of `..` and control characters; the
// translation never resolves symlinks (the route policy's root binding, when
// configured, checks containment).
// ---------------------------------------------------------------------------

import path from 'node:path';

import { createOpenCodeClientError, OPENCODE_CLIENT_ERROR_CODES } from './errors.js';

export const OPENCODE_LOCATION_HEADER = 'x-opencode-directory';

export const LOCATION_MODES = Object.freeze(['header', 'session', 'query-directory', 'body-location', 'none']);

const hasControlCharacter = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/**
 * The trimmed directory, `null` when absent, or an error for an unusable value.
 * @param {unknown} directory
 * @param {string} operation
 * @returns {string | null}
 */
export const normalizeLocationDirectory = (directory, operation) => {
  if (directory === undefined || directory === null) return null;
  if (typeof directory !== 'string') {
    throw createOpenCodeClientError(OPENCODE_CLIENT_ERROR_CODES.locationInvalid, 400,
      `${operation}: the directory must be a string`, { operation, generation: 2 });
  }
  const trimmed = directory.trim();
  if (trimmed.length === 0) return null;
  if (!path.isAbsolute(trimmed) || hasControlCharacter(trimmed)
    || trimmed.split(/[\\/]+/).some((segment) => segment === '..')) {
    throw createOpenCodeClientError(OPENCODE_CLIENT_ERROR_CODES.locationInvalid, 400,
      `${operation}: the directory must be an absolute path without '..'`, { operation, generation: 2 });
  }
  return trimmed;
};

const locationRequired = (operation, mode) => createOpenCodeClientError(
  OPENCODE_CLIENT_ERROR_CODES.locationRequired,
  400,
  `${operation} needs a project directory (OpenCode 2 would otherwise use its own working directory)`,
  { operation, generation: 2, detail: { mode } },
);

/**
 * @typedef {object} LocationTranslation
 * @property {Record<string, string>} headers headers to add
 * @property {Record<string, string>} query query parameters to add
 * @property {Record<string, unknown> | undefined} body the body with `location` set (body-location), else the input body
 * @property {string | null} directory the directory the request is scoped to
 */

/**
 * Translates a DevRyan directory into the request scope of one operation.
 * @param {{ mode: string, directory?: unknown, body?: unknown, operation: string, required?: boolean }} input
 *   `required` forces a directory for `query-directory` operations (host routes).
 * @returns {LocationTranslation}
 */
export const translateLocation = ({ mode, directory, body, operation, required = false }) => {
  const resolved = normalizeLocationDirectory(directory, operation);
  const bodyRecord = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : undefined;
  switch (mode) {
    case 'header':
      if (resolved === null) throw locationRequired(operation, mode);
      return { headers: { [OPENCODE_LOCATION_HEADER]: encodeURIComponent(resolved) }, query: {}, body: bodyRecord, directory: resolved };
    case 'body-location': {
      if (resolved === null) throw locationRequired(operation, mode);
      return { headers: {}, query: {}, body: { ...(bodyRecord ?? {}), location: { directory: resolved } }, directory: resolved };
    }
    case 'query-directory':
      if (resolved === null) {
        if (required) throw locationRequired(operation, mode);
        return { headers: {}, query: {}, body: bodyRecord, directory: null };
      }
      return { headers: {}, query: { directory: resolved }, body: bodyRecord, directory: resolved };
    case 'session':
    case 'none':
      return { headers: {}, query: {}, body: bodyRecord, directory: null };
    default:
      // An unknown mode is a route-table defect: never guess a scope.
      throw locationRequired(operation, String(mode));
  }
};
