#!/usr/bin/env node
// Regenerates the static OpenCode route table (the fallback used by the web
// server's route guard before OpenCode's live `/doc` spec is loaded) from the
// installed @opencode-ai/sdk v2 generated client.
//
//   node scripts/generate-opencode-routes.mjs          write the table
//   node scripts/generate-opencode-routes.mjs --check  exit 1 when it is stale
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OPENCODE_ROUTES_GENERATED_FILENAME,
  findInstalledOpenCodeSdk,
  readOpenCodeSdkRoutes,
  renderOpenCodeRoutesModule,
} from '../packages/web/server/lib/opencode/opencode-routes-sdk.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPENCODE_DIR = path.join(ROOT, 'packages', 'web', 'server', 'lib', 'opencode');
const OUTPUT_PATH = path.join(OPENCODE_DIR, OPENCODE_ROUTES_GENERATED_FILENAME);

const args = process.argv.slice(2);
const unknownArgs = args.filter((arg) => arg !== '--check');
if (unknownArgs.length > 0) {
  console.error(`Unknown argument(s): ${unknownArgs.join(' ')}`);
  console.error('Usage: node scripts/generate-opencode-routes.mjs [--check]');
  process.exit(2);
}
const checkOnly = args.includes('--check');

let content;
let routeCount;
try {
  const sdk = findInstalledOpenCodeSdk(OPENCODE_DIR);
  const table = readOpenCodeSdkRoutes(sdk);
  routeCount = table.routes.length;
  content = renderOpenCodeRoutesModule(table);
} catch (error) {
  console.error(`Failed to read OpenCode SDK routes: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const relativeOutput = path.relative(ROOT, OUTPUT_PATH);
const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf8') : null;

if (checkOnly) {
  if (current !== content) {
    console.error(`${relativeOutput} is stale; run node scripts/generate-opencode-routes.mjs`);
    process.exit(1);
  }
  console.log(`${relativeOutput} is current (${routeCount} routes)`);
  process.exit(0);
}

if (current === content) {
  console.log(`${relativeOutput} unchanged (${routeCount} routes)`);
} else {
  fs.writeFileSync(OUTPUT_PATH, content);
  console.log(`Wrote ${relativeOutput} (${routeCount} routes)`);
}
