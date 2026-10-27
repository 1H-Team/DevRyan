export interface NativeResultDeliveryDiagnostic {
  sessionID: string; messageID: string; callID: string;
  payload: Readonly<Record<string, string | number | boolean>>;
}
export function createNativeResultDeliveryObserver(onDiagnostic?: (event: NativeResultDeliveryDiagnostic) => void):
  (scope: {rootSessionId: string}, invocation: {messageID: string; callID: string}, output: unknown) => void;
