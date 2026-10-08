import { describe } from "vitest";

/** Register a suite only where its native runtime is supported. */
export const describePosix = process.platform === "win32" ? describe.skip : describe;

/** Register a suite that exercises Windows-only behavior. */
export const describeWindows = process.platform === "win32" ? describe : describe.skip;
