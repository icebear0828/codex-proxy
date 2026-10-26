import { afterEach, describe, expect, it, vi } from "vitest";
import { setDesktopUpdater } from "../../src/desktop-updater.js";
import { createUpdateRoutes } from "../../src/routes/admin/update.js";

vi.mock("../../src/config.js", () => ({ getConfig: () => ({ update: {}, client: {} }) }));
vi.mock("../../src/update-checker.js", () => ({ getUpdateState: () => null, checkForUpdate: vi.fn(), isUpdateInProgress: () => false }));
vi.mock("../../src/self-update.js", () => ({
  getProxyInfo: () => ({ version: "1", commit: null }), canSelfUpdate: () => false,
  getDeployMode: () => "electron", getCachedProxyUpdateResult: () => null,
  isProxyUpdateInProgress: () => false, checkProxySelfUpdate: vi.fn(), applyProxySelfUpdate: vi.fn(),
}));

describe("desktop update routes", () => {
  afterEach(() => vi.useRealTimers());
  it("exposes download progress and refuses installation before ready", async () => {
    const install = vi.fn();
    setDesktopUpdater({ getState: () => ({ checking: false, updateAvailable: true, downloading: true, downloaded: false, progress: 42, version: "2", error: null }), check: vi.fn(), install });
    const app = createUpdateRoutes();
    const state = await (await app.request("/admin/update-status")).json();
    expect(state.desktop.progress).toBe(42);
    expect((await app.request("/admin/apply-update", { method: "POST" })).status).toBe(409);
    expect(install).not.toHaveBeenCalled();
  });
  it("acknowledges restart before running the silent install", async () => {
    vi.useFakeTimers();
    const install = vi.fn();
    setDesktopUpdater({ getState: () => ({ checking: false, updateAvailable: true, downloading: false, downloaded: true, progress: 100, version: "2", error: null }), check: vi.fn(), install });
    const response = await createUpdateRoutes().request("/admin/apply-update", { method: "POST" });
    expect(await response.json()).toEqual({ started: true, restarting: true });
    expect(install).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(install).toHaveBeenCalledTimes(1);
  });
});
