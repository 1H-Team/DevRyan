export interface V1NamedError {
  name: string;
  data: { message: string; statusCode?: number; v2Type?: string; reason?: string; providerCode?: string; providerParam?: string };
}
export interface V2StructuredError {
  type: string;
  message: string;
  status?: number;
  response?: { body: string };
}
export interface ToV1ErrorOptions { isContextOverflow?: (message: string) => boolean }
export declare const v1ErrorNameForV2Type: (type: unknown, message: string, options?: ToV1ErrorOptions) => string;
export declare const toV1Error: (error: unknown, options?: ToV1ErrorOptions) => V1NamedError | undefined;
export declare const toV1InterruptError: (reason: unknown) => V1NamedError;
export declare const toV2Error: (error: unknown) => V2StructuredError | undefined;
