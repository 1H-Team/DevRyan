import fs from 'node:fs';
import path from 'node:path';

const extractAndStripFrontmatter = (content) => {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return match ? match[1] : content;
};

const resolveInstalledSkillsDirectory = () => {
  const configuredRoot = typeof process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR === 'string'
    && process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR.trim()
    ? path.resolve(process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR.trim())
    : path.resolve(import.meta.dirname, '..');
  return path.join(configuredRoot, 'skills', 'superpowers');
};

let bootstrapCache;
const warnedMissingBootstrapPaths = new Set();

export const DevRyanSuperpowersPlugin = async () => {
  const skillsDirectory = resolveInstalledSkillsDirectory();
  const bootstrapPath = path.join(skillsDirectory, 'using-superpowers', 'SKILL.md');
  if (!fs.existsSync(bootstrapPath)) {
    if (!warnedMissingBootstrapPaths.has(bootstrapPath)) {
      warnedMissingBootstrapPaths.add(bootstrapPath);
      console.warn(
        '[DevRyan] Superpowers skills are not installed; the optional adapter is disabled.',
      );
    }
    return {};
  }

  const getBootstrapContent = () => {
    if (bootstrapCache !== undefined) return bootstrapCache;
    const skillContent = extractAndStripFrontmatter(fs.readFileSync(bootstrapPath, 'utf8'));
    bootstrapCache = `<EXTREMELY_IMPORTANT>
You have DevRyan's curated Superpowers skills installed locally.

The using-superpowers skill is already loaded below. Do not load it a second time.

${skillContent}

Use OpenCode's native skill tool to list and load skills. Only skills present in the installed curated directory are part of this Superpowers distribution.
</EXTREMELY_IMPORTANT>`;
    return bootstrapCache;
  };

  return {
    config: async (config) => {
      config.skills = config.skills || {};
      config.skills.paths = Array.isArray(config.skills.paths) ? config.skills.paths : [];
      if (!config.skills.paths.includes(skillsDirectory)) {
        config.skills.paths.push(skillsDirectory);
      }
    },
    'experimental.chat.messages.transform': async (_input, output) => {
      if (!Array.isArray(output?.messages)) return;
      const firstUser = output.messages.find((message) => message?.info?.role === 'user');
      if (!firstUser || !Array.isArray(firstUser.parts)) return;
      if (firstUser.parts.some((part) => (
        part?.type === 'text'
        && typeof part.text === 'string'
        && part.text.includes("You have DevRyan's curated Superpowers skills installed locally.")
      ))) {
        return;
      }
      const referencePart = firstUser.parts[0] || {};
      firstUser.parts.unshift({
        ...referencePart,
        type: 'text',
        text: getBootstrapContent(),
      });
    },
  };
};

export default DevRyanSuperpowersPlugin;
