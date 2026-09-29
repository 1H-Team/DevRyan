export function createSessionActivityGate(): {
  enter(ids: string[]): () => void;
  assert(ids: string[]): void;
  run<T>(ids: string[], action: () => Promise<T>): Promise<T>;
  hold(ids: string[]): () => void;
  select(clientID: string, sessionID: string | null, revision?: number, committed?: boolean): void;
  connect(req: { originalUrl?: string; url?: string; headers?: Record<string, string | string[] | undefined> }): () => void;
  selections(): Set<string>;
};
