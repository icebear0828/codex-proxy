import { getConfig } from "../../config.js";
import { jitterInt } from "../../utils/jitter.js";

export interface StaggerDeps {
  intervalMs: () => number | null;
  nowMs: () => number;
  jitterInt: (baseMs: number, ratio: number) => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: StaggerDeps = {
  intervalMs: () => getConfig().auth.request_interval_ms,
  nowMs: () => Date.now(),
  jitterInt,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Sleep if this account had a recent request, to stagger upstream traffic. */
export async function staggerIfNeeded(
  prevSlotMs: number | null,
  deps: Partial<StaggerDeps> = {},
): Promise<void> {
  const intervalMs = (deps.intervalMs ?? defaultDeps.intervalMs)();
  if (!intervalMs || prevSlotMs == null) return;
  const elapsed = (deps.nowMs ?? defaultDeps.nowMs)() - prevSlotMs;
  const target = (deps.jitterInt ?? defaultDeps.jitterInt)(intervalMs, 0.3);
  const wait = target - elapsed;
  if (wait > 0) await (deps.sleep ?? defaultDeps.sleep)(wait);
}
