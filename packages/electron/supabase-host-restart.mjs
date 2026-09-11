// Called only after the web owner closes admission and proves its work idle.
// Do not use the best-effort quit path: failed draining must not force an exit.
export async function restartSupabaseHost({ handle, coordinator, serviceMode, relaunch, exit, onStopped }) {
  if (typeof handle?.stop !== 'function') throw new Error('The owned web runtime is unavailable');
  await handle.stop({ exitProcess: false });
  await coordinator?.release();
  onStopped();
  if (serviceMode) {
    // Both existing LaunchAgent definitions use KeepAlive/SuccessfulExit=false.
    exit(1);
  } else {
    relaunch();
    exit(0);
  }
}
