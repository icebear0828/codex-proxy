import { describe, expect, it } from "vitest";
import { shouldAutoOpenUpdateModal } from "../../../web/src/update-modal-policy.js";

describe("update modal auto-open policy", () => {
  it("does not auto-open by default when update popup setting is off", () => {
    expect(shouldAutoOpenUpdateModal({
      hasUpdate: true,
      previousHasUpdate: false,
      mode: "git",
      showUpdateDialog: false,
    })).toBe(false);
  });

  it("auto-opens for new git updates when update popup setting is on", () => {
    expect(shouldAutoOpenUpdateModal({
      hasUpdate: true,
      previousHasUpdate: false,
      mode: "git",
      showUpdateDialog: true,
    })).toBe(true);
  });

  it("does not auto-open for electron updates", () => {
    expect(shouldAutoOpenUpdateModal({
      hasUpdate: true,
      previousHasUpdate: false,
      mode: "electron",
      showUpdateDialog: true,
    })).toBe(false);
  });
});
