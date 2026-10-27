import { crossSpawn } from '../../utils/compat';
import { requireReviewedAstGrepAsset } from '../../devryan/owners';
import {
  DEFAULT_MAX_MATCHES,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
} from './constants';
import type { CliLanguage, CliMatch, SgResult } from './types';

export interface RunOptions {
  pattern: string;
  lang: CliLanguage;
  paths?: string[];
  globs?: string[];
  rewrite?: string;
  context?: number;
  updateAll?: boolean;
}

// DevRyan: the executable is the bound reviewed asset; nothing is resolved lazily.
export async function getAstGrepPath(): Promise<string> {
  return requireReviewedAstGrepAsset();
}

export function startBackgroundInit(): void {}

export async function runSg(options: RunOptions): Promise<SgResult> {
  const args = [
    'run',
    '-p',
    options.pattern,
    '--lang',
    options.lang,
    '--json=compact',
  ];

  if (options.rewrite) {
    args.push('-r', options.rewrite);
    if (options.updateAll) {
      args.push('--update-all');
    }
  }

  if (options.context && options.context > 0) {
    args.push('-C', String(options.context));
  }

  if (options.globs) {
    for (const glob of options.globs) {
      args.push('--globs', glob);
    }
  }

  const paths =
    options.paths && options.paths.length > 0 ? options.paths : ['.'];
  args.push(...paths);

  const cliPath = requireReviewedAstGrepAsset();

  const timeout = DEFAULT_TIMEOUT_MS;

  const proc = crossSpawn([cliPath, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    const id = setTimeout(() => {
      proc.kill();
      reject(new Error(`Search timeout after ${timeout}ms`));
    }, timeout);
    proc.exited.then(() => clearTimeout(id));
  });

  let stdout: string;
  let stderr: string;
  let exitCode: number;

  try {
    stdout = await Promise.race([proc.stdout(), timeoutPromise]);
    stderr = await proc.stderr();
    exitCode = await proc.exited;
  } catch (e) {
    const error = e as Error;
    if (error.message?.includes('timeout')) {
      return {
        matches: [],
        totalMatches: 0,
        truncated: true,
        truncatedReason: 'timeout',
        error: error.message,
      };
    }

    return {
      matches: [],
      totalMatches: 0,
      truncated: false,
      error: `Failed to spawn ast-grep: ${error.message}`,
    };
  }

  if (exitCode !== 0 && stdout.trim() === '') {
    if (stderr.includes('No files found')) {
      return { matches: [], totalMatches: 0, truncated: false };
    }
    if (stderr.trim()) {
      return {
        matches: [],
        totalMatches: 0,
        truncated: false,
        error: stderr.trim(),
      };
    }
    return { matches: [], totalMatches: 0, truncated: false };
  }

  if (!stdout.trim()) {
    return { matches: [], totalMatches: 0, truncated: false };
  }

  const outputTruncated = stdout.length >= DEFAULT_MAX_OUTPUT_BYTES;
  const outputToProcess = outputTruncated
    ? stdout.substring(0, DEFAULT_MAX_OUTPUT_BYTES)
    : stdout;

  let matches: CliMatch[] = [];
  try {
    matches = JSON.parse(outputToProcess) as CliMatch[];
  } catch {
    if (outputTruncated) {
      try {
        const lastValidIndex = outputToProcess.lastIndexOf('}');
        if (lastValidIndex > 0) {
          const bracketIndex = outputToProcess.lastIndexOf(
            '},',
            lastValidIndex,
          );
          if (bracketIndex > 0) {
            const truncatedJson = `${outputToProcess.substring(0, bracketIndex + 1)}]`;
            matches = JSON.parse(truncatedJson) as CliMatch[];
          }
        }
      } catch {
        return {
          matches: [],
          totalMatches: 0,
          truncated: true,
          truncatedReason: 'max_output_bytes',
          error: 'Output too large and could not be parsed',
        };
      }
    } else {
      return { matches: [], totalMatches: 0, truncated: false };
    }
  }

  const totalMatches = matches.length;
  // DevRyan: ast-grep treats JSON output with --update-all as a preview. Keep
  // the original preview parsing, then apply through the identical command.
  if (options.updateAll && totalMatches > 0) {
    const apply = crossSpawn(
      [cliPath, ...args.filter((arg) => arg !== '--json=compact')],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    let applyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [, applyError, applyExit] = await Promise.race([
        Promise.all([apply.stdout(), apply.stderr(), apply.exited]),
        new Promise<never>((_, reject) => {
          applyTimer = setTimeout(() => {
            apply.kill();
            reject(new Error('AST apply timeout'));
          }, DEFAULT_TIMEOUT_MS);
        }),
      ]);
      if (applyExit !== 0)
        return {
          matches: [],
          totalMatches: 0,
          truncated: false,
          error: applyError.trim() || 'AST apply failed',
        };
    } finally {
      clearTimeout(applyTimer);
    }
  }
  const matchesTruncated = totalMatches > DEFAULT_MAX_MATCHES;
  const finalMatches = matchesTruncated
    ? matches.slice(0, DEFAULT_MAX_MATCHES)
    : matches;

  return {
    matches: finalMatches,
    totalMatches,
    truncated: outputTruncated || matchesTruncated,
    truncatedReason: outputTruncated
      ? 'max_output_bytes'
      : matchesTruncated
        ? 'max_matches'
        : undefined,
  };
}

export function isCliAvailable(): boolean {
  return Boolean(requireReviewedAstGrepAsset());
}

export async function ensureCliAvailable(): Promise<boolean> {
  return Boolean(await getAstGrepPath());
}
