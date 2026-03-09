import type { Config } from "tailwindcss";

export default {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "../shared/**/*.{ts,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        primary: "rgb(var(--primary) / <alpha-value>)",
        "primary-hover": "rgb(var(--primary-hover) / <alpha-value>)",
        "bg-light": "#f6f8f6",
        "bg-dark": "var(--bg-dark, #0d1117)",
        "card-dark": "var(--card-dark, #161b22)",
        "border-dark": "var(--border-dark, #30363d)",
        "text-main": "#e6edf3",
        "text-dim": "rgb(139 148 158 / <alpha-value>)",
      },
      fontFamily: {
        display: [
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "SF Mono",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
      borderRadius: {
        DEFAULT: "0.25rem",
        lg: "0.5rem",
        xl: "0.75rem",
        full: "9999px",
      },
    },
  },
  plugins: [],
} satisfies Config;
