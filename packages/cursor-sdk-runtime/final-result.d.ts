/** Private ordinal witness; SDK conversation text never crosses this boundary. */
export type CursorFinalTextWitness = { assistantOrdinal: number; priorNonempty: number };
export function cursorFinalText(result: unknown, run: unknown): Promise<{finalText?: string; finalTextWitness?: CursorFinalTextWitness}>;
export function cursorFinalTextTarget(witness: unknown, streamedCount: number): number;
