import { describe, it, expect, beforeEach } from "vitest";
import {
  _resetAllCfChallengeCooldowns,
  clearCfChallengeCooldown,
  getCfChallengeCooldown,
  isCfChallengeCooldownActive,
  recordCfChallengeCooldown,
} from "@src/auth/cf-challenge-cooldown.js";

describe("cf-challenge-cooldown", () => {
  beforeEach(() => {
    _resetAllCfChallengeCooldowns();
  });

  it("applies the progressive 10s, 30s, 90s, 120s backoff sequence", () => {
    const t0 = 1_000_000;

    expect(recordCfChallengeCooldown("entry-1", t0).delaySeconds).toBe(10);
    expect(recordCfChallengeCooldown("entry-1", t0 + 10_001).delaySeconds).toBe(30);
    expect(recordCfChallengeCooldown("entry-1", t0 + 40_002).delaySeconds).toBe(90);
    expect(recordCfChallengeCooldown("entry-1", t0 + 130_003).delaySeconds).toBe(120);
    expect(recordCfChallengeCooldown("entry-1", t0 + 250_004).delaySeconds).toBe(120);
  });

  it("tracks cooldowns independently per account", () => {
    const t0 = 2_000_000;

    expect(recordCfChallengeCooldown("entry-a", t0).delaySeconds).toBe(10);
    expect(recordCfChallengeCooldown("entry-a", t0 + 10_001).delaySeconds).toBe(30);
    expect(recordCfChallengeCooldown("entry-b", t0 + 10_001).delaySeconds).toBe(10);
  });

  it("reports active cooldown until the deadline passes", () => {
    const t0 = 3_000_000;
    const state = recordCfChallengeCooldown("entry-1", t0);

    expect(state.cooldownUntilMs).toBe(t0 + 10_000);
    expect(isCfChallengeCooldownActive("entry-1", t0 + 9_999)).toBe(true);
    expect(isCfChallengeCooldownActive("entry-1", t0 + 10_000)).toBe(false);
  });

  it("clears progression after a successful non-challenge request", () => {
    const t0 = 4_000_000;
    recordCfChallengeCooldown("entry-1", t0);
    recordCfChallengeCooldown("entry-1", t0 + 10_001);

    clearCfChallengeCooldown("entry-1");

    expect(getCfChallengeCooldown("entry-1")).toBeNull();
    expect(recordCfChallengeCooldown("entry-1", t0 + 40_000).delaySeconds).toBe(10);
  });
});
