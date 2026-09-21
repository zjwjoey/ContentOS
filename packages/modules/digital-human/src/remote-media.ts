import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface RemoteMediaAddress { address: string; family: 4 | 6; }
export type RemoteMediaResolver = (hostname: string) => Promise<readonly RemoteMediaAddress[]>;

export interface SafeRemoteMediaFetchOptions {
  fetchImpl?: typeof fetch;
  resolveAll?: RemoteMediaResolver;
  signal?: AbortSignal;
  maxRedirects?: number;
}

export class RemoteMediaSecurityError extends Error {
  readonly code: string;
  readonly retryable = false;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RemoteMediaSecurityError';
    this.code = code;
  }
}

const defaultResolver: RemoteMediaResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family === 6 ? 6 : 4 }));
};

function ipv4Number(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  const [first, second, third, fourth] = octets;
  if (first === undefined || second === undefined || third === undefined || fourth === undefined || octets.some((octet) => octet > 255)) return null;
  return (((first * 256 + second) * 256 + third) * 256 + fourth);
}

function ipv4Blocked(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return true;
  const first = value >>> 24;
  const second = (value >>> 16) & 255;
  const third = (value >>> 8) & 255;
  return first === 0 || first === 10 || first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224;
}

function ipv6Bytes(address: string): Uint8Array | null {
  const value = address.toLowerCase();
  if (value.includes('%')) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const expand = (part: string): number[] => {
    if (!part) return [];
    const groups: number[] = [];
    for (const item of part.split(':')) {
      if (item.includes('.')) {
        const parsed = ipv4Number(item);
        if (parsed === null) return [];
        groups.push((parsed >>> 16) & 0xffff, parsed & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(item)) return [];
        groups.push(Number.parseInt(item, 16));
      }
    }
    return groups;
  };
  const left = expand(halves[0] || '');
  const right = expand(halves.length === 2 ? halves[1] || '' : '');
  if (left.length === 0 && (halves[0] || '').length > 0) return null;
  if (right.length === 0 && halves.length === 2 && (halves[1] || '').length > 0) return null;
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 1 || (halves.length === 1 && left.length !== 8)) return null;
  const groups = halves.length === 2 ? [...left, ...Array.from({ length: missing }, () => 0), ...right] : left;
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => { bytes[index * 2] = group >>> 8; bytes[index * 2 + 1] = group & 255; });
  return bytes;
}

function ipv6Prefix(bytes: Uint8Array, expected: number[], bits: number): boolean {
  let remaining = bits;
  for (let index = 0; remaining > 0; index += 1) {
    const width = Math.min(8, remaining);
    const mask = (0xff << (8 - width)) & 0xff;
    const actual = bytes[index]; const target = expected[index];
    if (actual === undefined || target === undefined || (actual & mask) !== (target & mask)) return false;
    remaining -= width;
  }
  return true;
}

function ipv6Blocked(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;
  const allZero = bytes.every((value) => value === 0);
  const loopback = allZero ? false : bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1;
  const embeddedV4 = bytes.slice(0, 10).every((value) => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (embeddedV4) {
    const mapped = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return ipv4Blocked(mapped);
  }
  return allZero || loopback || bytes[0] === 0xff ||
    (bytes[0] === 0xfc || bytes[0] === 0xfd) ||
    (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) ||
    ipv6Prefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32) || // documentation range 2001:db8::/32
    ipv6Prefix(bytes, [0x20, 0x01, 0x00, 0x02, 0x00, 0x00], 48) || // benchmarking range 2001:2::/48
    ipv6Prefix(bytes, [0x20, 0x01, 0x00, 0x10], 28);
}

function blockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return ipv4Blocked(address);
  if (family === 6) return ipv6Blocked(address);
  return true;
}

function hostnameBlocked(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local') || normalized.endsWith('.internal');
}

function securityError(code: string, message: string): RemoteMediaSecurityError {
  return new RemoteMediaSecurityError(code, message);
}

export async function validateRemotePublicHttpUrl(input: string, resolveAll: RemoteMediaResolver = defaultResolver): Promise<URL> {
  let url: URL;
  try { url = new URL(input); } catch { throw securityError('REMOTE_MEDIA_URL_INVALID', 'Avatar provider returned an invalid result URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw securityError('REMOTE_MEDIA_URL_INVALID', 'Avatar provider result URL must use HTTP or HTTPS');
  if (url.username || url.password) throw securityError('REMOTE_MEDIA_URL_INVALID', 'Avatar provider result URL must not contain credentials');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostnameBlocked(hostname)) throw securityError('REMOTE_MEDIA_URL_UNSAFE', 'Avatar provider result URL points to a blocked hostname');
  const family = isIP(hostname);
  if (family !== 0) {
    if (blockedAddress(hostname)) throw securityError('REMOTE_MEDIA_URL_UNSAFE', 'Avatar provider result URL points to a non-public address');
    return url;
  }
  let records: readonly RemoteMediaAddress[];
  try { records = await resolveAll(hostname); } catch { throw securityError('REMOTE_MEDIA_DNS_FAILED', 'Avatar provider result URL hostname could not be resolved'); }
  if (records.length === 0 || records.some((record) => blockedAddress(record.address))) throw securityError('REMOTE_MEDIA_URL_UNSAFE', 'Avatar provider result URL resolves to a non-public address');
  return url;
}

function redirectStatus(status: number): boolean { return status >= 300 && status < 400; }

export async function safeFetchRemoteMedia(input: string, options: SafeRemoteMediaFetchOptions = {}): Promise<Response> {
  const fetchImpl = options.fetchImpl || fetch;
  const resolveAll = options.resolveAll || defaultResolver;
  const maxRedirects = options.maxRedirects === undefined ? 5 : options.maxRedirects;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) throw securityError('REMOTE_MEDIA_REDIRECT_INVALID', 'Avatar provider redirect limit is invalid');
  let url = await validateRemotePublicHttpUrl(input, resolveAll);
  for (let redirects = 0; ; redirects += 1) {
    const init: RequestInit = { redirect: 'manual' };
    if (options.signal) init.signal = options.signal;
    const response = await fetchImpl(url, init);
    if (!redirectStatus(response.status)) return response;
    if (redirects >= maxRedirects) throw securityError('REMOTE_MEDIA_REDIRECT_LIMIT', 'Avatar provider result URL exceeded the redirect limit');
    const location = response.headers.get('location');
    if (!location) throw securityError('REMOTE_MEDIA_REDIRECT_INVALID', 'Avatar provider returned a redirect without a location');
    await response.body?.cancel().catch(() => undefined);
    let next: URL;
    try { next = new URL(location, url); } catch { throw securityError('REMOTE_MEDIA_REDIRECT_INVALID', 'Avatar provider returned an invalid redirect location'); }
    url = await validateRemotePublicHttpUrl(next.toString(), resolveAll);
  }
}
