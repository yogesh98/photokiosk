import assert from "node:assert/strict";
import { test } from "node:test";
import type { NetworkInterfaceInfo } from "node:os";
import { GET } from "../app/api/kiosk/network/route";
import { getKioskNetworkAddresses } from "./kiosk-network.server";

function address(
  value: string,
  options: { family?: "IPv4" | "IPv6"; internal?: boolean } = {},
): NetworkInterfaceInfo {
  if (options.family === "IPv6") {
    return {
      address: value,
      family: "IPv6",
      internal: options.internal ?? false,
      netmask: "ffff:ffff:ffff:ffff::",
      mac: "00:11:22:33:44:55",
      cidr: `${value}/64`,
      scopeid: 0,
    };
  }
  return {
    address: value,
    family: "IPv4",
    internal: options.internal ?? false,
    netmask: "255.255.255.0",
    mac: "00:11:22:33:44:55",
    cidr: `${value}/24`,
  };
}

test("returns each LAN IPv4 address with its interface name in a stable order", () => {
  assert.deepEqual(getKioskNetworkAddresses({
    en1: [address("10.1.2.3"), address("fe80::1234", { family: "IPv6" })],
    en0: [address("192.168.1.15"), address("192.168.1.16")],
  }), [
    { interfaceName: "en0", address: "192.168.1.15" },
    { interfaceName: "en0", address: "192.168.1.16" },
    { interfaceName: "en1", address: "10.1.2.3" },
  ]);
});

test("excludes loopback, internal, unspecified, malformed, and IPv6 addresses", () => {
  assert.deepEqual(getKioskNetworkAddresses({
    lo0: [
      address("127.0.0.1", { internal: true }),
      address("127.1.2.3"),
      address("::1", { family: "IPv6", internal: true }),
    ],
    en0: [
      address("10.0.0.4", { internal: true }),
      address("0.0.0.0"),
      address("invalid"),
      address("999.1.1.1"),
      address("2001:db8::1", { family: "IPv6" }),
    ],
  }), []);
});

test("reports no addresses for absent or unassigned interfaces", () => {
  assert.deepEqual(getKioskNetworkAddresses({}), []);
  assert.deepEqual(getKioskNetworkAddresses({ en0: undefined, en1: [] }), []);
});

test("deduplicates addresses within an interface and preserves separate NIC names", () => {
  assert.deepEqual(getKioskNetworkAddresses({
    en0: [address("192.168.1.15"), address("192.168.1.15")],
    en1: [address("192.168.1.15")],
  }), [
    { interfaceName: "en0", address: "192.168.1.15" },
    { interfaceName: "en1", address: "192.168.1.15" },
  ]);
});

test("the network endpoint returns uncached addresses to the local kiosk", async () => {
  const response = await GET(new Request("http://127.0.0.1:3000/api/kiosk/network"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload), ["addresses"]);
  assert.ok(Array.isArray(payload.addresses));
  for (const entry of payload.addresses) {
    assert.equal(typeof entry.interfaceName, "string");
    assert.equal(typeof entry.address, "string");
  }
});

test("the network endpoint rejects remote and cross-origin requests", async () => {
  for (const request of [
    new Request("http://booth.example.com/api/kiosk/network"),
    new Request("http://127.0.0.1:3000/api/kiosk/network", { headers: { origin: "https://evil.example.com" } }),
    new Request("http://127.0.0.1:3000/api/kiosk/network", { headers: { "sec-fetch-site": "cross-site" } }),
  ]) {
    const response = await GET(request);
    assert.equal(response.status, 403);
    assert.equal(typeof (await response.json()).error, "string");
  }
});
