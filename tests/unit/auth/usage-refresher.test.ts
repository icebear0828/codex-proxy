import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockConfig = vi.hoisted(() => ({
  usage_stats: {
    snapshot_interval_minutes: 5,
  },
  quota: {
    refresh_interval_minutes: 0,
  },
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("@src/utils/jitter.js", () => ({
  jitter: vi.fn((ms: number) => ms),
}));

import { SnapshotTimer } from "@src/auth/usage-refresher.js";
import type { AccountPool } from "@src/auth/account-pool.js";
import type { UsageStatsStore } from "@src/auth/usage-stats.js";

function createSnapshotTimer(): {
  timer: SnapshotTimer;
  recordSnapshot: ReturnType<typeof vi.fn>;
} {
  const pool = {} as AccountPool;
  const recordSnapshot = vi.fn();
  const usageStats = { recordSnapshot } as unknown as UsageStatsStore;
  return {
    timer: new SnapshotTimer(pool, usageStats),
    recordSnapshot,
  };
}

describe("SnapshotTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockConfig.usage_stats.snapshot_interval_minutes = 5;
    mockConfig.quota.refresh_interval_minutes = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records usage history snapshots even when quota refresh is disabled", () => {
    const { timer, recordSnapshot } = createSnapshotTimer();

    timer.start();

    vi.advanceTimersByTime(2_999);
    expect(recordSnapshot).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(recordSnapshot).toHaveBeenCalledTimes(1);

    timer.stop();
  });
});
