export interface DesktopUpdateState {
  checking: boolean;
  updateAvailable: boolean;
  downloading: boolean;
  downloaded: boolean;
  progress: number;
  version: string | null;
  error: string | null;
}

interface DesktopUpdater {
  getState(): DesktopUpdateState;
  check(): void;
  install(): void;
}

let updater: DesktopUpdater | null = null;
export function setDesktopUpdater(value: DesktopUpdater): void { updater = value; }
export function getDesktopUpdater(): DesktopUpdater | null { return updater; }
