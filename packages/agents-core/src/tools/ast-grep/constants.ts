import { requireReviewedAstGrepAsset } from '../../devryan/owners';
import { CLI_LANGUAGES } from './types';

// DevRyan: the only executable is the bound reviewed asset.
export function findSgCliPathSync(): string {
  return requireReviewedAstGrepAsset();
}

export function getSgCliPath(): string {
  return requireReviewedAstGrepAsset();
}

export function setSgCliPath(path: string): void {
  if (path !== requireReviewedAstGrepAsset()) throw new Error('reviewed_ast_asset_rebinding');
}

// Re-export language constants
export { CLI_LANGUAGES };

// Defaults
export const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1 * 1024 * 1024;
export const DEFAULT_MAX_MATCHES = 500;

export interface EnvironmentCheckResult {
  cli: {
    available: boolean;
    path: string;
    error?: string;
  };
}
