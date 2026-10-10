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
  it.each([event('response.output_text.delta', { delta: 'partial' }), event('response.created',{error:{code:'fixture'}}) + completed, event('response.created',{response:{status:'incomplete'}}) + completed])('rejects interrupted or inconsistent streams', async text => {
    const response = await plugin.testing.createTransport(access, async () => stream(text))(request({ input: [] }));
    await expect(response.text()).rejects.toMatchObject({ code: expect.stringMatching(/^chatgpt_siwc_stream_/) });
  });
  it.each(['response.failed', 'response.incomplete', 'response.cancelled', 'error'])('preserves %s and provider code/parameter for the native parser', async type => {
    const failure = event(type, { response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', param: 'tools', message: 'fixture failure' } } });
    const delta = event('response.output_text.delta', { delta: 'partial' });
    for (const prefix of ['', delta]) {
      const response = siwcPolicy.completedResponse(stream(prefix + failure + completed));
      expect(await response.text()).toBe(prefix + failure);
    }
  });
  it('ignores null and comment keepalives without hiding malformed events', async () => {
    expect(await siwcPolicy.completedResponse(stream(': ping\n\ndata: null\n\ndata: : keepalive\n\n' + completed)).text()).toBe(completed);
    for (const invalid of ['data: nope\n\n', 'data: []\n\n', 'data: [DONE]\n\n']) {
      await expect(siwcPolicy.completedResponse(stream(invalid)).text()).rejects.toBeDefined();
    }
  });
  it.each([undefined, 'TEXT/EVENT-STREAM; charset=utf-8'])('validates SSE when its content type is %s', async contentType => {
    const response = siwcPolicy.completedResponse(new Response(new TextEncoder().encode(completed), {
      headers: contentType ? { 'content-type': contentType } : {},
    }));
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe(completed);
  });
  it('still refuses non-SSE bodies and incomplete streams when the content type is absent', async () => {
    for (const body of ['{"error":"not SSE"}', 'data: nope\n\n', event('response.created')]) {
      await expect(siwcPolicy.completedResponse(new Response(new TextEncoder().encode(body))).text()).rejects.toBeDefined();
    }
    expect(() => siwcPolicy.completedResponse(Response.json({ error: 'not SSE' }))).toThrow('chatgpt_siwc_stream_required');
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
  it('handles split UTF-8/CRLF events and completes without waiting for EOF', async () => {
    let source;
    const cancel = vi.fn();
    const response = siwcPolicy.completedResponse(new Response(new ReadableStream({ start(controller) { source = controller; }, cancel }), { headers: { 'content-type': 'text/event-stream' } }));
    const reader = response.body.getReader(), encoder = new TextEncoder();
    const delta = event('response.output_text.delta', { delta: 'héllo' }).replaceAll('\n', '\r\n');
    const bytes = encoder.encode(delta), utf8 = bytes.indexOf(0xc3);
    source.enqueue(bytes.slice(0, utf8 + 1)); source.enqueue(bytes.slice(utf8 + 1));
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('héllo');
    source.enqueue(encoder.encode(completed));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(completed);
    expect((await reader.read()).done).toBe(true);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });
  it('stops at completion and does not reinterpret trailing frames', async () => {
    expect(await siwcPolicy.completedResponse(stream(completed + event('response.failed'))).text()).toBe(completed);
  });
  it('propagates reader cancellation to the provider source', async () => {
    const cancel = vi.fn();
    const response = siwcPolicy.completedResponse(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/event-stream' } }));
    await response.body.cancel();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });
  it('fails a source interruption before completion', async () => {
    const response = siwcPolicy.completedResponse(new Response(new ReadableStream({ start(controller) { controller.error(new Error('fixture interrupted')); } }), { headers: { 'content-type': 'text/event-stream' } }));
    await expect(response.text()).rejects.toThrow('fixture interrupted');
  });
  it('keeps the frame size bound', async () => {
    await expect(siwcPolicy.completedResponse(stream('data: ' + 'x'.repeat(1024 * 1024))).text()).rejects.toMatchObject({ code: 'chatgpt_siwc_stream_invalid' });
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
