import crypto from 'node:crypto';
import { createPrimaryRecoveryHost, createPrimaryRecoveryManagedAdapter } from '@openchamber/harness-runtime';

const ownerHash = (req) => {
  const cookie = String(req.headers?.cookie ?? '').split(';').map((value) => value.trim())
    .find((value) => value.startsWith('oc_app_session='));
  if (!cookie) return null;
  try {
    return crypto.createHash('sha256').update(decodeURIComponent(cookie.slice('oc_app_session='.length))).digest('hex');
  } catch { return null; }
};

export function createWebPrimaryRecoveryRuntime(options) {
  const host = createPrimaryRecoveryHost({ ...options,
    ...createPrimaryRecoveryManagedAdapter((request) => options.getManagedRuntime().handleRpc(request)),
    authorize: (record) => options.getMultiUserRuntime()?.canSessionTokenHashAccess(record.owner, record.sessionID) ?? false,
  });
  return { ...host,
    middleware: async (req, res, next) => {
      const result = await host.handleRequest(req.method, req.originalUrl, req.body, { owner: ownerHash(req) });
      if (result) { res.status(result.status).json(result.body); return; }
      next();
    },
  };
}
