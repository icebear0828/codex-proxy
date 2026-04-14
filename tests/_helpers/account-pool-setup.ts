/**
 * AccountPool unit test setup.
 *
 * Import this file BEFORE any @src/ imports in unit tests that exercise AccountPool.
 * The vi.mock() calls below are registered when this module is evaluated,
 * so they take effect for all subsequent @src/ imports in the test file.
 *
 *   import "@helpers/account-pool-setup.js";
 *   // then import @src/ modules
 *
 * Mocked modules:
 *   - @src/config.js        — getConfig() returns createMockConfig() (use vi.mocked to override)
 *   - @src/models/model-store.js — getModelPlanTypes returns [], isPlanFetched returns true
 *   - @src/utils/jitter.js  — identity (no randomness, deterministic timing)
 *
 * NOT mocked (use real implementations):
 *   - fs                       — use createMemoryPersistence() from account-pool-factory.js
 *   - @src/auth/jwt-utils.js   — use createValidJwt() from jwt.js; real parsing works fine
 *   - @src/paths.js            — not used when createMemoryPersistence() is injected
 */

import { vi } from "vitest";
import { createMockConfig } from "@helpers/config.js";

vi.mock("@src/config.js", () => {
  const cfg = createMockConfig();
  return { getConfig: vi.fn(() => cfg) };
});

vi.mock("@src/models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
  isPlanFetched: vi.fn(() => true),
}));

vi.mock("@src/utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

export {};
