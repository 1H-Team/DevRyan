// Reads the OpenCode 2.x OpenAPI document into a flat, sorted operation table.
// Shared by the build-time generator (scripts/generate-opencode-v2-routes.mjs),
// which renders `routes.generated.js` from the vendored `openapi-2.0.20.json`,
// and by the runtime drift check (`diffLiveSpec` in route-policy.js), which
// compares a live host's `/openapi.json` with that table. Pure: no I/O.

export const OPENCODE_V2_OPENAPI_VERSION = '2.0.20';
export const OPENCODE_V2_OPENAPI_FILENAME = `openapi-${OPENCODE_V2_OPENAPI_VERSION}.json`;
export const OPENCODE_V2_ROUTES_GENERATED_FILENAME = 'routes.generated.js';

const OPENAPI_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const COMPONENT_REF_PREFIX = '#/components/schemas/';

/**
 * How an operation is scoped to a project directory on the wire:
 * - `header`: LocationMiddleware (`location[directory]` query or `x-opencode-directory`);
 *   v2 falls back to the host's cwd when neither is sent.
 * - `body-location`: the request body carries `location: { directory }` (session create, import).
 * - `query-directory`: a plain `directory` query filter (session list).
 * - `session`: the stored session's location applies.
 * - `none`: not location-scoped.
 */
export const OPENCODE_V2_LOCATION_MODES = Object.freeze(['header', 'body-location', 'query-directory', 'session', 'none']);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const resolveSchema = (doc, schema) => {
  if (!isRecord(schema)) return null;
  if (typeof schema.$ref !== 'string') return schema;
  if (!schema.$ref.startsWith(COMPONENT_REF_PREFIX)) return null;
  const resolved = doc?.components?.schemas?.[schema.$ref.slice(COMPONENT_REF_PREFIX.length)];
  return isRecord(resolved) ? resolved : null;
};

const readPathParams = (doc, parameters) => parameters
  .filter((parameter) => parameter.in === 'path' && typeof parameter.name === 'string')
  .map((parameter) => {
    const schema = resolveSchema(doc, parameter.schema);
    return { name: parameter.name, pattern: typeof schema?.pattern === 'string' ? schema.pattern : null };
  });

const readBody = (doc, requestBody) => {
  if (!isRecord(requestBody) || !isRecord(requestBody.content)) return null;
  const contentTypes = Object.keys(requestBody.content).sort();
  const contentType = contentTypes[0] ?? null;
  if (!contentType) return null;
  const schema = resolveSchema(doc, requestBody.content[contentType]?.schema);
  const keys = isRecord(schema?.properties) ? Object.keys(schema.properties).sort() : null;
  return { contentType, required: requestBody.required === true, keys };
};

const readStream = (responses) => {
  if (!isRecord(responses)) return null;
  for (const [status, response] of Object.entries(responses)) {
    if (!status.startsWith('2') || !isRecord(response?.content)) continue;
    if (Object.hasOwn(response.content, 'text/event-stream')) return 'sse';
  }
  return null;
};

const readLocationMode = ({ queryNames, pathParams, body }) => {
  if (queryNames.includes('location') || queryNames.includes('location[directory]')) return 'header';
  if (body?.keys?.includes('location')) return 'body-location';
  if (queryNames.includes('directory')) return 'query-directory';
  if (pathParams.some((parameter) => parameter.name === 'sessionID')) return 'session';
  return 'none';
};

export const compareOpenCodeV2Operations = (left, right) => {
  if (left.template !== right.template) return left.template < right.template ? -1 : 1;
  if (left.method === right.method) return 0;
  return left.method < right.method ? -1 : 1;
};

export const openCodeV2RouteKey = (method, template) => `${method} ${template}`;

/**
 * Extracts every operation of an OpenAPI 3.x document as
 * `{ method, template, operationId, location, pathParams, query, body, stream }`,
 * sorted by template then method. Throws on a document without operations or
 * with duplicate or incomplete operations, so a malformed spec never yields a
 * silently smaller table.
 */
export const extractOpenCodeV2Operations = (doc) => {
  if (!isRecord(doc) || !isRecord(doc.paths)) {
    throw new TypeError('OpenCode v2 OpenAPI document must be an object with paths');
  }
  const operations = [];
  const seen = new Set();
  for (const [template, item] of Object.entries(doc.paths)) {
    if (!template.startsWith('/') || !isRecord(item)) {
      throw new Error(`OpenCode v2 OpenAPI path ${JSON.stringify(template)} is malformed`);
    }
    for (const method of OPENAPI_METHODS) {
      const operation = item[method];
      if (operation === undefined) continue;
      if (!isRecord(operation) || typeof operation.operationId !== 'string' || operation.operationId.length === 0) {
        throw new Error(`OpenCode v2 OpenAPI operation ${method.toUpperCase()} ${template} has no operationId`);
      }
      const upper = method.toUpperCase();
      const key = openCodeV2RouteKey(upper, template);
      if (seen.has(key)) throw new Error(`OpenCode v2 OpenAPI operation ${key} is duplicated`);
      seen.add(key);
      const parameters = [
        ...(Array.isArray(item.parameters) ? item.parameters : []),
        ...(Array.isArray(operation.parameters) ? operation.parameters : []),
      ].filter(isRecord);
      const pathParams = readPathParams(doc, parameters);
      const declared = [...template.matchAll(/\{([^{}/]+)\}/g)].map((match) => match[1]);
      if (declared.join('\n') !== pathParams.map((parameter) => parameter.name).join('\n')) {
        throw new Error(`OpenCode v2 OpenAPI operation ${key} declares path parameters that differ from its template`);
      }
      const queryNames = parameters
        .filter((parameter) => parameter.in === 'query' && typeof parameter.name === 'string')
        .map((parameter) => parameter.name)
        .sort();
      const body = readBody(doc, operation.requestBody);
      operations.push({
        method: upper,
        template,
        operationId: operation.operationId,
        location: readLocationMode({ queryNames, pathParams, body }),
        pathParams,
        query: queryNames,
        body,
        stream: readStream(operation.responses),
      });
    }
  }
  if (operations.length === 0) throw new Error('OpenCode v2 OpenAPI document has no operations');
  return operations.sort(compareOpenCodeV2Operations);
};

/** Renders `routes.generated.js`. The output depends only on its inputs (byte-stable). */
export const renderOpenCodeV2RoutesModule = ({ version, sourceSha256, operations }) => {
  if (typeof version !== 'string' || version.length === 0) throw new TypeError('version is required');
  if (typeof sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sourceSha256)) {
    throw new TypeError('sourceSha256 must be a lowercase sha256 hex digest');
  }
  const lines = operations.map((operation) => `  ${JSON.stringify({
    method: operation.method,
    template: operation.template,
    operationId: operation.operationId,
    location: operation.location,
    pathParams: operation.pathParams,
    query: operation.query,
    body: operation.body,
    stream: operation.stream,
  })},`);
  return [
    `// Generated by scripts/generate-opencode-v2-routes.mjs from v2/openapi-${version}.json`,
    '// (the OpenCode 2.x host\'s /openapi.json). Do not edit by hand; rerun the script after',
    '// replacing the vendored document. Route classes live in route-policy.js.',
    `export const OPENCODE_V2_ROUTES_VERSION = ${JSON.stringify(version)};`,
    `export const OPENCODE_V2_OPENAPI_SHA256 = ${JSON.stringify(sourceSha256)};`,
    '',
    'const freezeRoute = (route) => Object.freeze({',
    '  ...route,',
    '  pathParams: Object.freeze(route.pathParams.map((parameter) => Object.freeze(parameter))),',
    '  query: Object.freeze(route.query),',
    '  body: route.body ? Object.freeze({ ...route.body, keys: route.body.keys ? Object.freeze(route.body.keys) : null }) : null,',
    '});',
    '',
    'export const OPENCODE_V2_ROUTES = Object.freeze([',
    ...lines,
    '].map(freezeRoute));',
    '',
  ].join('\n');
};
