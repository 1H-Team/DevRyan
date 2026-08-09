const RESTRICTED_ROLES = new Set(['developer', 'senior_developer']);

const normalizeRequestPath = (req) => {
  let raw = '/';
  if (typeof req?.originalUrl === 'string' && req.originalUrl) {
    raw = req.originalUrl;
  } else if (typeof req?.url === 'string' && req.url) {
    raw = req.url;
  } else if (typeof req?.path === 'string' && req.path) {
    raw = req.path;
  }
  try {
    return new URL(raw, 'http://127.0.0.1').pathname.replace(/^\/api(?=\/|$)/, '') || '/';
  } catch {
    return String(raw).split('?', 1)[0].replace(/^\/api(?=\/|$)/, '') || '/';
  }
};

const decodePath = (value) => {
  let decoded = String(value || '').trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Express already decodes query values. Preserve malformed input so the
    // downstream route can reject it normally.
  }
  return decoded.replace(/\\/g, '/').replace(/\0/g, '');
};

export const isProtectedDotenvPath = (value) => {
  if (typeof value !== 'string' || !value.trim()) return false;
  const normalized = decodePath(value).replace(/\/+$/, '');
  const basename = normalized.split('/').pop()?.toLowerCase() || '';
  return basename === '.env' || basename.startsWith('.env.');
};

export const shouldHideProtectedDotenv = (principal) => (
  principal?.scope === 'managed' && RESTRICTED_ROLES.has(principal.role)
);

const referencedPath = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidates = [
    value.path,
    value.file,
    value.filePath,
    value.name,
    value.absolute,
    value.uri,
    value.oldPath,
    value.newPath,
    value.oldFileName,
    value.newFileName,
    value.path?.text,
    value.location?.uri,
  ];
  return candidates.find(isProtectedDotenvPath) || null;
};

export const filterProtectedDotenvReferences = (value) => {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => !isProtectedDotenvPath(entry) && !referencedPath(entry))
      .map((entry) => filterProtectedDotenvReferences(entry));
  }
  if (!value || typeof value !== 'object') return value;

  const filtered = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isProtectedDotenvPath(key)) continue;
    filtered[key] = filterProtectedDotenvReferences(entry);
  }
  return filtered;
};

export const filterProtectedDotenvResponse = (requestPath, payload) => {
  const filtered = filterProtectedDotenvReferences(payload);
  if (requestPath !== '/git/status' || !filtered || typeof filtered !== 'object' || Array.isArray(filtered)) {
    return filtered;
  }
  if (!Array.isArray(filtered.files)) return filtered;
  return {
    ...filtered,
    isClean: filtered.files.length === 0,
  };
};

const DIRECT_PATH_ROUTES = [
  /^\/fs\/(?:list|stat|read|raw|write|delete|rename|reveal)$/,
  /^\/file(?:\/content)?$/,
  /^\/git\/(?:diff|file-diff|revert|stage|unstage|apply-hunk|log|commit|commit-message(?:\/draft)?)$/,
];

const FILTERED_JSON_ROUTES = [
  /^\/fs\/list$/,
  /^\/git\/status$/,
  /^\/git\/conflict-details$/,
  /^\/git\/integrate\/(?:conflict-details|continue|in-progress)$/,
  /^\/git\/commit-files$/,
];

const collectRequestedPaths = (req) => {
  const body = req?.body && typeof req.body === 'object' ? req.body : {};
  const query = req?.query && typeof req.query === 'object' ? req.query : {};
  const context = body.context && typeof body.context === 'object' ? body.context : {};
  return [
    query.path,
    query.file,
    body.path,
    body.file,
    body.filePath,
    body.oldPath,
    body.newPath,
    ...(Array.isArray(body.files) ? body.files : []),
    ...(Array.isArray(body.selectedFiles) ? body.selectedFiles : []),
    ...(Array.isArray(context.selectedFiles) ? context.selectedFiles : []),
  ];
};

export const createDotenvVisibilityMiddleware = () => (req, res, next) => {
  if (!shouldHideProtectedDotenv(req?.principal)) return next();

  const requestPath = normalizeRequestPath(req);
  if (DIRECT_PATH_ROUTES.some((pattern) => pattern.test(requestPath))
    && collectRequestedPaths(req).some(isProtectedDotenvPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  if (!FILTERED_JSON_ROUTES.some((pattern) => pattern.test(requestPath))) return next();
  const originalJson = res.json.bind(res);
  res.json = (payload) => originalJson(filterProtectedDotenvResponse(requestPath, payload));
  return next();
};
