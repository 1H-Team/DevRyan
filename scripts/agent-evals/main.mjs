#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadEvaluationConfig, parseEvaluationArgs } from './config.mjs';
import { runEvaluation } from './runner.mjs';

const defaultRepoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const safeErrorCode = (error) => {
  const code = typeof error?.code === 'string' ? error.code.trim() : '';
  return /^[a-z0-9_]{1,80}$/i.test(code) ? code : 'evaluation_failed';
};

export const runEvaluationCli = async (options = {}) => {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const argv = options.argv ?? process.argv.slice(2);
  const loadConfig = options.loadConfig ?? loadEvaluationConfig;
  const run = options.runEvaluation ?? runEvaluation;
  const stdout = options.stdout ?? ((line) => process.stdout.write(line));
  const stderr = options.stderr ?? ((line) => process.stderr.write(line));
  try {
    const { configPath } = parseEvaluationArgs(argv, { repoRoot });
    const config = loadConfig(configPath, { repoRoot });
    const result = await run(config);
    const status = result.report?.aggregates?.status === 'passed' ? 'passed' : 'failed';
    stdout(`[agent:eval] ${status}; schema-v1 report written\n`);
    return status === 'passed' ? 0 : 1;
  } catch (error) {
    stderr(`[agent:eval] ${safeErrorCode(error)}${error?.reportPath ? '; schema-v1 report written' : ''}\n`);
    return 1;
  }
};

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  process.exitCode = await runEvaluationCli();
}
