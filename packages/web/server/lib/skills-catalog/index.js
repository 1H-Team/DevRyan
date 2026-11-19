/**
 * Skills catalog module
 *
 * Provides skill scanning, installation, and caching from GitHub repositories and ClawdHub.
 */

export {
  getCuratedSkillsSources,
} from './curated-sources.js';

export {
  getCacheKey,
  getCachedScan,
  setCachedScan,
  clearCache,
} from './cache.js';

export {
  parseSkillRepoSource,
} from './source.js';

export {
  scanSkillsRepository,
} from './scan.js';

export {
  installSkillsFromRepository,
} from './install.js';

export {
  scanClawdHubPage,
  installSkillsFromClawdHub,
  isClawdHubSource,
} from './clawdhub/index.js';
