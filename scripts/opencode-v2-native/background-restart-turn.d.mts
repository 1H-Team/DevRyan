import type { DriveRequest, DriveReply } from './drive-controller.mjs';
export function backgroundRestartTurn(caseID: string, input: unknown, options?: { readonly resumeShellID?: string }): {
  readonly marker: string; readonly responder: (request: DriveRequest) => Promise<DriveReply>;
  readonly holding: () => { readonly held: boolean; readonly shellID?: string };
  readonly complete: () => { readonly shellID?: string };
};
