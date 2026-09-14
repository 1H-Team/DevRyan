import { createHmac, randomBytes } from 'node:crypto';

// Cache identity is process-local and never persisted or published. A keyed
// digest avoids retaining a raw credential in cache keys or their metadata.
const salt = randomBytes(32);

export const credentialCacheIdentity = (apiKey) => (
  createHmac('sha256', salt).update(apiKey).digest('hex')
);
