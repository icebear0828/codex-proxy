import { createPlatformVitestConfig, createVitestConfig } from "./vitest.shared-config.js";

const hostPlatform = process.platform === "win32"
  ? "windows"
  : process.platform === "linux"
    ? "linux"
    : null;

// `npm test` automatically selects the native Windows or Linux suite. Keep the
// historical complete suite on other hosts such as macOS.
export default hostPlatform
  ? createPlatformVitestConfig(hostPlatform)
  : createVitestConfig();
