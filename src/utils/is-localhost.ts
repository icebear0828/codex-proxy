const LOCALHOST_ADDRS = new Set(["", "127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Returns true if the remote address represents a localhost connection. */
export function isLocalhostRequest(remoteAddr: string): boolean {
  return LOCALHOST_ADDRS.has(remoteAddr);
}
