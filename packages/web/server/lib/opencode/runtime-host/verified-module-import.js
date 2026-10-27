/**
 * Imports exactly the bytes a caller has already verified, never the file again.
 * Node takes them as a data: URL. Bun rejects module names over about 4 KiB
 * (NameTooLong), so it gets an in-memory blob: URL, which Node cannot import.
 */
export async function importVerifiedModuleBytes(bytes){
 if(!process.versions.bun)return import('data:text/javascript;base64,'+bytes.toString('base64'));
 const url=URL.createObjectURL(new Blob([bytes],{type:'text/javascript'}));
 try{return await import(url);}finally{URL.revokeObjectURL(url);}
}
