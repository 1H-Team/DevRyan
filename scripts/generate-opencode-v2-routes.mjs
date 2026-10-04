#!/usr/bin/env node
// Regenerates the OpenCode 2.x route table (packages/web/server/lib/opencode/v2/
// routes.generated.js) from the vendored OpenAPI document
// (v2/openapi-<version>.json, a copy of the pinned host's /openapi.json).
// The table is the input of the deny-by-default route policy (v2/route-policy.js).
//
//   node scripts/generate-opencode-v2-routes.mjs          write the table
//   node scripts/generate-opencode-v2-routes.mjs --check  exit 1 when it is stale
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  OPENCODE_V2_OPENAPI_FILENAME,
  OPENCODE_V2_OPENAPI_VERSION,
  OPENCODE_V2_ROUTES_GENERATED_FILENAME,
  extractOpenCodeV2Operations,
  renderOpenCodeV2RoutesModule,
} from '../packages/web/server/lib/opencode/v2/openapi-routes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OPENCODE_V2_DIR = path.join(ROOT, 'packages', 'web', 'server', 'lib', 'opencode', 'v2');
export const OPENCODE_V2_OPENAPI_PATH = path.join(OPENCODE_V2_DIR, OPENCODE_V2_OPENAPI_FILENAME);
export const OPENCODE_V2_ROUTES_OUTPUT_PATH = path.join(OPENCODE_V2_DIR, OPENCODE_V2_ROUTES_GENERATED_FILENAME);

/** Renders the module for the given OpenAPI document bytes. Pure apart from hashing. */
export const generateOpenCodeV2RoutesModule = (sourceBytes, version = OPENCODE_V2_OPENAPI_VERSION) => {
  const operations = extractOpenCodeV2Operations(JSON.parse(sourceBytes.toString('utf8')));
  const sourceSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  return { content: renderOpenCodeV2RoutesModule({ version, sourceSha256, operations }), routeCount: operations.length };
};

const main = (args) => {
  const unknownArgs = args.filter((arg) => arg !== '--check');
  if (unknownArgs.length > 0) {
    console.error(`Unknown argument(s): ${unknownArgs.join(' ')}`);
    console.error('Usage: node scripts/generate-opencode-v2-routes.mjs [--check]');
    return 2;
  }
  const checkOnly = args.includes('--check');

  let generated;
  try {
    generated = generateOpenCodeV2RoutesModule(fs.readFileSync(OPENCODE_V2_OPENAPI_PATH));
  } catch (error) {
    console.error(`Failed to read the OpenCode v2 OpenAPI document: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const relativeOutput = path.relative(ROOT, OPENCODE_V2_ROUTES_OUTPUT_PATH);
  const current = fs.existsSync(OPENCODE_V2_ROUTES_OUTPUT_PATH) ? fs.readFileSync(OPENCODE_V2_ROUTES_OUTPUT_PATH, 'utf8') : null;

  if (checkOnly) {
    if (current !== generated.content) {
      console.error(`${relativeOutput} is stale; run node scripts/generate-opencode-v2-routes.mjs`);
      return 1;
    }
    console.log(`${relativeOutput} is current (${generated.routeCount} routes)`);
    return 0;
  }

  if (current === generated.content) {
    console.log(`${relativeOutput} unchanged (${generated.routeCount} routes)`);
  } else {
    fs.writeFileSync(OPENCODE_V2_ROUTES_OUTPUT_PATH, generated.content);
    console.log(`Wrote ${relativeOutput} (${generated.routeCount} routes)`);
  }
  return 0;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
