import { describe, expect, it, vi } from 'vitest';
import plugin from './devryan-openai-oauth.mjs';
const siwcPolicy = plugin.siwcPolicy;
const request = body => new Request('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify(body) });
const event = (type, fields = {}) => `data: ${JSON.stringify({ type, ...fields })}\n\n`;
const completed = event('response.completed', { response: { status: 'completed' } });
const stream = text => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
const access = async () => ({ accessToken: 'fixture-access' });
describe('physical SIWC policy', () => {
  it('encodes context and local tools, strips unsupported controls before sending', async () => {
    const send = vi.fn(async () => stream(completed));
    const transport = plugin.testing.createTransport(access, send);
    const source = { model: 'account-model', input: [{ type: 'message', role: 'system', content: 'policy' }, { role: 'user', content: 'hello' }], tools: [{ type: 'function', name: 'local', parameters: {} }], store: true, stream: false, temperature: 1, previous_response_id: 'old', max_output_tokens: 3, metadata: { private: true }, prompt_cache_retention: '24h' };
    expect(await (await transport(request(source))).text()).toBe(completed);
    const sent = JSON.parse(send.mock.calls[0][1].body);
    expect(sent).toEqual({ model: 'account-model', input: [{ type: 'message', role: 'developer', content: 'policy' }, { role: 'user', content: 'hello' }, {type:'additional_tools',tools:source.tools}], store: false, stream: true });
  });
  it.each(['image_generation', 'file_search', 'code_interpreter', 'computer_use_preview', 'mcp', 'tool_search', 'programmatic_tool_calling'])('refuses %s before credential or provider traffic', async type => {
    const getAccess = vi.fn(access), send = vi.fn();
    await expect(plugin.testing.createTransport(getAccess, send)(request({ input: [], tools: [{ type }] }))).rejects.toMatchObject({ code: 'chatgpt_siwc_tool_unsupported' });
    expect(getAccess).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it.each([event('response.output_text.delta', { delta: 'partial' }), event('response.incomplete'), event('response.failed'), event('error'), completed + event('response.failed'), event('response.created',{error:{code:'fixture'}}) + completed, event('response.created',{response:{status:'incomplete'}}) + completed])('rejects incomplete or late-failed streams', async text => {
    const response = await plugin.testing.createTransport(access, async () => stream(text))(request({ input: [] }));
    await expect(response.text()).rejects.toMatchObject({ code: expect.stringMatching(/^chatgpt_siwc_stream_/) });
  });
  it('preserves supported custom, namespace, additional tools and account-gated web search', () => {
    const tool = {type:'custom',name:'local',format:{type:'text'}}, namespace = {type:'namespace',name:'files',tools:[tool]}, additional = {type:'additional_tools',tools:[tool]}, web = {type:'web_search'};
    const sent=JSON.parse(siwcPolicy.encodeBody({input:[additional],tools:[namespace,web],instructions:'policy'}));
    expect(sent).toEqual({input:[additional],tools:[namespace,web],instructions:'policy',store:false,stream:true});
    expect(() => siwcPolicy.encodeBody({input:[{type:'additional_tools',tools:[{type:'image_generation'}]}]})).toThrow('chatgpt_siwc_tool_unsupported');
  });
  it.each([{input:'string'}, {input:[{role:'user',content:[{type:'input_audio',data:'opaque'}]}]}, {input:[],tool_choice:{type:'image_generation'}}, {input:[],tool_choice:{type:'allowed_tools',tools:[{type:'mcp'}]}}])('refuses incompatible context or tool choice', async body => {
    const send = vi.fn(), getAccess=vi.fn(access);
    await expect(plugin.testing.createTransport(getAccess,send)(request(body))).rejects.toBeDefined();
    expect(send).not.toHaveBeenCalled(); expect(getAccess).not.toHaveBeenCalled();
  });
  it('handles split UTF-8/CRLF events, delivers deltas, holds completion until EOF', async () => {
    let source;
    const response=siwcPolicy.completedResponse(new Response(new ReadableStream({start(controller){source=controller;}}),{headers:{'content-type':'text/event-stream'}}));
    const reader=response.body.getReader(), encoder=new TextEncoder();
    const delta=event('response.output_text.delta',{delta:'héllo'}).replaceAll('\n','\r\n');
    const bytes=encoder.encode(delta);
    source.enqueue(bytes.slice(0,50)); source.enqueue(bytes.slice(50));
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('héllo');
    source.enqueue(encoder.encode(completed));
    let settled=false;
    const final=reader.read().then(value=>{settled=true;return value;});
    await Promise.resolve(); expect(settled).toBe(false);
    source.close(); expect(new TextDecoder().decode((await final).value)).toBe(completed);
    expect((await reader.read()).done).toBe(true);
  });
  it('bounds an issuer that leaves a completed stream open', async () => {
    vi.useFakeTimers();
    try {
      const response=siwcPolicy.completedResponse(new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(completed));}}),{headers:{'content-type':'text/event-stream'}}));
      const result=response.text().then(()=>true,error=>error.code);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await result).toBe('chatgpt_siwc_stream_interrupted');
    } finally { vi.useRealTimers(); }
  });
  it('fails a source interruption even after a completed event', async () => {
    const response=siwcPolicy.completedResponse(new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(completed));controller.error(new Error('fixture interrupted'));}}),{headers:{'content-type':'text/event-stream'}}));
    await expect(response.text()).rejects.toThrow('fixture interrupted');
  });
  it('rejects malformed requests and non-Responses endpoints before credentials', async () => {
    const getAccess=vi.fn(access),send=vi.fn(),transport=plugin.testing.createTransport(getAccess,send);
    await expect(transport('https://api.openai.com/v1/models')).rejects.toBeDefined();
    await expect(transport('https://api.openai.com/v1/responses',{method:'POST',body:'bad json'})).rejects.toMatchObject({code:'chatgpt_siwc_request_invalid'});
    expect(getAccess).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('keeps API-key configuration and image tools outside the SIWC policy', async () => {
    const config={provider:{openai:{options:{fetch:'existing-key-transport'}}}};
    const hooks=await plugin({}, {environment:{DEVRYAN_BOT_GATEWAY_URL:'http://egress:43121',DEVRYAN_BOT_RUNTIME_TOKEN:'a'.repeat(43)},fetchImpl:async()=>Response.json({protocol:1,oauth:false})});
    await hooks.config(config); await hooks['tool.execute.before']({tool:'gpt_imagegen'});
    expect(config.provider.openai.options.fetch).toBe('existing-key-transport');
  });
  it('refuses image tools before scoped auth-file mutation', async () => {
    const hooks = await plugin({}, { environment: { DEVRYAN_BOT_GATEWAY_URL: 'http://egress:43121', DEVRYAN_BOT_RUNTIME_TOKEN: 'a'.repeat(43) }, fetchImpl: async () => Response.json({ protocol: 1, oauth: true }) });
    await expect(hooks['tool.execute.before']({ tool: 'gpt_imagegen' })).rejects.toMatchObject({ code: 'chatgpt_siwc_tool_unsupported' });
  });
});
