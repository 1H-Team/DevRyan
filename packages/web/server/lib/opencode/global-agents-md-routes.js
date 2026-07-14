const getErrorMessage = (error, fallback) => (
  error instanceof Error && error.message.trim() ? error.message.trim() : fallback
);

const getErrorStatus = (error) => (
  Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
    ? error.statusCode
    : 500
);

export const registerGlobalAgentsMdRoutes = (app, { runtime }) => {
  app.get('/api/behavior/agents-md', async (_req, res) => {
    try {
      return res.json(await runtime.read());
    } catch (error) {
      console.error('Failed to read AGENTS.md:', error);
      return res.status(getErrorStatus(error)).json({
        error: getErrorMessage(error, 'Failed to read AGENTS.md'),
      });
    }
  });

  app.put('/api/behavior/agents-md', async (req, res) => {
    try {
      return res.json(await runtime.save(req.body?.content));
    } catch (error) {
      console.error('Failed to write AGENTS.md:', error);
      return res.status(getErrorStatus(error)).json({
        error: getErrorMessage(error, 'Failed to write AGENTS.md'),
      });
    }
  });
};
