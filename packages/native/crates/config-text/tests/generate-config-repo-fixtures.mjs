#!/usr/bin/env node
// Writes config-text-repo-fixtures.tsv: a snapshot of the repository's own
// configuration files that the vector generators use as inputs (the default
// OpenCode configuration, the user-profile configuration, the packaged agent
// and skill files, a workflow as a stand-in for a YAML configuration file),
// plus a hand-written project configuration of the usual shape with
// placeholder values only (no person's own configuration is copied here).
// Agent and skill bodies are cut to their first 400 units: only the front
// matter and its delimiters matter to the operations.
//
// The snapshot is refreshed by hand (`node <this file>`), never compared
// with the live files, so editing an agent prompt does not stale the vectors.
// One row per file: name, base64 of its UTF-8.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPOSITORY_ROOT, TESTS_DIR } from './config-text-format.mjs';

const BODY_LIMIT = 400;
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function files() {
  const out = [
    'packages/web/server/default-config/opencode.json',
    'packages/web/server/default-config/user-profile/opencode.json',
    'packages/web/server/default-config/user-profile/devryan-agents.jsonc',
    '.github/workflows/supabase-migrate.yml',
  ];
  const agents = 'packages/web/server/default-config/agents';
  for (const name of readdirSync(path.join(REPOSITORY_ROOT, agents)).filter((name) => name.endsWith('.md')).sort(byName)) out.push(`${agents}/${name}`);
  const skills = 'packages/agents-core/src/skills';
  for (const name of readdirSync(path.join(REPOSITORY_ROOT, skills)).sort(byName)) out.push(`${skills}/${name}/SKILL.md`);
  out.push('packages/web/server/lib/agent-browser/assets/agent-browser/SKILL.md');
  return out;
}

function snapshot(file) {
  const text = readFileSync(path.join(REPOSITORY_ROOT, file), 'utf8');
  if (!file.endsWith('.md')) return text;
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const head = match ? match[0].length : 0;
  return text.slice(0, head + BODY_LIMIT);
}

/**
 * A project `opencode.json` of the shape such files have (`$schema`, agents
 * disabled, `lsp`, local MCP servers with an environment, plugins, a provider
 * with options), every value a placeholder.
 */
const STAND_IN = ['stand-in/opencode.json', `${JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  agent: { explore: { disable: true }, general: { disable: true } },
  lsp: true,
  mcp: {
    example: { command: ['/home/example/bin/npx', '-y', 'example-mcp@1.0.0'], enabled: true, environment: { HOME: '/home/example' }, type: 'local' },
    second: { command: ['example', 'mcp'], enabled: true, type: 'local' },
  },
  plugin: ['./plugins/example.mjs', 'example-plugin@1.0.0'],
  provider: { example: { options: { baseURL: 'http://127.0.0.1:1', apiKey: 'example' } } },
}, null, 2)}\n`];

const entries = [...files().map((file) => [file, snapshot(file)]), STAND_IN];
const rows = entries.map(([file, text]) => `${file}\t${Buffer.from(text, 'utf8').toString('base64')}`);
const target = path.join(TESTS_DIR, 'config-text-repo-fixtures.tsv');
writeFileSync(target, `# Snapshot of repository configuration files and a placeholder stand-in (generate-config-repo-fixtures.mjs); path, base64 of UTF-8.\n${rows.join('\n')}\n`);
console.log(`Wrote ${target} (${rows.length} files).`);
