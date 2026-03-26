/**
 * Tests for electron/auto-updater.ts
 *
 * Mocks electron-updater and electron dialog to test state transitions
 * without a real Electron runtime.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// ── Mocks ────────────────────────────────────────────────────────────

// Create a mock autoUpdater as an EventEmitter with methods
const mockAutoUpdater = Object.assign(new EventEmitter(), {
  autoDownload: true,
  autoInstallOnAppQuit: false,
  allowPrerelease: false,
  checkForUpdates: vi.fn().mockResolvedValue(undefined),
  downloadUpdate: vi.fn().mockResolvedValue(undefined),
  quitAndInstall: vi.fn(),
});

vi.mock("electron-updater", () => ({
  autoUpdater: mockAutoUpdater,
}));

const mockDialog = {
  showMessageBox: vi.fn().mockResolvedValue({ response: 1 }), // "Later" by default
};
const mockShell = {
  openExternal: vi.fn().mockResolvedValue(undefined),
};

vi.mock("electron", () => ({
  BrowserWindow: class {},
  dialog: mockDialog,
  shell: mockShell,
}));

vi.mock("../electron/constants.js", () => ({
  IS_MAC: false,
  GITHUB_REPO: "icebear0828/codex-proxy",
}));

// Import after mocks are set up
const { getAutoUpdateState, initAutoUpdater, stopAutoUpdater } = await import(
  "../electron/auto-updater.js"
);

describe("auto-updater state machine", () => {
  const mockOptions = {
    getMainWindow: vi.fn().mockReturnValue(null),
    rebuildTrayMenu: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockAutoUpdater.removeAllListeners();
  });

  afterEach(() => {
    stopAutoUpdater();
    vi.useRealTimers();
  });

  it("initial state is idle", () => {
    const state = getAutoUpdateState();
    expect(state.checking).toBe(false);
    expect(state.updateAvailable).toBe(false);
    expect(state.downloading).toBe(false);
    expect(state.downloaded).toBe(false);
    expect(state.version).toBeNull();
    expect(state.error).toBeNull();
  });

  it("configures autoUpdater on init (autoUpdate defaults to true)", () => {
    initAutoUpdater(mockOptions);

    // Non-macOS + autoUpdate=true → autoDownload=true
    expect(mockAutoUpdater.autoDownload).toBe(true);
    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(mockAutoUpdater.allowPrerelease).toBe(false);
  });

  it("autoDownload=false when autoUpdate is explicitly false", () => {
    initAutoUpdater({ ...mockOptions, autoUpdate: false });

    expect(mockAutoUpdater.autoDownload).toBe(false);
  });

  it("schedules initial check after 30s delay", () => {
    initAutoUpdater(mockOptions);

    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);

    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("schedules periodic check every 4 hours", () => {
    initAutoUpdater(mockOptions);

    // Initial delay
    vi.advanceTimersByTime(30_000);
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    // 4 hours later
    vi.advanceTimersByTime(4 * 60 * 60 * 1000);
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("transitions to checking state", () => {
    initAutoUpdater(mockOptions);

    mockAutoUpdater.emit("checking-for-update");

    const state = getAutoUpdateState();
    expect(state.checking).toBe(true);
    expect(state.error).toBeNull();
  });

  it("transitions to update-available state", () => {
    initAutoUpdater(mockOptions);

    mockAutoUpdater.emit("update-available", { version: "2.0.0" });

    const state = getAutoUpdateState();
    expect(state.checking).toBe(false);
    expect(state.updateAvailable).toBe(true);
    expect(state.version).toBe("2.0.0");
    expect(mockOptions.rebuildTrayMenu).toHaveBeenCalled();
  });

  it("transitions to update-not-available state", () => {
    initAutoUpdater(mockOptions);

    mockAutoUpdater.emit("checking-for-update");
    mockAutoUpdater.emit("update-not-available");

    const state = getAutoUpdateState();
    expect(state.checking).toBe(false);
    expect(state.updateAvailable).toBe(false);
  });

  it("tracks download progress", () => {
    initAutoUpdater(mockOptions);

    mockAutoUpdater.emit("download-progress", { percent: 50 });

    const state = getAutoUpdateState();
    expect(state.downloading).toBe(true);
    expect(state.progress).toBe(50);
  });

  it("throttles tray rebuild to every 10% increment", () => {
    initAutoUpdater(mockOptions);
    mockOptions.rebuildTrayMenu.mockClear();

    mockAutoUpdater.emit("download-progress", { percent: 5 });
    expect(mockOptions.rebuildTrayMenu).not.toHaveBeenCalled();

    mockAutoUpdater.emit("download-progress", { percent: 15 });
    expect(mockOptions.rebuildTrayMenu).toHaveBeenCalledTimes(1);

    mockOptions.rebuildTrayMenu.mockClear();
    mockAutoUpdater.emit("download-progress", { percent: 20 });
    expect(mockOptions.rebuildTrayMenu).not.toHaveBeenCalled();

    mockAutoUpdater.emit("download-progress", { percent: 100 });
    expect(mockOptions.rebuildTrayMenu).toHaveBeenCalledTimes(1);
  });

  it("transitions to downloaded state", () => {
    initAutoUpdater(mockOptions);

    mockAutoUpdater.emit("update-downloaded", { version: "2.0.0" });

    const state = getAutoUpdateState();
    expect(state.downloading).toBe(false);
    expect(state.downloaded).toBe(true);
    expect(state.progress).toBe(100);
    expect(mockOptions.rebuildTrayMenu).toHaveBeenCalled();
  });

  it("handles errors gracefully", () => {
    initAutoUpdater(mockOptions);

    mockAutoUpdater.emit("error", new Error("Network timeout"));

    const state = getAutoUpdateState();
    expect(state.checking).toBe(false);
    expect(state.downloading).toBe(false);
    expect(state.error).toBe("Network timeout");
    expect(mockOptions.rebuildTrayMenu).toHaveBeenCalled();
  });

  it("stopAutoUpdater clears all timers", () => {
    initAutoUpdater(mockOptions);

    stopAutoUpdater();

    // Advance past both initial delay and periodic interval
    vi.advanceTimersByTime(5 * 60 * 60 * 1000);

    // checkForUpdates should not have been called (timers cleared)
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("returns a copy of state (not reference)", () => {
    const state1 = getAutoUpdateState();
    const state2 = getAutoUpdateState();

    expect(state1).not.toBe(state2);
    expect(state1).toEqual(state2);
  });

  it("sets progress bar on window during download", () => {
    const mockWin = { setProgressBar: vi.fn() };
    const opts = {
      ...mockOptions,
      getMainWindow: vi.fn().mockReturnValue(mockWin),
    };
    initAutoUpdater(opts);

    mockAutoUpdater.emit("download-progress", { percent: 50 });
    expect(mockWin.setProgressBar).toHaveBeenCalledWith(0.5);

    mockAutoUpdater.emit("download-progress", { percent: 100 });
    expect(mockWin.setProgressBar).toHaveBeenCalledWith(1);
  });

  it("clears progress bar on update-downloaded", () => {
    const mockWin = { setProgressBar: vi.fn() };
    const opts = {
      ...mockOptions,
      getMainWindow: vi.fn().mockReturnValue(mockWin),
    };
    initAutoUpdater(opts);

    mockAutoUpdater.emit("update-downloaded", { version: "2.0.0" });
    expect(mockWin.setProgressBar).toHaveBeenCalledWith(-1);
  });

  it("clears progress bar on error", () => {
    const mockWin = { setProgressBar: vi.fn() };
    const opts = {
      ...mockOptions,
      getMainWindow: vi.fn().mockReturnValue(mockWin),
    };
    initAutoUpdater(opts);

    mockAutoUpdater.emit("error", new Error("fail"));
    expect(mockWin.setProgressBar).toHaveBeenCalledWith(-1);
  });

  it("skips download dialog when autoUpdate=true (non-macOS)", () => {
    initAutoUpdater({ ...mockOptions, autoUpdate: true });

    mockAutoUpdater.emit("update-available", { version: "3.0.0" });

    const state = getAutoUpdateState();
    expect(state.updateAvailable).toBe(true);
    // Should NOT show dialog (autoDownload handles it)
    expect(mockDialog.showMessageBox).not.toHaveBeenCalled();
  });
});
