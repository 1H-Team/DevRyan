import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import {
  createDiagnosticsExport,
  writeDiagnosticsZip,
  type DiagnosticsExportScope,
} from '@openchamber/harness-runtime';
import yazl from 'yazl';
import type { BridgeResponse } from './bridge';
import { getVsCodeHarnessRuntime } from './harness-runtime-access';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type WritableArchive = {
  outputStream: NodeJS.ReadableStream;
};

const DIAGNOSTICS_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const cleanupExpiredDiagnosticsTemps = async (destination: string): Promise<void> => {
  const directory = path.dirname(destination);
  const prefix = `.${path.basename(destination)}.diagnostics-`;
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.tmp')) continue;
    const candidate = path.join(directory, entry.name);
    const stat = await fs.promises.stat(candidate).catch(() => null);
    if (!stat || Date.now() - stat.mtimeMs < DIAGNOSTICS_TEMP_MAX_AGE_MS) continue;
    await fs.promises.unlink(candidate).catch(() => undefined);
  }
};

const normalizeScope = (payload: unknown): DiagnosticsExportScope => {
  if (payload && typeof payload === 'object' && (payload as { scope?: unknown }).scope === 'task') {
    const sessionID = String((payload as { sessionID?: unknown }).sessionID || '').trim();
    if (!sessionID) throw new Error('sessionID is required for a task diagnostics export');
    const directory = String((payload as { directory?: unknown }).directory || '').trim();
    return {
      scope: 'task',
      sessionID,
      directory: directory || undefined,
    };
  }
  return { scope: 'runtime' };
};

const saveArchive = async (
  archive: WritableArchive,
  destination: string,
): Promise<void> => {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await cleanupExpiredDiagnosticsTemps(destination);
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.diagnostics-${crypto.randomUUID()}.tmp`,
  );
  const output = fs.createWriteStream(temporary, { mode: 0o600, flags: 'wx' });
  await new Promise<void>((resolve, reject) => {
    archive.outputStream.once('error', reject);
    output.once('error', reject);
    output.once('close', resolve);
    archive.outputStream.pipe(output);
  }).catch(async (error) => {
    await fs.promises.unlink(temporary).catch(() => undefined);
    throw error;
  });
  try {
    const handle = await fs.promises.open(temporary, 'r+');
    try {
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temporary, destination);
    const parentHandle = await fs.promises.open(path.dirname(destination), 'r').catch(() => null);
    if (parentHandle) {
      try {
        await parentHandle.sync().catch(() => undefined);
      } finally {
        await parentHandle.close();
      }
    }
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => undefined);
    throw error;
  }
};

export async function handleDiagnosticsBridgeMessage(
  message: BridgeMessageInput,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;
  const runtime = getVsCodeHarnessRuntime();

  if (type === 'api:diagnostics/status') {
    if (!runtime) return { id, type, success: false, error: 'Diagnostics runtime is unavailable' };
    return { id, type, success: true, data: await runtime.getStatus() };
  }

  if (type === 'api:diagnostics/clear') {
    if (!runtime) return { id, type, success: false, error: 'Diagnostics runtime is unavailable' };
    return { id, type, success: true, data: await runtime.journal.clear() };
  }

  if (type === 'api:diagnostics/sanitize') {
    if (!runtime) return { id, type, success: false, error: 'Diagnostics runtime is unavailable' };
    const text = payload && typeof payload === 'object'
      ? String((payload as { text?: unknown }).text || '')
      : '';
    if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) {
      return { id, type, success: false, error: 'Diagnostics text is too large' };
    }
    return {
      id,
      type,
      success: true,
      data: { text: runtime.sanitizer.sanitizeText(text) },
    };
  }

  if (type !== 'api:diagnostics/export') return null;
  if (!runtime) return { id, type, success: false, error: 'Diagnostics runtime is unavailable' };

  const scope = normalizeScope(payload);
  const bundle = await createDiagnosticsExport({
    journal: runtime.journal,
    sanitizer: runtime.sanitizer,
    scope,
    receipts: await runtime.getWorktreeReceipts(),
    evidence: await runtime.getEvidenceRecords(scope),
  });
  const selected = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', bundle.fileName)),
    filters: { 'ZIP archive': ['zip'] },
    saveLabel: 'Export Diagnostics',
    title: scope.scope === 'task' ? 'Export Task Diagnostics' : 'Export Runtime Diagnostics',
  });
  if (!selected) {
    return {
      id,
      type,
      success: true,
      data: { cancelled: true, fileName: bundle.fileName },
    };
  }

  const archive = await writeDiagnosticsZip(bundle, {
    createArchive: () => new yazl.ZipFile(),
  }) as WritableArchive;
  await saveArchive(archive, selected.fsPath);
  return {
    id,
    type,
    success: true,
    data: {
      cancelled: false,
      fileName: path.basename(selected.fsPath),
    },
  };
}
