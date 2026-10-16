import type { Writable } from 'node:stream';
export function createCursorWorkerWriter(stdout: Pick<Writable, 'write' | 'on'>): {
  write(event: unknown): Promise<void>;
  readonly failed: boolean;
  report(event: unknown): Promise<void>;
  drain(): Promise<void>;
};
