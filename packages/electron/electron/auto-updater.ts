/**
 * Electron auto-updater — checks GitHub Releases for new versions.
 *
 * macOS (no code signing): notifies user and opens GitHub release page.
 * Windows / Linux: downloads and installs via electron-updater.
 */

import { autoUpdater, type UpdateInfo, type ProgressInfo } from "electron-updater";
import { BrowserWindow, dialog, shell } from "electron";
import { IS_MAC, GITHUB_REPO } from "./constants.js";

export interface AutoUpdateState {
  checking: boolean;
  updateAvailable: boolean;
  downloading: boolean;
  downloaded: boolean;
  progress: number;
  version: string | null;
  releaseUrl: string | null;
  error: string | null;
}

interface AutoUpdaterOptions {
  getMainWindow: () => BrowserWindow | null;
  rebuildTrayMenu: () => void;
  autoUpdate?: boolean;
  autoDownload?: boolean;
}

const state: AutoUpdateState = {
  checking: false,
  updateAvailable: false,
  downloading: false,
  downloaded: false,
  progress: 0,
  version: null,
  releaseUrl: null,
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
  const isAutoUpdate = options.autoUpdate ?? true;
  const isAutoDownload = (options.autoDownload ?? false) && !IS_MAC;

  // auto_download: true  → download silently, prompt to restart
  // auto_download: false → prompt before downloading (default)
  // macOS always false — ad-hoc signed zips can't be auto-installed
  autoUpdater.autoDownload = isAutoDownload;
  autoUpdater.autoInstallOnAppQuit = !IS_MAC;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("checking-for-update", () => {
    state.checking = true;
    state.error = null;
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    state.checking = false;
    state.updateAvailable = true;
    state.version = info.version;
    state.releaseUrl = `https://github.com/${GITHUB_REPO}/releases/tag/v${info.version}`;
    options.rebuildTrayMenu();

    // autoDownload handles it silently — no dialog needed
    if (isAutoDownload) return;

    // Don't re-prompt if user already dismissed this version
    if (info.version === dismissedVersion) return;

    const win = options.getMainWindow();
    const msgOptions = {
      type: "info" as const,
      title: "Update Available",
      message: `A new version (v${info.version}) is available.`,
      detail: IS_MAC
        ? "Open the release page to download the latest DMG?"
        : "Would you like to download it now?",
      buttons: IS_MAC ? ["Open Release Page", "Later"] : ["Download", "Later"],
      defaultId: 0,
    };
    const promise = win
      ? dialog.showMessageBox(win, msgOptions)
      : dialog.showMessageBox(msgOptions);
    promise.then(({ response }) => {
      if (response === 0) {
        if (IS_MAC) {
          shell.openExternal(state.releaseUrl!).catch((err: unknown) => {
            console.error("[AutoUpdater] Failed to open release page:", err instanceof Error ? err.message : err);
          });
        } else {
          autoUpdater.downloadUpdate().catch((err: unknown) => {
            console.error("[AutoUpdater] Download failed:", err instanceof Error ? err.message : err);
          });
        }
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
    // Update dock/taskbar progress bar
    const win = options.getMainWindow();
    if (win) win.setProgressBar(progress.percent / 100);
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
    // Clear dock/taskbar progress bar
    if (win) win.setProgressBar(-1);

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
    // Clear dock/taskbar progress bar on error
    const win = options.getMainWindow();
    if (win) win.setProgressBar(-1);
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

/** Open release page on macOS; download installer on Windows/Linux. */
export function downloadUpdate(): void {
  if (IS_MAC) {
    if (state.releaseUrl) {
      shell.openExternal(state.releaseUrl).catch((err: unknown) => {
        console.error("[AutoUpdater] Failed to open release page:", err instanceof Error ? err.message : err);
      });
    }
    return;
  }
  autoUpdater.downloadUpdate().catch((err: Error) => {
    console.warn("[AutoUpdater] Download failed:", err.message);
  });
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall(false, true);
}

export function stopAutoUpdater(): void {
  autoUpdater.removeAllListeners();
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}
