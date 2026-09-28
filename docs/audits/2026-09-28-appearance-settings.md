# Settings → Appearance redesign verification — 2026-09-28

## Result

Settings → Appearance is one page with eight titled sections: Theme, Typography, Layout, Conversation, Code & Files, Composer, Regional, and Mobile & Install. The page no longer mixes untitled chat controls between theme and localization rows. Every setting now shows a one-line description instead of relying on tooltips. Numbers show their units. Single choices use option cards, and diff layout, diff view mode, Mermaid rendering, and user-message rendering have small illustrations. Themes are swatch cards painted from each theme's own colors.

The preview is a static mock conversation that reads the live CSS variables for theme, fonts, text size, and density, plus a chat-width minimap. It uses a sticky side column when the page container is at least 56rem wide, and sits behind a Show Preview toggle otherwise.

Persistence paths are unchanged. `appearance/appearance.source.test.ts` pins the direct `updateDesktopSettings` writes. Reset buttons, number steppers, the slider, switches, and option cards are all disabled or read-only for viewers without Appearance edit permission.

## Checks

The live checks used the `web-hmr` dev server, which has an isolated temporary data directory, in the Claude browser pane:

- **Desktop, dark and light, 1280×800.**
  - All eight sections render in DOM order with `h3` headings.
  - Every radio group, switch, number input, and the slider has an accessible name and description.
  - There are no `role="button"` wrappers and no React warnings.
  - The preview stays pinned while the settings column scrolls.
- **Interactions.** Each of these changes updated the page and the preview together:
  - Switching Color Mode to Light and picking Nord Light.
  - Setting Interface Font Size to 125%.
  - Setting Chat Width to 1008px from the keyboard (the slider reads "1008 pixels").
  - Switching User Message Rendering to Plain Text.

  After a reload, font size, chat width, message rendering, and color mode were still set. The reset buttons restored the defaults.
- **Touch, 390×844.**
  - Color-mode chips and theme cards wrap to two columns.
  - Desktop-only rows (Interface Font, Interface Font Size, Chat Width, Terminal Quick Keys) are hidden.
  - Show Mobile Status Bar appears, and Input Bar Offset loses its "Mobile Only" badge.
  - The preview opens and closes from its toggle, without the chat-width minimap.
- **Bundle.** `bun run build:web && bun run bundle:check` passed: startup gzip was 1,426,727 of the 1,456,388-byte budget. The Appearance code loads in the lazy `VisualSectionContent` chunk (17 KB gzip).

## Limits

- **Theme persistence to the server was not verified.** The isolated dev server answered every `PUT /api/config/settings` with 403 because its local owner was not enrolled. The theme context therefore resynced the stored light theme back to Default after a reload. The request payload was correct (`lightThemeId: "nord-light"`), and the previous theme selects called the same context setter.
- **Mobile Keyboard Behavior was not shown in the touch emulation.** The emulated device kept a Mac platform with touch points, which `supportsMobileKeyboardResizeContent` treats as iOS. It appears on desktop web.
- **Read-only mode was checked only by unit tests.** A live check needs a restricted principal in Supabase mode, which this environment did not have.
