# Session creation visual fixture

The fixture mounts the real `SessionCreationStatus` with the real creation
attempt store. Only session selection and the remote creation response are
simulated. It never connects to a provider or the user's runtime. Use the
separately packaged Electron visual shell with
`DEVRYAN_VISUAL_FIXTURE_URL=http://127.0.0.1:4191`.

Run `bunx vite --config tests/visual-session-creation/vite.config.ts`.
Verify that preparation/creation shows no banner, while unknown and late-created
outcomes retain the composer, session navigation, and explicit retry confirmation.
This is a component/native-renderer check, not an end-to-end hosted ownership test.
