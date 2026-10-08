import { createPlatformVitestConfig } from "./vitest.shared-config.js";

// The Electron build/pack/release pipeline tests share a serialized build lock
// and time out on Windows; Linux release/backend CI runs them. Portable
// Electron unit tests remain part of this shared Windows suite.
export default createPlatformVitestConfig("windows");
