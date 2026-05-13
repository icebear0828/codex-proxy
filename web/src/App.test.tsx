/** @vitest-environment jsdom */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/preact";
import { I18nProvider } from "../../shared/i18n/context";

let TabBarComponent: typeof import("./App").TabBar;

beforeAll(async () => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });

  const app = await import("./App");
  TabBarComponent = app.TabBar;
});

afterEach(() => {
  cleanup();
});

describe("TabBar", () => {
  it("wraps dashboard tabs instead of forcing horizontal overflow on mobile", () => {
    const { container } = render(
      <I18nProvider>
        <TabBarComponent activeHash="#/accounts" />
      </I18nProvider>,
    );

    const tabBar = container.firstElementChild;
    expect(tabBar?.className).toContain("flex-wrap");
  });
});
