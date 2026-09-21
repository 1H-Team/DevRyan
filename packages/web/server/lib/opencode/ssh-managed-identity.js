import { createHmac, timingSafeEqual } from 'node:crypto';

const consumedShutdowns = new Map();

/** A challenge proves the listener holds the per-SSH-instance key. Health
 * liveness, product-shaped JSON and a matching version alone prove nothing. */
export function sshManagedIdentity(req, { env = process.env, version, runtimeInstanceId }) {
  const key = env.DEVRYAN_SSH_OWNER_TOKEN, id = env.DEVRYAN_SSH_INSTANCE_ID;
  const nonce = req.query?.sshChallenge;
  if (!/^[a-f0-9]{64}$/.test(key ?? '') || typeof id !== 'string' || !id || id.length > 512
    || !/^[a-f0-9]{64}$/.test(nonce ?? '')) return undefined;
  const address = req.socket?.server?.address?.();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') return undefined;
  const claim = { protocol: 1, id, version, runtimeInstanceId, host: address.address, port: address.port, nonce };
  return { ...claim, proof: createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(claim)).digest('hex') };
}

export function authorizeSshManagedShutdown(req, { env = process.env, runtimeInstanceId, now = Date.now() }) {
  const key = env.DEVRYAN_SSH_OWNER_TOKEN, id = env.DEVRYAN_SSH_INSTANCE_ID;
  const body = req.body, address = req.socket?.server?.address?.();
  if (!/^[a-f0-9]{64}$/.test(key ?? '') || !id || !body || body.id !== id || body.runtimeInstanceId !== runtimeInstanceId
    || !address || address.address !== '127.0.0.1' || address.port !== body.port
    || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    || !Number.isSafeInteger(body.at) || Math.abs(now - body.at) > 30_000
    || !/^[a-f0-9]{64}$/.test(body.nonce ?? '') || !/^[a-f0-9]{64}$/.test(body.proof ?? '')) return false;
  for (const [nonce, at] of consumedShutdowns) if (now - at > 60_000) consumedShutdowns.delete(nonce);
  if (consumedShutdowns.has(body.nonce)) return false;
  const claim = { action: 'shutdown', id, runtimeInstanceId, port: body.port, at: body.at, nonce: body.nonce };
  const expected = createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(claim)).digest();
  if (!timingSafeEqual(expected, Buffer.from(body.proof, 'hex'))) return false;
  consumedShutdowns.set(body.nonce, now); return true;
}
