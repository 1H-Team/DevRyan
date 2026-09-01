import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';

const denied = () => Object.assign(new Error('Speech endpoint is not allowed'), {
  code: 'bot_voice_endpoint_invalid', statusCode: 400,
});
const privateV4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
]) privateV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const reservedV6 = new net.BlockList();
reservedV6.addSubnet('2001::', 23, 'ipv6');
reservedV6.addSubnet('2001:db8::', 32, 'ipv6');
reservedV6.addSubnet('2002::', 16, 'ipv6');
const hostOf = (url) => url.hostname.replace(/^\[|\]$/g, '');
const isLoopback = (hostname) => ['127.0.0.1', '::1', 'localhost'].includes(hostname);
const isPublic = (address) => net.isIP(address) === 4
  ? !privateV4.check(address, 'ipv4')
  : net.isIP(address) === 6 && globalV6.check(address, 'ipv6') && !reservedV6.check(address, 'ipv6');

export const resolveBotVoiceAddress = async (hostname, lookup = dns.lookup) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublic(address))) throw denied();
  return addresses[0];
};

export const normalizeBotVoiceBaseUrl = (value) => {
  if (typeof value !== 'string' || value.length > 2_048 || /[\s\\]/u.test(value)) throw denied();
  let url;
  try { url = new URL(value); } catch { throw denied(); }
  const hostname = hostOf(url);
  if (url.username || url.password || url.search || url.hash
    || !['https:', 'http:'].includes(url.protocol)
    || (!isLoopback(hostname) && url.protocol !== 'https:')
    || (!isLoopback(hostname) && net.isIP(hostname) && !isPublic(hostname))
    || (!isLoopback(hostname) && !net.isIP(hostname)
      && (!hostname.includes('.') || /\.(?:local|internal|localhost)$/i.test(hostname)))) throw denied();
  // Resolve localhost deterministically; no hosts-file or DNS rebinding path.
  if (hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.toString().replace(/\/+$/, '');
};

// DNS validation is done inside the socket lookup callback. The chosen address
// is the one used by that request; a later DNS resolution cannot rebind it.
export const createBotVoiceFetch = ({ lookup = dns.lookup } = {}) => async (value, options = {}) => {
  const url = new URL(value);
  normalizeBotVoiceBaseUrl(url.toString());
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: options.method || 'GET',
      headers: options.headers,
      signal: options.signal,
      agent: false,
      lookup: (hostname, lookupOptions, callback) => {
        resolveBotVoiceAddress(hostname, lookup).then((candidate) => {
          if (lookupOptions.all) callback(null, [candidate]);
          else callback(null, candidate.address, candidate.family);
        }, () => callback(denied()));
      },
    }, (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      try {
        const bodyless = [204, 205, 304].includes(response.statusCode);
        if (bodyless) response.resume();
        resolve(new Response(bodyless ? null : Readable.toWeb(response), { status: response.statusCode, headers }));
      } catch {
        response.destroy();
        reject(new Error('Speech provider response is invalid'));
      }
    });
    request.on('error', reject);
    request.end(options.body);
  });
};
