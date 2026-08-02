export const ROBOTS_POLICY = 'User-agent: *\nDisallow: /';
export const INDEXING_POLICY_HEADER = 'noindex, nofollow';

export const registerIndexingPolicy = (app) => {
  app.use((_req, res, next) => {
    res.setHeader('X-Robots-Tag', INDEXING_POLICY_HEADER);
    next();
  });

  app.get('/robots.txt', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/plain').send(ROBOTS_POLICY);
  });
};
