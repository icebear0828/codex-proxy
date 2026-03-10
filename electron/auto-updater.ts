/**
 * Electron auto-updater — checks GitHub Releases for new versions,
 * downloads updates, and installs them on quit.
 *
 * Supports Windows (NSIS), macOS (zip), and Linux (AppImage).
 */

import { autoUpdater, type UpdateInfo, type ProgressInfo } from "electron-updater";
import { BrowserWindow, dialog } from "electron";

export interface AutoUpdateState {
  checking: boolean;
  updateAvailable: boolean;
  downloading: boolean;
  downloaded: boolean;
  progress: number;
  version: string | null;
  error: string | null;
}

interface AutoUpdaterOptions {
  getMainWindow: () => BrowserWindow | null;
  rebuildTrayMenu: () => void;
}

const state: AutoUpdateState = {
  checking: false,
  updateAvailable: false,
  downloading: false,
  downloaded: false,
  progress: 0,
  version: null,
  error: null,
};

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const INITIAL_DELAY_MS = 30_000; // 30 seconds after startup

let checkTimer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
let dismissedVersion: string | null = null;

export function getAutoUpdateState(): AutoUpdateState {
  return { ...state };
}

export function initAutoUpdater(options: AutoUpdaterOptions): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("checking-for-update", () => {
    state.checking = true;
    state.error = null;
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    state.checking = false;
    state.updateAvailable = true;
    state.version = info.version;
    options.rebuildTrayMenu();

    // Don't re-prompt if user already dismissed this version
    if (info.version === dismissedVersion) return;

    const win = options.getMainWindow();
    const msgOptions = {
      type: "info" as const,
      title: "Update Available",
      message: `A new version (v${info.version}) is available.`,
      detail: "Would you like to download it now?",
      buttons: ["Download", "Later"],
      defaultId: 0,
    };
    const promise = win
      ? dialog.showMessageBox(win, msgOptions)
      : dialog.showMessageBox(msgOptions);
    promise.then(({ response }) => {
      if (response === 0) {
        autoUpdater.downloadUpdate().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[AutoUpdater] Download failed:", msg);
        });
      } else {
        dismissedVersion = info.version;
      }
    });
  });

  autoUpdater.on("update-not-available", () => {
    state.checking = false;
    state.updateAvailable = false;
  });

  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    state.downloading = true;
    const rounded = Math.round(progress.percent);
    // Throttle tray rebuilds to every 10% increment
    if (rounded - state.progress >= 10 || rounded === 100) {
      state.progress = rounded;
      options.rebuildTrayMenu();
    } else {
      state.progress = rounded;
    }
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    state.downloading = false;
    state.downloaded = true;
    state.progress = 100;
    options.rebuildTrayMenu();

    const win = options.getMainWindow();
    const readyOptions = {
      type: "info" as const,
      title: "Update Ready",
      message: `Version ${info.version} has been downloaded.`,
      detail: "The update will be installed when you quit the app. Restart now?",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
    };
    const readyPromise = win
      ? dialog.showMessageBox(win, readyOptions)
      : dialog.showMessageBox(readyOptions);
    readyPromise.then(({ response }) => {
      if (response === 0) {
        autoUpdater.quitAndInstall(false, true);
      }
    });
  });

  autoUpdater.on("error", (err: Error) => {
    state.checking = false;
    state.downloading = false;
    state.error = err.message;
    console.error("[AutoUpdater] Error:", err.message);
    options.rebuildTrayMenu();
  });

  // Initial check after delay
  initialTimer = setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err: Error) => {
      console.warn("[AutoUpdater] Initial check failed:", err.message);
    });
  }, INITIAL_DELAY_MS);

  // Periodic check
  checkTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch((err: Error) => {
      console.warn("[AutoUpdater] Periodic check failed:", err.message);
    });
  }, CHECK_INTERVAL_MS);
  if (checkTimer.unref) checkTimer.unref();
}

export function checkForUpdateManual(): void {
  autoUpdater.checkForUpdates().catch((err: Error) => {
    console.warn("[AutoUpdater] Manual check failed:", err.message);
  });
}

export function downloadUpdate(): void {
  autoUpdater.downloadUpdate().catch((err: Error) => {
    console.warn("[AutoUpdater] Download failed:", err.message);
  });
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall(false, true);
}

export function stopAutoUpdater(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}
