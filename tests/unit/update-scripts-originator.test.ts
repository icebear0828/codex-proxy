import { describe, expect, it } from "vitest";
import { extractOriginatorFromMainJs } from "../../scripts/build/extract-fingerprint.js";

const originatorPattern = {
  pattern: "[=:]\\s*[\"'`](Codex [^\"'`]+)[\"'`]",
  group: 1,
};

describe("extract-fingerprint originator extraction", () => {
  it("uses desktopOriginator instead of bundled plugin app names", () => {
    const bundledMainJs = [
      "var Ze=`computer-use`,Qe=`latex-tectonic`,tt=`Codex Computer Use.app`,nt=[`node_modules`];",
      "var Hi=`https://chatgpt.com/backend-api`,Ui=`http://localhost:8000/api`,Wi=`Codex Desktop`,Gi=`codex_desktop`;",
      "var Lv={desktopOriginator:Wi,devApiBaseUrl:Ui,prodApiBaseUrl:Hi};",
    ].join("");

    const originator = extractOriginatorFromMainJs(bundledMainJs, originatorPattern);

    expect(originator).toBe("Codex Desktop");
  });

  it("skips bundled .app names when falling back to the configured pattern", () => {
    const bundledMainJs = [
      "var pluginName=`Codex Computer Use.app`;",
      "var settings={originator:`Codex Desktop`};",
    ].join("");

    const originator = extractOriginatorFromMainJs(bundledMainJs, originatorPattern);

    expect(originator).toBe("Codex Desktop");
  });
});
