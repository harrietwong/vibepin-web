import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";

type ResolvedAddress = {
  address: string;
  family: number;
};

type ResolveHostname = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export class UnsafeOutboundUrlError extends Error {
  constructor() {
    super("Outbound URL is not allowed");
    this.name = "UnsafeOutboundUrlError";
  }
}

function extractRawHostname(input: string): string | null {
  const authority = input.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1];
  if (!authority) return null;

  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostAndPort.startsWith("[")) {
    const closingBracket = hostAndPort.indexOf("]");
    return closingBracket > 0 ? hostAndPort.slice(1, closingBracket) : null;
  }

  const colonIndex = hostAndPort.lastIndexOf(":");
  return colonIndex === -1 ? hostAndPort : hostAndPort.slice(0, colonIndex);
}

function parseIpv4(address: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return null;

  const octets = address.split(".").map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  if (address.split(".").some((octet) => octet.length > 1 && octet.startsWith("0"))) return null;
  return octets;
}

function ipv4ToNumber(octets: number[]): number {
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function isInIpv4Cidr(address: number, base: string, prefixLength: number): boolean {
  const baseOctets = parseIpv4(base);
  if (!baseOctets) return false;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (address & mask) === (ipv4ToNumber(baseOctets) & mask);
}

function isPublicIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return false;

  const numericAddress = ipv4ToNumber(octets);
  const blockedCidrs: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];

  return !blockedCidrs.some(([base, prefixLength]) =>
    isInIpv4Cidr(numericAddress, base, prefixLength),
  );
}

function parseIpv6(address: string): number[] | null {
  let normalized = address.toLowerCase();
  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex !== -1) return null;

  const ipv4Match = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Match) {
    const ipv4 = parseIpv4(ipv4Match[1]);
    if (!ipv4) return null;
    const firstGroup = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const secondGroup = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    normalized = `${normalized.slice(0, -ipv4Match[1].length)}${firstGroup}:${secondGroup}`;
  }

  if (normalized.split("::").length > 2) return null;
  const [leftPart, rightPart] = normalized.split("::");
  const left = leftPart ? leftPart.split(":") : [];
  const right = rightPart ? rightPart.split(":") : [];
  const omittedGroups = 8 - left.length - right.length;

  if (normalized.includes("::")) {
    if (omittedGroups < 1) return null;
  } else if (omittedGroups !== 0) {
    return null;
  }

  const groups = [...left, ...Array(Math.max(omittedGroups, 0)).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[\da-f]{1,4}$/.test(group))) return null;

  return groups.map((group) => Number.parseInt(group, 16));
}

function ipv6PrefixMatches(address: number[], base: string, prefixLength: number): boolean {
  const baseGroups = parseIpv6(base);
  if (!baseGroups) return false;

  const completeGroups = Math.floor(prefixLength / 16);
  for (let index = 0; index < completeGroups; index += 1) {
    if (address[index] !== baseGroups[index]) return false;
  }

  const remainingBits = prefixLength % 16;
  if (remainingBits === 0) return true;
  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return (address[completeGroups] & mask) === (baseGroups[completeGroups] & mask);
}

function isPublicIpv6(address: string): boolean {
  const numericAddress = parseIpv6(address);
  if (numericAddress === null) return false;

  if (numericAddress.slice(0, 5).every((group) => group === 0) && numericAddress[5] === 0xffff) {
    const embeddedIpv4 = ((numericAddress[6] << 16) | numericAddress[7]) >>> 0;
    const octets = [
      embeddedIpv4 >>> 24,
      (embeddedIpv4 >>> 16) & 0xff,
      (embeddedIpv4 >>> 8) & 0xff,
      embeddedIpv4 & 0xff,
    ];
    return isPublicIpv4(octets.join("."));
  }

  if (!ipv6PrefixMatches(numericAddress, "2000::", 3)) return false;

  const blockedCidrs: Array<[string, number]> = [
    ["2001::", 32],
    ["2001:2::", 48],
    ["2001:10::", 28],
    ["2001:20::", 28],
    ["2001:db8::", 32],
    ["2002::", 16],
  ];

  return !blockedCidrs.some(([base, prefixLength]) =>
    ipv6PrefixMatches(numericAddress, base, prefixLength),
  );
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

async function defaultResolveHostname(hostname: string): Promise<readonly ResolvedAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function addressesArePublic(addresses: readonly ResolvedAddress[]): boolean {
  return addresses.length > 0 && addresses.every(({ address, family }) =>
    (family === 4 || family === 6) && isPublicIpAddress(address),
  );
}

function blockedLookupError(): NodeJS.ErrnoException {
  const error = new Error("DNS target is not allowed") as NodeJS.ErrnoException;
  error.code = "EACCES";
  return error;
}

export function createGuardedDnsLookup(
  resolveHostname: ResolveHostname = defaultResolveHostname,
): LookupFunction {
  return (hostname, options, callback) => {
    resolveHostname(hostname).then((addresses) => {
    if (!addressesArePublic(addresses)) {
      callback(blockedLookupError(), "", 0);
      return;
    }

    if (options.all) {
      callback(null, addresses.map(({ address, family }) => ({ address, family })));
      return;
    }

    callback(null, addresses[0].address, addresses[0].family);
    }).catch(() => callback(blockedLookupError(), "", 0));
  };
}

export const guardedDnsLookup: LookupFunction = createGuardedDnsLookup();

export async function safeOutboundUrl(
  input: string,
  resolveHostname: ResolveHostname = defaultResolveHostname,
): Promise<URL> {
  const rawHostname = extractRawHostname(input);
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(input);
  } catch {
    throw new UnsafeOutboundUrlError();
  }

  if (
    !rawHostname ||
    rawHostname.includes("%") ||
    (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw new UnsafeOutboundUrlError();
  }

  // Restrict the port surface to web defaults. This also rejects alternate
  // ports commonly used to expose internal services (e.g. :8080/:3000).
  if (
    parsedUrl.port
    && !(
      (parsedUrl.protocol === "http:" && parsedUrl.port === "80")
      || (parsedUrl.protocol === "https:" && parsedUrl.port === "443")
    )
  ) {
    throw new UnsafeOutboundUrlError();
  }

  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, "");
  const parsedFamily = isIP(hostname);
  const rawFamily = isIP(rawHostname);

  if (parsedFamily !== 0) {
    if (rawFamily !== parsedFamily) throw new UnsafeOutboundUrlError();
    if (parsedFamily === 4 && rawHostname !== hostname) throw new UnsafeOutboundUrlError();
    if (!isPublicIpAddress(hostname)) throw new UnsafeOutboundUrlError();
    return parsedUrl;
  }

  if (/^(?:0x[\da-f]+|[\d.]+)$/i.test(rawHostname)) throw new UnsafeOutboundUrlError();

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await resolveHostname(hostname);
  } catch {
    throw new UnsafeOutboundUrlError();
  }

  if (!addressesArePublic(addresses)) {
    throw new UnsafeOutboundUrlError();
  }

  return parsedUrl;
}
