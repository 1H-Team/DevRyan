// ---------------------------------------------------------------------------
// The openCodeClient dependency seam of the helper modules (DESIGN.md C.1,
// E item 13).
//
// A helper module receives `openCodeClient` through its deps, either the
// client itself or a getter returning it (the server may construct the client
// after the helper). Requests require an explicitly identified v2 client.
//
// The generation is read on every call, so a runtime switch applies at once.
// A missing client or unsupported generation throws (its
// `opencode_generation_invalid` error): callers treat that as a failed request
// and never fall back to raw legacy requests.
// ---------------------------------------------------------------------------

import { resolveOpenCodeGeneration } from './opencode-generation.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The explicitly identified v2 client. The helper name remains compatible.
 * @param {unknown} source the client, a getter returning it, or nothing
 * @returns {ReturnType<typeof import('./opencode-client/index.js').createOpenCodeClient>}
 * @throws when the client is missing or reports an unsupported generation
 */
export const resolveGen2OpenCodeClient = (source) => {
  const client = typeof source === 'function' ? source() : source;
  resolveOpenCodeGeneration(client);
  return client;
};

/**
 * The HTTP status a client error stands for (`statusCode`), or `0` when the
 * failure carries none (transport failure, abort, programming error).
 * @param {unknown} error
 * @returns {number}
 */
export const openCodeClientErrorStatus = (error) => {
  const status = isRecord(error) ? error.statusCode : undefined;
  return Number.isInteger(status) && status > 0 ? status : 0;
};
