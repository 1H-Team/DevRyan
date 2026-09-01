import { registerPwaManifestRoute } from './pwa-manifest-routes.js';

const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const REVALIDATE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const INDEX_CACHE_CONTROL = 'no-cache';
const SERVICE_WORKER_CACHE_CONTROL = 'no-store';

export const createStaticRoutesRuntime = (dependencies) => {
  const {
    fs,
    path,
    process,
    __dirname,
    express,
    resolveProjectDirectory,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    readSettingsFromDiskMigrated,
    normalizePwaAppName,
    normalizePwaOrientation,
  } = dependencies;

  const resolveDistPath = () => {
    const env = typeof process.env.OPENCHAMBER_DIST_DIR === 'string' ? process.env.OPENCHAMBER_DIST_DIR.trim() : '';
    if (env) {
      return path.resolve(env);
    }
    return path.join(__dirname, '..', 'dist');
  };

  const registerStaticRoutes = (app) => {
    const distPath = resolveDistPath();

    if (fs.existsSync(distPath)) {
      console.log(`Serving static files from ${distPath}`);
      app.use(express.static(distPath, {
        setHeaders(res, filePath) {
          if (typeof filePath !== 'string') return;

          // Service workers should never be long-cached; iOS is especially sensitive.
          if (filePath.endsWith(`${path.sep}sw.js`)) {
            res.setHeader('Cache-Control', SERVICE_WORKER_CACHE_CONTROL);
            return;
          }

          if (filePath.endsWith(`${path.sep}index.html`)) {
            res.setHeader('Cache-Control', INDEX_CACHE_CONTROL);
            return;
          }

          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', IMMUTABLE_ASSET_CACHE_CONTROL);
            return;
          }

          res.setHeader('Cache-Control', REVALIDATE_CACHE_CONTROL);
        },
      }));

      registerPwaManifestRoute(app, {
        process,
        resolveProjectDirectory,
        buildOpenCodeUrl,
        getOpenCodeAuthHeaders,
        readSettingsFromDiskMigrated,
        normalizePwaAppName,
        normalizePwaOrientation,
      });

      app.get(/^(?!\/api|.*\.(js|css|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|map)).*$/, (_req, res) => {
        res.setHeader('Cache-Control', INDEX_CACHE_CONTROL);
        res.sendFile(path.join(distPath, 'index.html'));
      });
      return;
    }

    console.warn(`Warning: ${distPath} not found, static files will not be served`);
    app.get(/^(?!\/api|.*\.(js|css|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|map)).*$/, (_req, res) => {
      res.status(404).send('Static files not found. Please build the application first.');
    });
  };

  return {
    registerStaticRoutes,
  };
};

export {
  IMMUTABLE_ASSET_CACHE_CONTROL,
  INDEX_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
  SERVICE_WORKER_CACHE_CONTROL,
};
