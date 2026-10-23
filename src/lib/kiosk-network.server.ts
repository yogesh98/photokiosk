import { isIP } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export type KioskNetworkAddress = {
  interfaceName: string;
  address: string;
};

/** Read the booth computer's interfaces on the server, never a public IP service. */
export function getKioskNetworkAddresses(
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined> = networkInterfaces(),
): KioskNetworkAddress[] {
  const addresses: KioskNetworkAddress[] = [];
  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    const seen = new Set<string>();
    for (const entry of entries ?? []) {
      if (
        entry.internal ||
        entry.family !== "IPv4" ||
        isIP(entry.address) !== 4 ||
        entry.address.startsWith("127.") ||
        entry.address === "0.0.0.0" ||
        seen.has(entry.address)
      ) continue;
      seen.add(entry.address);
      addresses.push({ interfaceName, address: entry.address });
    }
  }
  return addresses.sort((left, right) =>
    left.interfaceName.localeCompare(right.interfaceName) || left.address.localeCompare(right.address),
  );
}
