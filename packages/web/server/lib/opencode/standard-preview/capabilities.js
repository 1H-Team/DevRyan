export const STANDARD_PREVIEW_CAPABILITIES = Object.freeze({
  chat: true, sessions: true, files: true, providerApiKey: true,
  revert: false, nativeExecution: false, managedChildTasks: false, providerOAuth: false,
  bots: false, browser: false, media: false, terminal: false,
  share: false, mcpOAuth: false, sessionShell: false, lsp: false, messageEdit: false,
});

export const previewUnavailable = capability => Object.assign(new Error(`${capability} is unavailable in the Windows desktop preview`), {
  code: 'capability_unavailable', statusCode: 501, capability,
});
