"use client";

import { useEffect, useState } from "react";
import { bindIpShortcut } from "./ip-shortcut";

type NetworkAddress = { interfaceName: string; address: string };
type NetworkStatus =
  | { status: "loading" }
  | { status: "ready"; addresses: NetworkAddress[] }
  | { status: "error"; message: string };

/** Hold the physical I and P keys to temporarily reveal the booth's LAN address. */
export function LocalIpOverlay() {
  const [network, setNetwork] = useState<NetworkStatus | null>(null);

  useEffect(() => {
    let request: AbortController | null = null;
    const unbind = bindIpShortcut({
      window,
      document,
      onShow: () => {
        request?.abort();
        const controller = new AbortController();
        request = controller;
        setNetwork({ status: "loading" });
        void fetch("/api/kiosk/network", {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        })
          .then(async (response) => {
            if (!response.ok) throw new Error("Unable to read the local IP address.");
            const data: { addresses: NetworkAddress[] } = await response.json();
            if (!controller.signal.aborted)
              setNetwork({ status: "ready", addresses: data.addresses });
          })
          .catch(() => {
            if (!controller.signal.aborted)
              setNetwork({ status: "error", message: "Unable to read the local IP address. Release the keys and try again." });
          });
      },
      onHide: () => {
        request?.abort();
        request = null;
        setNetwork(null);
      },
    });
    return () => {
      unbind();
      request?.abort();
    };
  }, []);

  if (!network) return null;

  return (
    <aside className="kiosk-ip-overlay" role="status" aria-live="polite" aria-atomic="true">
      <div className="kiosk-ip-card">
        <h2>Local IP address</h2>
        {network.status === "loading" ? (
          <p>Reading network address…</p>
        ) : network.status === "error" ? (
          <p>{network.message}</p>
        ) : network.addresses.length ? (
          <dl className="kiosk-ip-addresses">
            {network.addresses.map(({ interfaceName, address }) => (
              <div key={`${interfaceName}-${address}`}>
                <dt>{interfaceName}</dt>
                <dd>{address}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p>No local IPv4 address found. Connect this device to Wi-Fi or Ethernet.</p>
        )}
        <p className="kiosk-ip-hint">Release I or P to hide</p>
      </div>
    </aside>
  );
}
