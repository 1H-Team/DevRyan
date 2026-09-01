import express from 'express';
import { jsonError, validateUuid } from './validation.js';

/** Mount behind the normal managed-auth and CSRF middleware, alongside existing Bot routes. */
export function registerBotTelegramRoutes(app, { getService } = {}) {
  const json = express.json({ limit: '8kb' });
  const route = (verb, suffix, method, withBody = false) => app[verb](`/api/bots/:botId/telegram${suffix}`, ...(withBody ? [json] : []), async (req, res) => {
    try {
      if (!req.principal?.id) return res.status(401).json({ code: 'bot_authentication_required', error: 'Authentication required' });
      const service = getService?.();
      if (!service) return res.status(503).json({ code: 'telegram_unavailable', error: 'Telegram is unavailable on this host' });
      const result = await service[method](req.principal, validateUuid(req.params.botId, 'botId'), ...(withBody ? [req.body] : []));
      return res.json(result);
    } catch (failure) { return jsonError(res, failure); }
  });
  route('get', '', 'status');
  route('put', '', 'configure', true);
  route('delete', '', 'disconnect');
  route('post', '/pairing', 'createPairing');
  route('post', '/pairing/confirm', 'confirmPairing', true);
  route('delete', '/pairing', 'revokePairing');
  route('put', '/preferences', 'setPreferences', true);
  route('get', '/deliveries', 'deliveries');
  route('post', '/deliveries/retry', 'retryDelivery', true);
}
