// `/workspace/Shared/<channel>/<message>/<file>` is where a shared file lives on
// the computer; members only need to know it is in Shared. The exact path stays
// in the tooltip for anyone who wants to tell the Bot where to look.
export const friendlyComputerPath = (computerPath: string): string => {
  const segments = computerPath.replace(/^\/?workspace\//u, '').split('/').filter(Boolean);
  if (segments.length === 0) return computerPath;
  if (segments[0] === 'Shared' && segments.length > 2) return `Shared / … / ${segments[segments.length - 1]}`;
  return segments.join(' / ');
};
