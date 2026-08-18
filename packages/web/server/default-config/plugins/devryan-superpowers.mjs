import fs from 'node:fs';
import path from 'node:path';

const resolveInstalledSkillsDirectory = () => {
  const configuredRoot = typeof process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR === 'string'
    && process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR.trim()
    ? path.resolve(process.env.DEVRYAN_OPENCODE_USER_CONFIG_DIR.trim())
    : path.resolve(import.meta.dirname, '..');
  return path.join(configuredRoot, 'skills', 'superpowers');
};

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

  return {
    config: async (config) => {
      config.skills = config.skills || {};
      config.skills.paths = Array.isArray(config.skills.paths) ? config.skills.paths : [];
      if (!config.skills.paths.includes(skillsDirectory)) {
        config.skills.paths.push(skillsDirectory);
      }
    },
  };
};

export default DevRyanSuperpowersPlugin;
