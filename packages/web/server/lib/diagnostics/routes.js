import yazl from 'yazl';

import {
  createDiagnosticsExport,
  writeDiagnosticsZip,
} from '@openchamber/harness-runtime';

const CLEAR_RANGE_MS = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '14d': 14 * 24 * 60 * 60 * 1000,
});

export const normalizeClearRange = (value, now = Date.now()) => {
  const range = value === undefined ? 'all' : value;
  if (range === 'all') return {};
  const duration = typeof range === 'string' ? CLEAR_RANGE_MS[range] : undefined;
  if (!duration) {
    const error = new Error('Diagnostic clear range must be 24h, 7d, 14d, or all');
    error.statusCode = 400;
    throw error;
  }
  return { since: now - duration };
};

const normalizeScope = (body) => {
  if (body?.scope === 'task') {
    const sessionID = typeof body.sessionID === 'string' ? body.sessionID.trim() : '';
    if (!sessionID) {
      const error = new Error('sessionID is required for a task diagnostics export');
      error.statusCode = 400;
      throw error;
    }
    return {
      scope: 'task',
      sessionID,
      directory: typeof body.directory === 'string' ? body.directory.trim() : undefined,
    };
  }
  return { scope: 'runtime' };
};

export const registerDiagnosticsRoutes = (app, options = {}) => {
  const runtime = options.runtime;
  if (!runtime) throw new TypeError('diagnostics runtime is required');

  app.get('/api/diagnostics/status', async (_req, res) => {
    try {
      res.json(await runtime.getStatus());
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to read diagnostic status' });
    }
  });

  app.delete('/api/diagnostics', async (req, res) => {
    try {
      const clearOptions = normalizeClearRange(req.query?.range, (options.now ?? Date.now)());
      res.json(await runtime.journal.clear(clearOptions));
    } catch (error) {
      res.status(error?.statusCode || 500).json({ error: error?.message || 'Failed to clear diagnostics' });
    }
  });

  app.post('/api/diagnostics/export', async (req, res) => {
    try {
      const scope = normalizeScope(req.body || {});
      const bundle = await createDiagnosticsExport({
        journal: runtime.journal,
        sanitizer: runtime.sanitizer,
        scope,
        receipts: await runtime.getWorktreeReceipts(),
        evidence: await options.getEvidenceRecords?.(scope) ?? [],
      });
      const archive = await writeDiagnosticsZip(bundle, {
        createArchive: () => new yazl.ZipFile(),
      });
      res.status(200);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${bundle.fileName.replaceAll('"', '')}"`,
      );
      res.setHeader('Cache-Control', 'no-store');
      archive.outputStream.once('error', (error) => {
        if (!res.headersSent) {
          res.status(500).json({ error: error?.message || 'Failed to export diagnostics' });
        } else {
          res.destroy(error);
        }
      });
      archive.outputStream.pipe(res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      res.status(error?.statusCode || 500).json({
        error: error?.message || 'Failed to export diagnostics',
      });
    }
  });

  app.post('/api/diagnostics/sanitize', (req, res) => {
    try {
      const text = typeof req.body?.text === 'string' ? req.body.text : '';
      if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) {
        res.status(413).json({ error: 'Diagnostics text is too large' });
        return;
      }
      res.json({ text: runtime.sanitizer.sanitizeText(text) });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to sanitize diagnostics' });
    }
  });
};
