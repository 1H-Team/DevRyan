export interface DriveRequest { readonly id: string; readonly url: string; readonly body: unknown }
export interface DriveReply { readonly items: readonly unknown[]; readonly reason: string }
export interface DriveController {
  readonly requests: readonly DriveRequest[];
  check(): void;
  setResponder(responder: (request: DriveRequest) => DriveReply | Promise<DriveReply>): Promise<void>;
  disconnect(id: string): Promise<unknown>;
  close(): Promise<void>;
}
export function attachDriveController(endpoint: string, responder: (request: DriveRequest) => DriveReply | Promise<DriveReply>,
  options?: { readonly timeoutMs?: number; readonly maxRequests?: number }): Promise<DriveController>;
