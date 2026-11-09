import type { Server } from "node:net";
import type { networkInterfaces } from "node:os";

export interface LanRuntimeState {
  host: string;
  port: number;
}

/** Candidates only: routing and firewall determine actual reachability. */
export function listLanIpv4Addresses(interfaces: ReturnType<typeof networkInterfaces>): string[] {
  return [...new Set(Object.values(interfaces).flatMap(entries =>
    (entries ?? []).filter(entry => entry.family === "IPv4" && !entry.internal).map(entry => entry.address),
  ))].sort();
}

/** Read the socket, not the saved configuration (which may need a restart). */
export function readLanRuntime(server: Pick<Server, "address">): LanRuntimeState | null {
  const address = server.address();
  return address && typeof address === "object" ? { host: address.address, port: address.port } : null;
}
