/**
 * Shared utilities for request translation modules.
 *
 * Deduplicates: desktop context loading, instruction building, budget→effort mapping.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

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

/**
 * Assemble final instructions from desktop context + user instructions.
 */
export function buildInstructions(userInstructions: string): string {
  const ctx = getDesktopContext();
  return ctx ? `${ctx}\n\n${userInstructions}` : userInstructions;
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
