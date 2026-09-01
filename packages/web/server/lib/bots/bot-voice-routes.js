import express from 'express';
import { jsonError, validateUuid } from './validation.js';

// Host-owned configuration only; normal managed authentication and CSRF apply.
export function registerBotVoiceRoutes(app, { getService }) {
  const route = (method, operation) => app[method]('/api/bots/:botId/speech',
    ...(method === 'put' ? [express.json({ limit: '16kb' })] : []),
    async (req, res) => {
      try {
        if (!req.principal?.id) return res.status(401).json({ code: 'bot_authentication_required' });
        const service = getService();
        if (!service) return res.status(503).json({ code: 'bot_speech_unavailable', error: 'Speech is unavailable on this host' });
        return res.json(await service[operation](req.principal, validateUuid(req.params.botId, 'botId'),
          ...(method === 'put' ? [req.body] : [])));
      } catch (error) { return jsonError(res, error); }
    });
  route('get', 'status');
  route('put', 'configure');
  app.post('/api/bots/:botId/speech/check', async (req, res) => {
    try {
      if (!req.principal?.id) return res.status(401).json({ code: 'bot_authentication_required' });
      const service = getService();
      if (!service) return res.status(503).json({ code: 'bot_speech_unavailable' });
      return res.json(await service.check(req.principal, validateUuid(req.params.botId, 'botId')));
    } catch (error) { return jsonError(res, error); }
  });
}
