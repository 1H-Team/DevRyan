export type DirectoryLoadRegistry = Map<string, Promise<void>>;

type OwnedDirectoryLoadOptions<T> = {
  directory: string;
  inFlight: DirectoryLoadRegistry;
  shouldStart: () => boolean;
  request: () => Promise<T>;
  shouldCommit: () => boolean;
  commit: (value: T) => void;
  onError?: () => void;
};

/** Deduplicate a directory request and let a newer owner retry after the old request settles. */
export const runOwnedDirectoryLoad = async <T>(options: OwnedDirectoryLoadOptions<T>): Promise<void> => {
  const existing = options.inFlight.get(options.directory);
  if (existing) {
    await existing;
    if (options.shouldStart()) {
      await runOwnedDirectoryLoad(options);
    }
    return;
  }
  if (!options.shouldStart()) return;

  const ownedPromise = options.request()
    .then((value) => {
      if (options.shouldCommit()) options.commit(value);
    })
    .catch(() => {
      options.onError?.();
    })
    .finally(() => {
      if (options.inFlight.get(options.directory) === ownedPromise) {
        options.inFlight.delete(options.directory);
      }
    });
  options.inFlight.set(options.directory, ownedPromise);
  await ownedPromise;
};

export class AsyncTaskLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

export const sortDirectoriesByDepth = (directories: readonly string[]): string[] => (
  [...new Set(directories)].sort((left, right) => (
    left.split('/').length - right.split('/').length || left.localeCompare(right)
  ))
);

export const loadDirectoriesInDepthBatches = async (
  directories: readonly string[],
  load: (directory: string) => Promise<void>,
  isCurrent: () => boolean,
  batchSize = 3,
): Promise<void> => {
  const sorted = sortDirectoriesByDepth(directories);
  for (let index = 0; index < sorted.length && isCurrent(); index += batchSize) {
    await Promise.all(sorted.slice(index, index + batchSize).map(load));
  }
};
