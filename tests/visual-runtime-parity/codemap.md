# Runtime parity fixture

`fixture.tsx` mounts the real vendored terminal, CodeMirror editor and virtual session list against synthetic local data. It loads no app server, user configuration or provider.

Run `node scripts/qa/runtime-parity.mjs`. The runner owns an isolated Vite server and Electron browser profile and closes both in `finally`. Evidence and a screenshot go under `.cache/runtime-parity-*`. Checks cover keyboard/IME/paste, live versus replay VT replies, scrollback serialization, resize/hidden output, pointer selection, links, 1,000-row windowing/focus/prepend/variable heights, and complete mixed-EOL editor buffers above 250 KB with extension-owned Escape.

This is a browser component check; it does not claim signed installer, remote SSH, screen-reader or mobile-device acceptance.
