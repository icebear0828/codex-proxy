import { describe, expect, it } from "vitest";
import { staggerIfNeeded, type StaggerDeps } from "@src/routes/shared/proxy-stagger.js";

interface TestDeps {
  deps: StaggerDeps;
  sleepCalls: number[];
  jitterCalls: Array<[baseMs: number, ratio: number]>;
}

function createDeps(overrides: Partial<StaggerDeps> = {}): TestDeps {
  const sleepCalls: number[] = [];
  const jitterCalls: Array<[baseMs: number, ratio: number]> = [];
  const deps: StaggerDeps = {
    intervalMs: () => 100,
    nowMs: () => 1_050,
    jitterInt: (baseMs, ratio) => {
      jitterCalls.push([baseMs, ratio]);
      return baseMs;
    },
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    ...overrides,
  };

  return { deps, sleepCalls, jitterCalls };
}

describe("staggerIfNeeded", () => {
  it("does not sleep when request staggering is disabled", async () => {
    const { deps, sleepCalls, jitterCalls } = createDeps({
      intervalMs: () => 0,
    });

    await staggerIfNeeded(1_000, deps);

    expect(sleepCalls).toEqual([]);
    expect(jitterCalls).toEqual([]);
  });

  it("does not sleep when the account has no previous slot timestamp", async () => {
    const { deps, sleepCalls } = createDeps();

    await staggerIfNeeded(null, deps);

    expect(sleepCalls).toEqual([]);
  });

  it("does not sleep after the jittered target interval has elapsed", async () => {
    const { deps, sleepCalls } = createDeps({
      nowMs: () => 1_200,
      jitterInt: () => 100,
    });

    await staggerIfNeeded(1_000, deps);

    expect(sleepCalls).toEqual([]);
  });

  it("sleeps for the remaining jittered interval", async () => {
    const { deps, sleepCalls, jitterCalls } = createDeps({
      intervalMs: () => 140,
      nowMs: () => 1_050,
    });

    await staggerIfNeeded(1_000, deps);

    expect(sleepCalls).toEqual([90]);
    expect(jitterCalls).toEqual([[140, 0.3]]);
  });

  it("treats prevSlotMs zero as a real timestamp", async () => {
    const { deps, sleepCalls } = createDeps({
      intervalMs: () => 120,
      nowMs: () => 40,
      jitterInt: () => 120,
    });

    await staggerIfNeeded(0, deps);

    expect(sleepCalls).toEqual([80]);
  });
});
