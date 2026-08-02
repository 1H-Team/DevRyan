// Read-only memory diagnostics. `getAppMetrics` is injected by the Electron
// shell (app.getAppMetrics()) and is null when running as a plain web server.
export const registerMemoryDebugRoutes = (app, options = {}) => {
  const getAppMetrics = typeof options.getAppMetrics === 'function' ? options.getAppMetrics : null;

  app.get('/api/debug/memory', async (_req, res) => {
    try {
      const usage = process.memoryUsage();
      let appMetrics = null;
      if (getAppMetrics) {
        try {
          appMetrics = await getAppMetrics();
        } catch (error) {
          appMetrics = { error: error?.message || 'Failed to collect app metrics' };
        }
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        at: Date.now(),
        process: {
          rss: usage.rss,
          heapTotal: usage.heapTotal,
          heapUsed: usage.heapUsed,
          external: usage.external,
          arrayBuffers: usage.arrayBuffers,
        },
        appMetrics,
      });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to read memory usage' });
    }
  });
};
