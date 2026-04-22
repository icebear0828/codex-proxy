import { mkdirSync, rmSync } from "fs";
import { resolve } from "path";

const LOCK_DIR = resolve(import.meta.dirname, ".electron-test-lock");
const RETRY_MS = 50;

export async function acquireElectronTestLock(): Promise<() => void> {
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      await new Promise((resolveRetry) => setTimeout(resolveRetry, RETRY_MS));
    }
  }

  return () => {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  };
}
