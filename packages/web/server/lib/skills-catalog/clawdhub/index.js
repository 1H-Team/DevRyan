/**
 * ClawdHub integration module
 * 
 * Provides skill browsing and installation from the ClawdHub registry.
 * https://clawdhub.com
 */

export { scanClawdHubPage } from './scan.js';
export { installSkillsFromClawdHub } from './install.js';

/**
 * Check if a source string refers to ClawdHub
 * @param {string} source
 * @returns {boolean}
 */
export function isClawdHubSource(source) {
  return typeof source === 'string' && source.startsWith('clawdhub:');
}
