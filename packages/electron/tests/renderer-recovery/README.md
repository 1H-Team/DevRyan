# Renderer exit acceptance

Run `node packages/electron/tests/renderer-recovery/run.mjs` from the repository
root on a host with the pinned Electron executable available.

The disposable, network-blocked Electron window first exits through its test-only
preload with code zero, reproducing the observed `clean-exit`. It verifies that the
production recovery controller reloads the same document. It then force-crashes
the renderer, checks that automatic reloads stop, and accepts the injected native
dialog response to verify manual recovery. The unit suite separately covers
shutdown, stale actions, navigation, timeouts, and failures.

The fixture isolates Chromium storage, logs, crash files, and keychain access,
starts no DevRyan server, and never reads installed-app data or credentials. The
runner stops only its child and removes its temporary files on success or failure.
Dialog choices are injected; this is lifecycle acceptance, not native-dialog
appearance or signed-package acceptance.
