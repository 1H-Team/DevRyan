import {createOpenCodeClient} from '../../packages/web/server/lib/opencode/opencode-client/index.js';

/** Real public client; the graph test decodes its untrusted HTTP boundary. */
export function readNativeToolCatalog(url,directory,model){
 const client=createOpenCodeClient({getRuntime:()=>({generation:2,baseUrl:url,version:'2.0.24',epoch:1}),
  getAuthHeaders:()=>({authorization:'Bearer '+'a'.repeat(43)})});
 return client.catalog.tools({directory,...model});
}
