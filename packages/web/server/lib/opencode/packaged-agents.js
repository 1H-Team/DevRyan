import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HARNESS_POLICY_ENV, resolveNativeHarnessPolicies } from '@devryan/orchestration-runtime';

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
const POLICY_NAMES = Object.freeze(Object.keys(HARNESS_POLICY_ENV));

// Bump when the block syntax or the rendering rules below change. The renderer
// hash binds a run fingerprint's template hash to this exact renderer.
export const AGENT_PROMPT_RENDERER_VERSION = 1;
export const AGENT_PROMPT_RENDERER_HASH = hashContent(JSON.stringify({ version: AGENT_PROMPT_RENDERER_VERSION,
  block: POLICY_BLOCK.source, flags: POLICY_BLOCK.flags, collapse: '\\n{3,}', trim: true }));

// One policy source: once the managed orchestration runtime exists, prompts
// render from the same resolved projection that `harness_capabilities`
// returns. Before that (and in standalone tools) they fall back to the web
// process environment, and say so in their provenance.
let policySource = null;
export function setAgentPromptPolicySource(source) {
  if (source !== null && typeof source !== 'function') throw new TypeError('Agent prompt policy source must be a function or null');
  policySource = source;
}

/** `{ source, policies }`: the runtime projection when registered, otherwise the environment. */
export function resolveAgentPromptPolicies() {
  const projected = policySource?.() ?? null;
  if (projected === null) return { source: 'environment', policies: resolveNativeHarnessPolicies(process.env) };
  if (typeof projected !== 'object' || Array.isArray(projected) || POLICY_NAMES.some((name) => typeof projected[name] !== 'boolean')) {
    throw new TypeError('Agent prompt policy source returned an incomplete policy projection');
  }
  return { source: 'runtime-projection', policies: Object.freeze(Object.fromEntries(POLICY_NAMES.map((name) => [name, projected[name]]))) };
}

export function renderAgentPromptPolicies(prompt, policies = resolveAgentPromptPolicies().policies) {
  if (typeof prompt !== 'string' || !prompt.includes('<!-- devryan:')) return prompt;
  const rendered = prompt.replace(POLICY_BLOCK, (_block, negated, name, text) => {
    if (!Object.hasOwn(HARNESS_POLICY_ENV, name)) throw new Error(`Unknown harness policy in agent prompt: ${name}`);
    return (policies[name] === true) !== (negated === '!') ? text : '';
  });
  if (rendered.includes('<!-- devryan:')) throw new Error('Unbalanced harness policy block in agent prompt');
  return rendered.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Derivation evidence for one role template: the unrendered body plus renderer
 * identity, the policies it branches on, and the host's own render of it for
 * `policies`. Null when the template cannot be rendered.
 */
export function describeAgentPromptTemplate(template, policies, finalize = (body) => body) {
  if (typeof template !== 'string') return null;
  try {
    const referenced = new Set();
    for (const match of template.matchAll(POLICY_BLOCK)) referenced.add(match[2]);
    const rendered = renderAgentPromptPolicies(template, policies);
    return {
      templateHash: hashContent(JSON.stringify({ rendererVersion: AGENT_PROMPT_RENDERER_VERSION, template })),
      rendererHash: AGENT_PROMPT_RENDERER_HASH, rendererVersion: AGENT_PROMPT_RENDERER_VERSION,
      templatePolicies: [...referenced].sort(),
      // OpenCode decodes an agent body with `content.trim()`; `finalize` adds what
      // the native configuration appends (a primary agent's Plan-mode
      // instructions), so the comparison with the effective prompt is exact.
      attestedContentHash: hashContent(finalize(rendered.trim())),
    };
  } catch {
    return null;
  }
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
