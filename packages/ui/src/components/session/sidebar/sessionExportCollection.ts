import type { Session } from '@opencode-ai/sdk/v2';
import type { ChildSessionExport } from '@/lib/exportSession';
import type { SessionNode } from './types';

export class SessionExportLoadError extends Error {}

type ExportRecords = ChildSessionExport['records'];

/**
 * Loads exported history from the directory the row reads its records from.
 * Every session in an export, root and children, loads and reads through the
 * same directory, and an unrenderable session fails instead of exporting
 * whatever partial transcript happens to be cached.
 */
export type SessionExportSource = {
  directory: string;
  ensureRenderable: (target: { directory: string; sessionID: string }) => Promise<boolean>;
  readRecords: (sessionID: string) => ExportRecords;
};

export async function loadSessionExportRecords(source: SessionExportSource, sessionID: string): Promise<ExportRecords> {
  const renderable = await source.ensureRenderable({ directory: source.directory, sessionID });
  if (!renderable) throw new SessionExportLoadError('The session history could not be loaded.');
  return source.readRecords(sessionID);
}

const countNodes = (node: SessionNode): number => 1 + node.children.reduce((total, child) => total + countNodes(child), 0);

export async function collectChildSessionExports(
  source: SessionExportSource & { describe: (session: Session) => { title: string; agent?: string } },
  children: SessionNode[],
): Promise<{ children: ChildSessionExport[]; skipped: number }> {
  const results: ChildSessionExport[] = [];
  let skipped = 0;
  for (const child of children) {
    let records: ExportRecords;
    try {
      records = await loadSessionExportRecords(source, child.session.id);
    } catch {
      skipped += countNodes(child);
      continue;
    }
    const grandChildren = await collectChildSessionExports(source, child.children);
    skipped += grandChildren.skipped;
    results.push({ ...source.describe(child.session), records, children: grandChildren.children });
  }
  return { children: results, skipped };
}
