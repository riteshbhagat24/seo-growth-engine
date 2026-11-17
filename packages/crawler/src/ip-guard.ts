import { BlockList, isIP } from "node:net";

/**
 * Addresses outbound requests may never reach: private networks, loopback,
 * link-local (incl. cloud metadata 169.254.169.254), CGNAT, multicast,
 * documentation/benchmark and other reserved ranges.
 */
const v4 = new BlockList();
for (const [net, prefix] of [
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
  ["240.0.0.0", 4]
] as const) {
  v4.addSubnet(net, prefix, "ipv4");
}

const v6 = new BlockList();
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8] // multicast
] as const) {
  v6.addSubnet(net, prefix, "ipv6");
}

/** Expands an IPv6 address into 8 groups of 16-bit numbers. */
function v6Groups(addr: string): number[] {
  let a = addr.toLowerCase();
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  // Trailing dotted IPv4 (e.g. ::ffff:1.2.3.4) → two hex groups.
  const dotted = a.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const p = dotted[2]!.split(".").map(Number);
    a = `${dotted[1]}${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const [head, tail] = a.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  return [...h, ...Array(fill).fill("0"), ...t].map((g) => parseInt(g || "0", 16));
}

const v4FromGroups = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** IPv4 embedded in an IPv6 address by a translation mechanism, if any. */
function embeddedV4(addr: string): string | null {
  const g = v6Groups(addr);
  if (g.length !== 8) return null;
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeros(5) && g[5] === 0xffff) return v4FromGroups(g[6]!, g[7]!); // ::ffff:a.b.c.d (mapped)
  if (zeros(6)) return v4FromGroups(g[6]!, g[7]!); // ::a.b.c.d (deprecated compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4FromGroups(g[6]!, g[7]!); // NAT64
  if (g[0] === 0x2002) return v4FromGroups(g[1]!, g[2]!); // 6to4
  return null;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !v4.check(address, "ipv4");
  if (family === 6) {
    if (v6.check(address, "ipv6")) return false;
    const inner = embeddedV4(address);
    if (inner !== null) return isPublicAddress(inner);
    return true;
  }
  return false; // not an IP at all
}
