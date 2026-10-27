import { monitorEventLoopDelay } from 'node:perf_hooks';

import yazl from 'yazl';

import {
  createDiagnosticsExport,
  writeDiagnosticsZip,
} from '@devryan/harness-runtime';

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

// Event-loop delay of the host process (in Electron, the window's main
// thread) since the previous status read. Numbers only: it shows whether
// harness work starves UI IPC and SSE.
export const createEventLoopDelaySampler = ({ now = Date.now, monitor = monitorEventLoopDelay } = {}) => {
  const histogram = monitor({ resolution: 10 });
  histogram.enable();
  let since = now();
  const ms = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value / 1e4) / 100 : 0);
  return {
    read() {
      const at = now();
      const sample = {
        windowMs: Math.max(0, at - since),
        p50Ms: ms(histogram.percentile(50)),
        p99Ms: ms(histogram.percentile(99)),
        maxMs: ms(histogram.max),
      };
      histogram.reset();
      since = at;
      return sample;
    },
    stop() { histogram.disable(); },
  };
};

export const registerDiagnosticsRoutes = (app, options = {}) => {
  const runtime = options.runtime;
  if (!runtime) throw new TypeError('diagnostics runtime is required');
  const eventLoop = options.eventLoopSampler === undefined ? createEventLoopDelaySampler() : options.eventLoopSampler;

  app.get('/api/diagnostics/status', async (_req, res) => {
    try {
      const status = await runtime.getStatus();
      res.json({
        ...status,
        commandDeadlineRecovery: options.getCommandDeadlineRecoveryStatus?.() ?? null,
        eventLoop: eventLoop?.read() ?? null,
        ledgerWorker: await Promise.resolve(options.getLedgerWorkerStatus?.()).catch(() => null) ?? null,
      });
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
      if (req.body?.format !== undefined && !['zip', 'chrome-trace'].includes(req.body.format)) {
        return res.status(400).json({ error: 'Diagnostic format must be zip or chrome-trace' });
      }
      const scope = normalizeScope(req.body || {});
      await runtime.journal.flush?.();
      const bundle = await createDiagnosticsExport({
        journal: runtime.journal,
        sanitizer: runtime.sanitizer,
        scope,
        receipts: await runtime.getWorktreeReceipts(),
        evidence: await options.getEvidenceRecords?.(scope) ?? [],
      });
      if (req.body?.format === 'chrome-trace') {
        const trace = bundle.files.find((file) => file.name === 'DevRyan-trace.json');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Disposition', 'attachment; filename="DevRyan-trace.json"');
        return res.json(JSON.parse(trace.data));
      }
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
