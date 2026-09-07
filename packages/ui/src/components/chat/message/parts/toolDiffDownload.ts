/** Called only after a user requests the full patch; never places its contents in the DOM. */
export function downloadToolDiffPatch(source: string): void {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/x-diff;charset=utf-8' }));
  const anchor = document.createElement('a');
  try {
    anchor.href = url;
    anchor.download = 'DevRyan-tool-diff.patch';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Keep the URL alive long enough for web and Electron to consume the download.
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}
