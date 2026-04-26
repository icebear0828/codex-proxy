export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const parts = normalized.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map((part) => Number(part));
  return octets[0] === 127 && octets.every((octet) => octet >= 0 && octet <= 255);
}

export function isNetworkExposedHost(hostname: string): boolean {
  return hostname.trim() !== "" && !isLoopbackHostname(hostname);
}
