/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/preact";
import { I18nProvider } from "../../../../../shared/i18n/context";
import { SettingItemControl } from "../SettingItemControl";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SettingItemControl", () => {
  it("renders label and children", () => {
    render(
      <I18nProvider>
        <SettingItemControl label="Test Setting" hint="Test hint">
          <input type="text" id="test-input" />
        </SettingItemControl>
      </I18nProvider>
    );

    expect(screen.getByText("Test Setting")).not.toBeNull();
    expect(screen.getByText("Test hint")).not.toBeNull();
    expect(document.getElementById("test-input")).not.toBeNull();
  });

  it("shows save button when isDirty is true and calls onSave when clicked", async () => {
    const onSave = vi.fn();
    render(
      <I18nProvider>
        <SettingItemControl label="Test Setting" isDirty={true} onSave={onSave}>
          <input type="text" value="new-value" />
        </SettingItemControl>
      </I18nProvider>
    );

    const saveBtn = screen.getByTitle("Save");
    expect(saveBtn).not.toBeNull();
    fireEvent.click(saveBtn);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("shows spinner when saving is true", () => {
    render(
      <I18nProvider>
        <SettingItemControl label="Test Setting" isDirty={true} saving={true}>
          <input type="text" value="new-value" />
        </SettingItemControl>
      </I18nProvider>
    );

    expect(screen.queryByTitle("Save")).toBeNull();
    expect(screen.getByTitle("Saving...")).not.toBeNull();
  });

  it("shows restart badge when requiresRestart is true and saved edge fires", () => {
    const { rerender } = render(
      <I18nProvider>
        <SettingItemControl label="Test Setting" saved={false} requiresRestart={true}>
          <input type="text" value="8080" />
        </SettingItemControl>
      </I18nProvider>
    );

    // Simulate a real save: parent flips saved false->true.
    rerender(
      <I18nProvider>
        <SettingItemControl label="Test Setting" saved={true} requiresRestart={true}>
          <input type="text" value="8080" />
        </SettingItemControl>
      </I18nProvider>
    );

    expect(screen.getByText("Restart required")).not.toBeNull();
  });

  it("does not show saved badge on initial mount even when saved is already true", () => {
    render(
      <I18nProvider>
        <SettingItemControl label="Test Setting" saved={true} requiresRestart={false}>
          <input type="text" value="model-name" />
        </SettingItemControl>
      </I18nProvider>
    );

    // A sticky `saved` prop is not a save; the badge must only appear after the
    // actual save edge so reverting an edit does not show a false "Saved".
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("shows saved badge when saved edge fires without restart", () => {
    const { rerender } = render(
      <I18nProvider>
        <SettingItemControl label="Test Setting" saved={false} requiresRestart={false}>
          <input type="text" value="model-name" />
        </SettingItemControl>
      </I18nProvider>
    );

    // Simulate a real save: parent flips saved false->true.
    rerender(
      <I18nProvider>
        <SettingItemControl label="Test Setting" saved={true} requiresRestart={false}>
          <input type="text" value="model-name" />
        </SettingItemControl>
      </I18nProvider>
    );

    expect(screen.getByText("Saved")).not.toBeNull();
  });
});
