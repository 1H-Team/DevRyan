import type { DriveRequest, DriveReply } from './drive-controller.mjs';
export interface ScriptedTurn { readonly marker: string; readonly callID: string;
  readonly responder: (request: DriveRequest) => DriveReply; readonly complete: () => unknown; readonly cancelled?: () => unknown }
export function toolTurn(name: string, input: unknown, caseID: string, options?: { readonly deniedInventory?: boolean }): ScriptedTurn;
export function parallelWriterTurn(caseID: string): Omit<ScriptedTurn, 'callID'>;
export function managedTaskTurn(caseID: string, agent: string): Omit<ScriptedTurn, 'callID'> & {
  readonly childMarker: string; readonly callIDs: { readonly startID: string; readonly waitID: string; readonly writerID: string };
  readonly complete: () => { readonly taskID: string; readonly childWriterCallID: string; readonly childWriterFile: string;
    readonly startResult: unknown; readonly waitResult: unknown };
};
export function backgroundShellTurn(caseID: string, input: unknown): Omit<ScriptedTurn, 'callID'>;
