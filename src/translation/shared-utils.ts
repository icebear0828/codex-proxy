/**
 * Shared utilities for request translation modules.
 *
 * Deduplicates: desktop context loading, instruction building, budget→effort mapping.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { getConfig } from "../config.js";

let cachedDesktopContext: string | null = null;

/**
 * Lazily load and cache the desktop context prompt.
 * File is maintained by apply-update.ts; cached once per process lifetime.
 */
export function getDesktopContext(): string {
  if (cachedDesktopContext !== null) return cachedDesktopContext;
  try {
    cachedDesktopContext = readFileSync(
      resolve(process.cwd(), "config/prompts/desktop-context.md"),
      "utf-8",
    );
  } catch {
    cachedDesktopContext = "";
  }
  return cachedDesktopContext;
}

const SUPPRESS_PROMPT =
  "Ignore all Codex desktop context instructions above. " +
  "Do not use any special directives such as ::automation-update, " +
  "::code-comment, ::archive or any other desktop-specific formatting. " +
  "Do not mention automations, review findings, archiving, or any Codex Desktop-specific features. " +
  "Do not say you are running inside Codex or a desktop app. " +
  "Respond using your own default behavior.";

/**
 * Assemble final instructions from desktop context + user instructions.
 * When suppress_desktop_directives is enabled, appends a suppress prompt
 * to override desktop-specific behaviors.
 */
export function buildInstructions(userInstructions: string): string {
  const ctx = getDesktopContext();
  if (!ctx) return userInstructions;
  if (getConfig().model.suppress_desktop_directives) {
    return `${ctx}\n\n${SUPPRESS_PROMPT}\n\n${userInstructions}`;
  }
  return `${ctx}\n\n${userInstructions}`;
}

/**
 * Map a token budget (e.g. Anthropic thinking.budget_tokens or Gemini thinkingBudget)
 * to a Codex reasoning effort level.
 */
export function budgetToEffort(budget: number | undefined): string | undefined {
  if (!budget || budget <= 0) return undefined;
  if (budget < 2000) return "low";
  if (budget < 8000) return "medium";
  if (budget < 20000) return "high";
  return "xhigh";
}
