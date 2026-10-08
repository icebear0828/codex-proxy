import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Create and reliably remove an isolated test data directory on every OS. */
export function createTestDataDirectory(prefix: string): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), `${prefix}-`));

  return {
    path,
    cleanup: () => rmSync(path, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    }),
  };
}
