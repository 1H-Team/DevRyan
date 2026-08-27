import dns from 'node:dns/promises';
import net from 'node:net';

const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'host.docker.internal',
  'gateway.docker.internal',
  'kubernetes.default',
  'kubernetes.default.svc',
]);

export class EgressPolicyError extends Error {
  constructor(message = 'Model egress destination is denied', code = 'bot_egress_destination_denied') {
    super(message);
    this.name = 'EgressPolicyError';
    this.code = code;
    this.statusCode = 403;
  }
}

const deny = (message, code) => {
  throw new EgressPolicyError(message, code);
};

const parsePort = (value) => {
  if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) {
    deny('Model egress destination port is invalid', 'bot_egress_destination_invalid');
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    deny('Model egress destination port is invalid', 'bot_egress_destination_invalid');
  }
  return port;
};

const stripIpv6Brackets = (hostname) => (
  hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
);

const renderAuthority = (hostname, port) => (
  hostname.includes(':') ? `[${hostname}]:${port}` : `${hostname}:${port}`
);

export function parseConnectAuthority(authority) {
  if (typeof authority !== 'string' || authority.length === 0 || authority.length > 512
    || /[\u0000-\u0020\u007f]/u.test(authority)) {
    deny('CONNECT authority is invalid', 'bot_egress_destination_invalid');
  }
  let url;
  try {
    url = new URL(`http://${authority}`);
  } catch {
    deny('CONNECT authority is invalid', 'bot_egress_destination_invalid');
  }
  if (!url.hostname || !url.port || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash) {
    deny('CONNECT authority is invalid', 'bot_egress_destination_invalid');
  }
  return Object.freeze({
    hostname: stripIpv6Brackets(url.hostname.toLowerCase().replace(/\.$/, '')),
    port: parsePort(url.port),
  });
}

const ipv4Octets = (address) => {
  if (net.isIP(address) !== 4) return null;
  const octets = address.split('.').map(Number);
  return octets.length === 4 ? octets : null;
};

const isPrivateOrReservedIpv4 = (address) => {
  const octets = ipv4Octets(address);
  if (!octets) return true;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
};

const ipv4MappedAddress = (address) => {
  const lower = address.toLowerCase();
  if (!lower.startsWith('::ffff:')) return null;
  const tail = lower.slice(7);
  if (net.isIP(tail) === 4) return tail;
  const groups = tail.split(':');
  if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const high = Number.parseInt(groups[0], 16);
  const low = Number.parseInt(groups[1], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
};

const isPrivateOrReservedIpv6 = (address) => {
  const lower = address.toLowerCase();
  const mapped = ipv4MappedAddress(lower);
  if (mapped) return isPrivateOrReservedIpv4(mapped);
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('::')) return true;
  const first = Number.parseInt(lower.split(':', 1)[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (lower.startsWith('2001:db8:') || lower === '2001:db8::') return true;
  return false;
};

export function isPublicEgressAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !isPrivateOrReservedIpv4(address);
  if (family === 6) return !isPrivateOrReservedIpv6(address);
  return false;
}

const validateHostnameBoundary = (hostname) => {
  if (!hostname || hostname.length > 253) {
    deny('Model egress hostname is invalid', 'bot_egress_destination_invalid');
  }
  if (net.isIP(hostname)) return;
  if (METADATA_HOSTS.has(hostname) || hostname === 'localhost'
    || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname.endsWith('.internal') || !hostname.includes('.')) {
    deny('Local and sibling destinations are denied');
  }
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)
    || hostname.includes('..')
    || hostname.split('.').some((label) => label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
    deny('Model egress hostname is invalid', 'bot_egress_destination_invalid');
  }
};

const normalizeLookupRows = (rows) => {
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) deny('Model egress destination did not resolve');
  return list.map((row) => {
    if (!row || typeof row.address !== 'string' || ![4, 6].includes(row.family)
      || net.isIP(row.address) !== row.family) {
      deny('Model egress DNS response is invalid');
    }
    return { address: row.address, family: row.family };
  });
};

export async function assertModelDestinationAllowed({
  hostname,
  port,
  allowedHosts,
  lookup = dns.lookup,
} = {}) {
  if (typeof hostname !== 'string' || !Number.isInteger(port)
    || !Array.isArray(allowedHosts) || typeof lookup !== 'function') {
    deny('Model egress policy input is invalid', 'bot_egress_destination_invalid');
  }
  const normalizedHostname = stripIpv6Brackets(hostname.toLowerCase().replace(/\.$/, ''));
  validateHostnameBoundary(normalizedHostname);
  const authority = renderAuthority(normalizedHostname, port);
  if (!allowedHosts.includes(authority)) {
    deny('Destination is not in the active revision allowlist');
  }

  return resolvePublicDestination({
    normalizedHostname,
    port,
    authority,
    lookup,
  });
}

const resolvePublicDestination = async ({ normalizedHostname, port, authority, lookup }) => {

  let addresses;
  if (net.isIP(normalizedHostname)) {
    addresses = [{ address: normalizedHostname, family: net.isIP(normalizedHostname) }];
  } else {
    try {
      addresses = normalizeLookupRows(await lookup(normalizedHostname, { all: true, verbatim: true }));
    } catch (error) {
      if (error instanceof EgressPolicyError) throw error;
      deny('Model egress destination could not be resolved');
    }
  }
  if (addresses.some(({ address }) => !isPublicEgressAddress(address))) {
    deny('Private, loopback, LAN, metadata, and reserved destinations are denied');
  }
  const selected = addresses[0];
  return Object.freeze({
    hostname: normalizedHostname,
    port,
    authority,
    address: selected.address,
    family: selected.family,
    addresses: Object.freeze(addresses.map((row) => Object.freeze({ ...row }))),
  });
};

export async function assertPublicDestinationAllowed({
  hostname,
  port,
  lookup = dns.lookup,
} = {}) {
  if (typeof hostname !== 'string' || !Number.isInteger(port) || typeof lookup !== 'function') {
    deny('Browser egress policy input is invalid', 'bot_egress_destination_invalid');
  }
  const normalizedHostname = stripIpv6Brackets(hostname.toLowerCase().replace(/\.$/, ''));
  validateHostnameBoundary(normalizedHostname);
  return resolvePublicDestination({
    normalizedHostname,
    port,
    authority: renderAuthority(normalizedHostname, port),
    lookup,
  });
}
