/**
 * Electron main process for Codex Proxy desktop app.
 *
 * Built by esbuild into dist-electron/main.cjs (CJS format).
 * Loads the backend ESM modules from asarUnpack (real filesystem paths).
 */

import { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog } from "electron";
import { resolve, join } from "path";
import { pathToFileURL } from "url";
import { existsSync, mkdirSync } from "fs";
import {
  initAutoUpdater,
  getAutoUpdateState,
  checkForUpdateManual,
  installUpdate,
  downloadUpdate,
  stopAutoUpdater,
} from "./auto-updater.js";
import { IS_MAC } from "./constants.js";


let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverHandle: { close: () => Promise<void>; port: number } | null = null;
let isQuitting = false;

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── macOS application menu ──────────────────────────────────────────

function setupAppMenu(): void {
  if (!IS_MAC) return;

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App ready ────────────────────────────────────────────────────────

app.on("ready", async () => {
  setupAppMenu();

  try {
    // 1. Determine paths — must happen before importing backend
    const userData = app.getPath("userData");
    const dataDir = resolve(userData, "data");
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    const appRoot = app.getAppPath();
    const distRoot = app.isPackaged
      ? resolve(process.resourcesPath, "app.asar.unpacked")
      : appRoot;

    const binDir = app.isPackaged
      ? resolve(process.resourcesPath, "bin")
      : resolve(appRoot, "bin");

    // 2. Import the bundled backend server (single ESM file, no node_modules needed)
    const serverUrl = pathToFileURL(resolve(appRoot, "dist-electron", "server.mjs")).href;
    const { setPaths, startServer, getConfig } = await import(serverUrl);

    // 3. Set paths before starting the server
    setPaths({
      rootDir: appRoot,
      configDir: resolve(distRoot, "config"),
      dataDir,
      binDir,
      publicDir: resolve(distRoot, "public"),
    });

    // 4. Start the proxy server (try configured port first, fall back to random if occupied)
    try {
      serverHandle = await startServer({ host: "127.0.0.1" });
    } catch {
      console.warn("[Electron] Default port in use, using random port");
      serverHandle = await startServer({ host: "127.0.0.1", port: 0 });
    }
    console.log(`[Electron] Server started on port ${serverHandle.port}`);

    // 4. System tray
    createTray();

    // 5. Main window
    createWindow();

    // 6. Auto-updater (only in packaged mode)
    if (app.isPackaged) {
      let autoUpdate = true;
      let autoDownload = false;
      try {
        const updateCfg = getConfig().update;
        autoUpdate = updateCfg.auto_update;
        autoDownload = updateCfg.auto_download;
      } catch { /* use defaults */ }
      initAutoUpdater({
        getMainWindow: () => mainWindow,
        rebuildTrayMenu,
        autoUpdate,
        autoDownload,
      });
    }
  } catch (err) {
    console.error("[Electron] Startup failed:", err);
    dialog.showErrorBox(
      "Codex Proxy - Startup Error",
      `Failed to start:\n\n${err instanceof Error ? err.stack ?? err.message : String(err)}`,
    );
    app.quit();
  }
});

// ── Window ───────────────────────────────────────────────────────────

function createWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 500,
    title: "Codex Proxy",
    // macOS: native hidden titlebar with traffic lights inset into content
    ...(IS_MAC
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 16, y: 18 },
        }
      : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  const port = serverHandle?.port ?? 8080;
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  // Mark <html> with platform class so frontend CSS can adapt
  mainWindow.webContents.on("did-finish-load", () => {
    const legacy = IS_MAC ? "electron-mac" : "electron-win";
    const platform = IS_MAC ? "platform-mac" : "platform-win";
    mainWindow?.webContents.executeJavaScript(
      `document.documentElement.classList.add("electron","${legacy}","${platform}")`,
    );
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Close → hide to tray instead of quitting (unless app is quitting)
  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── Tray ─────────────────────────────────────────────────────────────

function buildTrayMenu(): Electron.MenuItemConstructorOptions[] {
  const items: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Open Dashboard",
      click: () => createWindow(),
    },
    { type: "separator" },
    {
      label: `Port: ${serverHandle?.port ?? 8080}`,
      enabled: false,
    },
    { type: "separator" },
  ];

  // Auto-update menu items
  const updateState = getAutoUpdateState();
  if (updateState.downloaded) {
    items.push({
      label: `Install Update (v${updateState.version})`,
      click: () => installUpdate(),
    });
  } else if (updateState.downloading) {
    items.push({
      label: `Downloading Update... ${updateState.progress}%`,
      enabled: false,
    });
  } else if (updateState.updateAvailable) {
    items.push({
      // macOS: no code signing — open release page for manual DMG download
      label: IS_MAC && updateState.releaseUrl
        ? `Open Release Page (v${updateState.version})`
        : `Download Update (v${updateState.version})`,
      click: () => downloadUpdate(),
    });
  } else {
    items.push({
      label: "Check for Updates",
      click: () => checkForUpdateManual(),
    });
  }

  items.push(
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;

        if (serverHandle) {
          const forceQuit = setTimeout(() => {
            console.error("[Electron] Server close timeout, forcing exit");
            app.exit(0);
          }, 5000);

          serverHandle.close()
            .then(() => { clearTimeout(forceQuit); app.quit(); })
            .catch((err: unknown) => {
              console.error("[Electron] Server close error:", err);
              clearTimeout(forceQuit);
              app.quit();
            });
        } else {
          app.quit();
        }
      },
    },
  );

  return items;
}

function rebuildTrayMenu(): void {
  if (tray) {
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu()));
  }
}

function createTray(): void {
  // In packaged mode: icon is inside asar at {app.asar}/electron/assets/icon.png
  // In dev mode: relative to dist-electron/ → ../electron/assets/icon.png
  const iconPath = app.isPackaged
    ? join(app.getAppPath(), "electron", "assets", "icon.png")
    : join(__dirname, "..", "electron", "assets", "icon.png");
  let icon = existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  // macOS: resize to 18x18 and mark as template for automatic dark/light adaptation
  if (IS_MAC && !icon.isEmpty()) {
    icon = icon.resize({ width: 18, height: 18 });
    icon.setTemplateImage(true);
  }

  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("Codex Proxy");
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu()));
  tray.on("double-click", () => createWindow());
}

// macOS: re-create window when dock icon is clicked
app.on("activate", () => {
  createWindow();
});

// Allow quit from macOS dock/menu bar and system shutdown
app.on("before-quit", () => {
  isQuitting = true;
  stopAutoUpdater();
});

// Prevent app from quitting when all windows are closed (tray keeps it alive)
app.on("window-all-closed", () => {
  // Do nothing — tray keeps the app running
});
