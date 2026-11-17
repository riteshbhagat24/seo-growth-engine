import { describe, expect, it } from "vitest";
import { isPublicAddress } from "../src/ip-guard";

describe("isPublicAddress", () => {
  const blocked = [
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "192.0.2.10", "198.51.100.7", "203.0.113.9", "198.18.0.1",
    "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:10.1.2.3", // IPv4-mapped
    "64:ff9b::a9fe:a9fe", // NAT64 of 169.254.169.254
    "2002:7f00:1::1", // 6to4 of 127.0.0.1
    "::127.0.0.1", // IPv4-compatible
    "fe80::1%eth0",
    "not-an-ip", ""
  ];
  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2002:808:808::1"];

  for (const a of blocked) it(`blocks ${a || "(empty)"}`, () => expect(isPublicAddress(a)).toBe(false));
  for (const a of allowed) it(`allows ${a}`, () => expect(isPublicAddress(a)).toBe(true));
});
