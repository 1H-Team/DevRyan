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
      // Measured 5,926,683 raw / 1,746,824 gzip; budgets add 5% headroom.
      budgets: {
        rawBytes: 6_223_018,
        gzipBytes: 1_834_166,
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
      // Measured 5,128,339 raw / 1,496,378 gzip; budgets add 5% headroom.
      budgets: {
        rawBytes: 5_384_756,
        gzipBytes: 1_571_197,
      },
      minimumGzipReductionPercent: 5,
    },
  ],
};
