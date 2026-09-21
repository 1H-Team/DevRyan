export function parsePushResult(output, directory) {
  const pushed = [];
  for (const line of output.split('\n')) {
    const match = /^([ =*+!\-])\t([^\t]*):([^\t]*)\t(.*)$/.exec(line);
    if (!match || match[1] === '!') continue;
    pushed.push({ local: match[2], remote: match[3], status: match[1], summary: match[4] });
  }
  return { success: true, pushed, repo: directory, ref: pushed.length === 1 ? pushed[0].remote : null };
}

export function pushOptionArgs(options) {
  if (Array.isArray(options)) return [...options];
  if (!options || typeof options !== 'object') return [];
  return Object.entries(options).flatMap(([key, value]) => value == null ? [key] : [`${key}=${value}`]);
}
