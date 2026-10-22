import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HARNESS_POLICY_ENV, resolveHarnessPolicies } from '@devryan/orchestration-runtime';

import { parseMdFile } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_DIR = path.resolve(__dirname, '../../default-config');
const DEFAULT_AGENT_DIR = path.join(DEFAULT_CONFIG_DIR, 'agents');
const AGENT_MODELS_COMPANION_VERSION = 1;

const hashContent = (content) => crypto.createHash('sha256').update(content).digest('hex');

// Paragraphs that only apply under a default-off harness policy are wrapped in
// `<!-- devryan:if name -->` / `<!-- devryan:if !name -->` ... `<!-- devryan:end -->`
// lines and rendered once per process, so a disabled capability costs no prompt
// bytes and an enabled one keeps a stable cached prefix.
const POLICY_BLOCK = /^<!-- devryan:if (!?)(\w+) -->\n([\s\S]*?)^<!-- devryan:end -->\n?/gm;

export function renderAgentPromptPolicies(prompt, policies = resolveHarnessPolicies(process.env)) {
  if (typeof prompt !== 'string' || !prompt.includes('<!-- devryan:')) return prompt;
  const rendered = prompt.replace(POLICY_BLOCK, (_block, negated, name, text) => {
    if (!Object.hasOwn(HARNESS_POLICY_ENV, name)) throw new Error(`Unknown harness policy in agent prompt: ${name}`);
    return (policies[name] === true) !== (negated === '!') ? text : '';
  });
  if (rendered.includes('<!-- devryan:')) throw new Error('Unbalanced harness policy block in agent prompt');
  return rendered.replace(/\n{3,}/g, '\n\n').trim();
}

const readAgentModelsCompanion = (filePath) => {
  const companionPath = filePath.replace(/\.md$/, '.models.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(companionPath, 'utf8'));
    if (parsed?.version !== AGENT_MODELS_COMPANION_VERSION || !Array.isArray(parsed.councillors)) {
      return [];
    }
    return parsed.councillors
      .filter((entry) => (
        entry
        && typeof entry === 'object'
        && !Array.isArray(entry)
        && typeof entry.model === 'string'
        && entry.model.trim().includes('/')
      ))
      .map((entry) => ({
        model: entry.model.trim(),
        ...(typeof entry.variant === 'string' && entry.variant.trim()
          ? { variant: entry.variant.trim() }
          : {}),
      }));
  } catch {
    return [];
  }
};

export function listPackagedAgents() {
  if (!fs.existsSync(DEFAULT_AGENT_DIR)) {
    return [];
  }

  return fs.readdirSync(DEFAULT_AGENT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => {
      const filePath = path.join(DEFAULT_AGENT_DIR, entry.name);
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter, body } = parseMdFile(filePath);
      const councillors = readAgentModelsCompanion(filePath);
      const modelFrontmatter = councillors.length > 0
        ? {
          ...frontmatter,
          councillors,
          modelRefs: councillors.map((entry) => entry.model),
        }
        : frontmatter;

      return {
        name: entry.name.slice(0, -3),
        path: filePath,
        content,
        hash: hashContent(content),
        frontmatter: modelFrontmatter,
        prompt: renderAgentPromptPolicies(body),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
