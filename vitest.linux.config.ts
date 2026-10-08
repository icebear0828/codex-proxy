import { createPlatformVitestConfig } from "./vitest.shared-config.js";

// Linux runs the complete backend suite, including POSIX shell script tests
// and Electron/native integration coverage.
export default createPlatformVitestConfig("linux");
