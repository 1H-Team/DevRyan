function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function createProjectPrewarmRuntime(dependencies = {}) {
  const warm = typeof dependencies.warm === 'function' ? dependencies.warm : async () => {};
  const listProjectDirectories = typeof dependencies.listProjectDirectories === 'function'
    ? dependencies.listProjectDirectories
    : async () => [];
  const waitForOpenCodeReady = typeof dependencies.waitForOpenCodeReady === 'function'
    ? dependencies.waitForOpenCodeReady
    : async () => {};
  const shouldAbort = typeof dependencies.shouldAbort === 'function'
    ? dependencies.shouldAbort
    : () => false;
  const logger = dependencies.logger && typeof dependencies.logger === 'object'
    ? dependencies.logger
    : console;
  let generation = 0;

  const log = (level, message) => {
    try {
      const writer = typeof logger[level] === 'function' ? logger[level] : logger.log;
      if (typeof writer === 'function') {
        writer.call(logger, message);
      }
    } catch {
      // Prewarming and its diagnostics must never affect server availability.
    }
  };

  const hasStopped = (runGeneration) => runGeneration !== generation || shouldAbort();

  return {
    async run(reason = 'manual') {
      const runGeneration = ++generation;
      const label = typeof reason === 'string' && reason.trim() ? reason.trim() : 'manual';

      try {
        await waitForOpenCodeReady(30_000);
      } catch (error) {
        log('warn', `[Prewarm] OpenCode readiness failed (${label}): ${formatError(error)}`);
        return;
      }

      try {
        if (hasStopped(runGeneration)) return;

        const listedDirectories = await listProjectDirectories();
        const directories = [];
        const seen = new Set();
        for (const candidate of Array.isArray(listedDirectories) ? listedDirectories : []) {
          const directory = typeof candidate === 'string' ? candidate.trim() : '';
          if (!directory || seen.has(directory)) continue;
          seen.add(directory);
          directories.push(directory);
        }

        for (const directory of directories) {
          if (hasStopped(runGeneration)) return;

          const startedAt = Date.now();
          try {
            await warm({ directory });
            log('log', `[Prewarm] warmed ${directory} in ${Math.max(0, Date.now() - startedAt)}ms (${label})`);
          } catch (error) {
            log('warn', `[Prewarm] failed ${directory} after ${Math.max(0, Date.now() - startedAt)}ms (${label}): ${formatError(error)}`);
          }
        }
      } catch (error) {
        log('warn', `[Prewarm] project discovery failed (${label}): ${formatError(error)}`);
      }
    },
  };
}

export { createProjectPrewarmRuntime };
