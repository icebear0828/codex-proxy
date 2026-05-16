export function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

/** Format a Codex credit balance: "0", "12.34", "1.2k". Always strip trailing zeros. */
export function formatCredits(credits: number): string {
  if (!Number.isFinite(credits)) return "0";
  if (credits >= 1000) return (credits / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (credits === 0) return "0";
  // Two decimals for small numbers, but trim trailing zeros so 5.00 → "5".
  return credits.toFixed(2).replace(/\.?0+$/, "");
}

/** Convert credits to USD using the configured per-USD rate.
 *  Returns null when conversion is disabled (creditsPerUsd <= 0). */
export function creditsToUsd(credits: number, creditsPerUsd: number): number | null {
  if (!Number.isFinite(credits) || !Number.isFinite(creditsPerUsd) || creditsPerUsd <= 0) {
    return null;
  }
  return credits / creditsPerUsd;
}

/** Format a USD amount with $ sign and two decimals. "$12.34" / "$1.2k". */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "$0";
  const sign = usd < 0 ? "-" : "";
  const abs = Math.abs(usd);
  if (abs >= 1000) return sign + "$" + (abs / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return sign + "$" + abs.toFixed(2);
}

export function formatWindowDuration(seconds: number, isZh: boolean): string {
  if (seconds >= 86400) {
    const days = Math.floor(seconds / 86400);
    return isZh ? `${days}\u5929` : `${days}d`;
  }
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    return isZh ? `${hours}\u5c0f\u65f6` : `${hours}h`;
  }
  const minutes = Math.floor(seconds / 60);
  return isZh ? `${minutes}\u5206\u949f` : `${minutes}m`;
}

export function formatResetTime(unixSec: number, isZh: boolean): string {
  const d = new Date(unixSec * 1000);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return time;
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate()
  ) {
    return (isZh ? "\u660e\u5929 " : "Tomorrow ") + time;
  }

  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return date + " " + time;
}
