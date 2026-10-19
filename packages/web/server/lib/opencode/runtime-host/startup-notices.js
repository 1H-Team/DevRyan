/** Process-local record of what startup isolated or deferred instead of
 * refusing. Rows carry codes and identifiers only, never record contents. */
const findings = new Map();
const text = (value, limit) => String(value ?? '').replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, limit);

export function recordStartupFindings(source, rows = [], log = console) {
  for (const row of Array.isArray(rows) ? rows : []) {
    const finding = { source: text(source, 40), code: text(row?.code, 100), scope: text(row?.ledger ?? row?.scope, 64), key: text(row?.key, 160) };
    const id = JSON.stringify(finding);
    if (!finding.code || findings.has(id) || findings.size >= 256) continue;
    findings.set(id, finding);
    log.warn?.(`[runtime-bundle] startup isolated a record instead of refusing: ${id}`);
  }
}

export const readStartupFindings = () => [...findings.values()];
export const resetStartupFindings = () => findings.clear();

/** What the open app tells its owner about a startup that continued. */
export function startupNotices() {
  const rows = readStartupFindings(), upgrade = rows.find(row => row.source === 'bundle_upgrade');
  const dataRoot = rows.find(row => row.source === 'data_root');
  const isolated = rows.filter(row => row.source !== 'bundle_upgrade' && row.source !== 'data_root');
  return [
    ...(dataRoot?.code === 'data_root_merged' ? [{ code: 'data_root_merged', count: 1,
      message: 'DevRyan moved its data from ~/.config/openchamber to ~/.config/devryan. Older files whose names already existed there were kept in a legacy-openchamber folder inside it.' }] : []),
    ...(dataRoot && dataRoot.code !== 'data_root_merged' ? [{ code: 'data_root_kept_in_place', count: 1,
      message: `DevRyan kept using ~/.config/openchamber because the folder could not be moved to ~/.config/devryan (${dataRoot.scope || 'error'}). Your data is unchanged; the move is retried at the next start.` }] : []),
    ...(upgrade ? [{ code: 'startup_upgrade_not_applied', count: 1,
      message: `This release's runtime upgrade was not applied (${upgrade.code}). DevRyan is running on the previous runtime and retries at the next start.` }] : []),
    ...(isolated.length ? [{ code: 'startup_records_isolated', count: isolated.length,
      message: `${isolated.length} stored ${isolated.length === 1 ? 'record was' : 'records were'} set aside at startup instead of blocking it (${[...new Set(isolated.map(row => row.code))].slice(0, 4).join(', ')}). Details are in the application log.` }] : []),
  ];
}
