import type { ScriptedTurn } from './assertions.mjs';

export function sameFileWriterTurn(caseID: string): Omit<ScriptedTurn, 'callID'>;
