import fs from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';

const tails = new Map();
const owners = new AsyncLocalStorage();
/** Serializes application-owned index transactions; Git's own lock still
 * protects against external writers and is never removed here. */
export async function withGitIndexQueue(directory, action) {
  const key = await fs.realpath(directory);
  if (owners.getStore()?.has(key)) return action();
  const previous = tails.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => owners.run(new Set([...(owners.getStore() ?? []), key]), action));
  tails.set(key, next);
  try { return await next; }
  finally { if (tails.get(key) === next) tails.delete(key); }
}
