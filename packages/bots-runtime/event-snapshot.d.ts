export const BOT_EVENT_MAX_BYTES: number;
export const BOT_SNAPSHOT_MAX_BYTES: number;
export const BOT_SNAPSHOT_PART_CHARS: number;
export const BOT_SNAPSHOT_FORMAT: 'parts-v1';
export const BOT_SNAPSHOT_PART_KIND: 'snapshot.part';
export class BotSnapshotError extends Error {
  constructor(message: string, code?: string, statusCode?: number);
  code: string;
  statusCode: number;
}
export function encodeBotSnapshot(value: unknown): Readonly<{ text: string; bytes: number }>;
export function splitBotSnapshot(text: string): ReadonlyArray<Readonly<{ index: number; total: number; text: string }>>;
export function createBotSnapshotAssembler(): Readonly<{
  reset(): void;
  push(event: unknown): Readonly<{
    id: string;
    sequence: 0;
    kind: 'snapshot';
    payload: Record<string, unknown>;
  }> | null;
}>;
