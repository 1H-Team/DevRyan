import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMdFile } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_DIR = path.resolve(__dirname, '../../default-config');
const DEFAULT_AGENT_DIR = path.join(DEFAULT_CONFIG_DIR, 'agents');
const AGENT_MODELS_COMPANION_VERSION = 1;

const hashContent = (content) => crypto.createHash('sha256').update(content).digest('hex');

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
        prompt: body,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
