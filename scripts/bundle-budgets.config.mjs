export default {
  schemaVersion: 1,
  rootDir: '..',
  builds: [
    {
      id: 'web-main',
      distDir: 'packages/web/dist',
      manifestPath: '.vite/manifest.json',
      entry: 'index.html',
      immediateDynamicRoots: [{ name: 'main' }],
      prohibitedStartupChunks: [
        { id: 'file-type-sprite-chunk', identities: ['sprite'] },
        // refractor + every Prism grammar; web pins react-syntax-highlighter to
        // the vendor-syntax manual chunk (see packages/web/vite-chunking.ts).
        { id: 'syntax-highlighter-chunk', identities: ['vendor-syntax'] },
        { id: 'markdown-renderer-chunk', identities: ['MarkdownRendererImpl'] },
        { id: 'mini-chat-app-chunk', identities: ['renderElectronMiniChatApp'] },
        { id: 'terminal-view-chunk', identities: ['TerminalView'] },
        {
          id: 'lazy-top-level-view-chunks',
          identities: ['DiffView', 'FilesView', 'GitView', 'MultiRunWindow', 'PlanView', 'SettingsView'],
        },
        {
          id: 'lazy-session-dialog-chunks',
          identities: ['ConfirmDialogs', 'NewWorktreeDialog', 'ProjectEditDialog', 'ScheduledTasksDialog', 'SessionSearchDialog'],
        },
        {
          id: 'lazy-chat-dialog-chunks',
          identities: ['AgentHandoffDialog', 'GitHubIssuePickerDialog', 'GitHubPrPickerDialog', 'StashDialog', 'TimelineDialog'],
        },
      ],
      baseline: {
        rawBytes: 17_286_557,
        gzipBytes: 4_006_124,
      },
      // Measured 4,493,412 raw / 1,309,883 gzip; budgets add 5% headroom.
      budgets: {
        rawBytes: 4_718_082,
        gzipBytes: 1_375_377,
      },
      minimumGzipReductionPercent: 30,
    },
    {
      id: 'vscode-chat',
      distDir: 'packages/vscode/dist/webview',
      manifestPath: '.vite/manifest.json',
      entry: 'index.html',
      immediateDynamicRoots: [{ name: 'renderVSCodeApp' }],
      prohibitedStartupChunks: [
        { id: 'file-type-sprite-chunk', identities: ['sprite'] },
        // refractor + every Prism grammar, split out by LazySyntaxHighlighter;
        // this build has no manual chunks, so it keeps the module's own name.
        { id: 'syntax-highlighter-chunk', identities: ['prism'] },
        { id: 'markdown-renderer-chunk', identities: ['MarkdownRendererImpl'] },
        { id: 'tool-output-dialog-chunk', identities: ['ToolOutputDialog'] },
        { id: 'lazy-vscode-view-chunks', identities: ['AgentManagerView', 'SettingsView'] },
        {
          id: 'lazy-session-dialog-chunks',
          identities: ['ConfirmDialogs', 'NewWorktreeDialog', 'ProjectEditDialog', 'ScheduledTasksDialog', 'SessionSearchDialog'],
        },
        {
          id: 'lazy-chat-dialog-chunks',
          identities: ['AgentHandoffDialog', 'GitHubIssuePickerDialog', 'GitHubPrPickerDialog', 'StashDialog', 'TimelineDialog'],
        },
      ],
      baseline: {
        rawBytes: 5_424_732,
        gzipBytes: 1_575_500,
      },
      // Measured 3,664,849 raw / 1,051,760 gzip; budgets add 5% headroom.
      budgets: {
        rawBytes: 3_848_091,
        gzipBytes: 1_104_348,
      },
      minimumGzipReductionPercent: 5,
    },
  ],
};
