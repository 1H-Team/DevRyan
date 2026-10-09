import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  OPENCODE_V2_OPENAPI_PATH,
  OPENCODE_V2_ROUTES_OUTPUT_PATH,
  generateOpenCodeV2RoutesModule,
} from './generate-opencode-v2-routes.mjs';
import {
  OPENCODE_V2_LOCATION_MODES,
  extractOpenCodeV2Operations,
  renderOpenCodeV2RoutesModule,
} from '../packages/web/server/lib/opencode/v2/openapi-routes.js';

const SCRIPT = fileURLToPath(new URL('./generate-opencode-v2-routes.mjs', import.meta.url));
const sourceBytes = () => fs.readFileSync(OPENCODE_V2_OPENAPI_PATH);
const sourceDoc = () => JSON.parse(sourceBytes().toString('utf8'));

// Rebuilds an object with its keys in reverse order at every level.
const reverseKeys = (value) => {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])]));
};

test('the checked-in table equals a fresh generation from the vendored document', () => {
  const { content, routeCount } = generateOpenCodeV2RoutesModule(sourceBytes());
  assert.equal(routeCount, 142);
  assert.equal(fs.readFileSync(OPENCODE_V2_ROUTES_OUTPUT_PATH, 'utf8'), content);
});

test('generation is byte-stable across runs and across key order', () => {
  const first = generateOpenCodeV2RoutesModule(sourceBytes()).content;
  const second = generateOpenCodeV2RoutesModule(sourceBytes()).content;
  assert.equal(first, second);
  const sha = crypto.createHash('sha256').update(sourceBytes()).digest('hex');
  const reordered = renderOpenCodeV2RoutesModule({ version: '2.0.26', sourceSha256: sha, operations: extractOpenCodeV2Operations(reverseKeys(sourceDoc())) });
  assert.equal(reordered, first);
  assert.match(first, new RegExp(`OPENCODE_V2_OPENAPI_SHA256 = "${sha}"`));
});

test('operations are sorted, unique and carry location modes from the spec', () => {
  const operations = extractOpenCodeV2Operations(sourceDoc());
  const keys = operations.map((operation) => `${operation.method} ${operation.template}`);
  assert.equal(new Set(keys).size, 142);
  const sorted = [...operations].sort((left, right) => (left.template === right.template
    ? (left.method < right.method ? -1 : 1)
    : (left.template < right.template ? -1 : 1)));
  assert.deepEqual(operations, sorted);
  for (const operation of operations) assert.ok(OPENCODE_V2_LOCATION_MODES.includes(operation.location), operation.template);
  const byKey = new Map(operations.map((operation) => [`${operation.method} ${operation.template}`, operation]));
  assert.equal(byKey.get('GET /api/agent').location, 'header');
  assert.equal(byKey.get('GET /api/pty/{ptyID}/connect').location, 'header');
  assert.equal(byKey.get('POST /api/session').location, 'body-location');
  assert.equal(byKey.get('GET /api/session').location, 'query-directory');
  assert.equal(byKey.get('GET /api/session/{sessionID}/message').location, 'session');
  assert.equal(byKey.get('GET /api/info').location, 'none');
  assert.equal(byKey.get('GET /api/event').stream, 'sse');
  assert.deepEqual(byKey.get('PATCH /api/session/{sessionID}').body, { contentType: 'application/json', required: true, keys: ['metadata', 'permissions', 'title'] });
  assert.deepEqual(byKey.get('PUT /api/experimental/session/{sessionID}/instructions/entries/{key}').pathParams, [
    { name: 'sessionID', pattern: '^ses' },
    { name: 'key', pattern: '^[a-z0-9][a-z0-9._-]*$' },
  ]);
  // $ref bodies resolve to their component's properties.
  assert.deepEqual(byKey.get('POST /api/credential').body.keys, ['activate', 'id', 'integrationID', 'label', 'value']);
});

test('every declared path-parameter pattern compiles', () => {
  for (const operation of extractOpenCodeV2Operations(sourceDoc())) {
    for (const parameter of operation.pathParams) {
      if (parameter.pattern !== null) assert.doesNotThrow(() => new RegExp(parameter.pattern, 'u'), `${operation.template} ${parameter.name}`);
    }
  }
});

test('malformed documents fail instead of producing a smaller table', () => {
  assert.throws(() => extractOpenCodeV2Operations(null), /must be an object with paths/);
  assert.throws(() => extractOpenCodeV2Operations({ paths: {} }), /no operations/);
  assert.throws(() => extractOpenCodeV2Operations({ paths: { '/a': { get: { parameters: [] } } } }), /has no operationId/);
  assert.throws(() => extractOpenCodeV2Operations({ paths: { 'a': { get: { operationId: 'a' } } } }), /malformed/);
  assert.throws(
    () => extractOpenCodeV2Operations({ paths: { '/a/{id}': { get: { operationId: 'a', parameters: [] } } } }),
    /path parameters that differ/,
  );
  assert.throws(() => renderOpenCodeV2RoutesModule({ version: '2.0.26', sourceSha256: 'nope', operations: [] }), /sha256/);
  assert.throws(() => generateOpenCodeV2RoutesModule(Buffer.from('{not json')), SyntaxError);
});

test('CLI --check passes on the checked-in table and rejects unknown arguments', () => {
  const check = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /is current \(142 routes\)/);
  const unknown = spawnSync(process.execPath, [SCRIPT, '--force'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown argument/);
});
