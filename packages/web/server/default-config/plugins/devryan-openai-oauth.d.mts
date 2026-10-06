declare const plugin: {
  (input: unknown, options?: unknown): Promise<unknown>;
  readonly siwcPolicy: {
    encodeRequest(request: Request): Promise<string>;
    encodeBody(value: unknown): string;
    completedResponse(response: Response): Response;
  };
};
export default plugin;
