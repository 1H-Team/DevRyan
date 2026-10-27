/**
 * Kill switch for prompt-cache preservation across system parts and
 * compaction. `DEVRYAN_SYSTEM_CACHE_PRESERVE=0` restores the earlier request
 * shape: one joined system string without cache markers or metadata, and the
 * compaction anchor as a trailing system part.
 */
export const systemCachePreserved=(environment:Readonly<Record<string,string|undefined>>=process.env)=>
  environment.DEVRYAN_SYSTEM_CACHE_PRESERVE!=='0';
