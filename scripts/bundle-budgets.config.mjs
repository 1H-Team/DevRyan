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
        { id: 'markdown-renderer-chunk', identities: ['MarkdownRendererImpl', 'vendor-markdown'] },
        { id: 'tool-output-dialog-chunk', identities: ['ToolOutputDialog'] },
        { id: 'assistant-image-gallery-chunk', identities: ['GeneratedImageResult'] },
        { id: 'mini-chat-app-chunk', identities: ['renderElectronMiniChatApp'] },
        { id: 'terminal-view-chunk', identities: ['TerminalView'] },
        { id: 'usage-gated-bot-panels', identities: ['BotOperationsRail', 'BotSidebarSection'] },
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
      // Measured 4,726,549 raw / 1,387,036 gzip; budgets add 5% headroom.
      budgets: {
        rawBytes: 4_962_877,
        gzipBytes: 1_456_388,
      },
      minimumGzipReductionPercent: 30,
    },
  ],
};
