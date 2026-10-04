import { pathToFileURL } from 'node:url';

// The actual native package's Prepared/wire controls lane owns current proof.
export async function probeProviderDefault() {
  throw Object.assign(new Error('The v1 provider-default runtime probe is retired; use compiled native v2 controls qualification'),
    { code: 'qa_native_diagnostic_unavailable' });
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await probeProviderDefault();
