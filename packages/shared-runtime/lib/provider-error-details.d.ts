export declare const isSafeProviderCode: (value: unknown) => value is string;
export declare const isSafeProviderParam: (value: unknown) => value is string;
export declare const isSafeErrorType: (value: unknown) => value is string;
export declare const providerErrorDetails: (body: unknown) => { providerCode?: string; providerParam?: string };
