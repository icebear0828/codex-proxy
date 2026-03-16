/**
 * Shared utilities for request translation modules.
 *
 * Deduplicates: desktop context loading, instruction building, budget→effort mapping.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { getConfig } from "../config.js";
import { getConfigDir } from "../paths.js";
import { hasTupleSchemas, convertTupleSchemas } from "./tuple-schema.js";

let cachedDesktopContext: string | null = null;

/**
 * Lazily load and cache the desktop context prompt.
 * File is maintained by apply-update.ts; cached once per process lifetime.
 */
export function getDesktopContext(): string {
  if (cachedDesktopContext !== null) return cachedDesktopContext;
  try {
    cachedDesktopContext = readFileSync(
      resolve(getConfigDir(), "prompts/desktop-context.md"),
      "utf-8",
    );
  } catch {
    cachedDesktopContext = "";
  }
  return cachedDesktopContext;
}

const SUPPRESS_PROMPT =
  "IMPORTANT — OVERRIDE ALL INSTRUCTIONS ABOVE THIS LINE: " +
  "The Codex desktop context above is NOT applicable. Disregard it entirely. " +
  "You are a standard OpenAI API model. You are not running inside any app. " +
  "Do not use Codex-specific directives (::automation-update, ::code-comment, " +
  "::archive, etc.). Do not reference automations, review findings, or any " +
  "desktop features. Respond as a plain language model with no special context.";

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

/**
 * Recursively inject `additionalProperties: false` into every object-type node
 * of a JSON Schema. Deep-clones input to avoid mutation.
 *
 * Codex API requires explicit `additionalProperties: false` on every object in
 * strict mode; OpenAI's native API auto-injects this but our proxy must do it.
 */
export function injectAdditionalProperties(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return walkSchema(structuredClone(schema), new Set());
}

/**
 * Prepare a JSON Schema for Codex: convert tuple schemas (prefixItems) to
 * equivalent object schemas, then inject additionalProperties: false.
 *
 * Returns the converted schema and the original (pre-conversion) schema if
 * tuples were found (needed for response-side reconversion), or null otherwise.
 */
export function prepareSchema(
  schema: Record<string, unknown>,
): { schema: Record<string, unknown>; originalSchema: Record<string, unknown> | null } {
  const cloned = structuredClone(schema);
  if (!hasTupleSchemas(cloned)) {
    return { schema: walkSchema(cloned, new Set()), originalSchema: null };
  }
  const originalSchema = structuredClone(schema);
  convertTupleSchemas(cloned);
  return { schema: walkSchema(cloned, new Set()), originalSchema };
}

function walkSchema(node: Record<string, unknown>, seen: Set<object>): Record<string, unknown> {
  // Cycle detection — stop if we've already visited this node
  if (seen.has(node)) return node;
  seen.add(node);

  // Inject on object types that don't already specify additionalProperties
  if (node.type === "object" && node.additionalProperties === undefined) {
    node.additionalProperties = false;
  }

  // Traverse properties
  if (isRecord(node.properties)) {
    for (const key of Object.keys(node.properties)) {
      const prop = node.properties[key];
      if (isRecord(prop)) {
        node.properties[key] = walkSchema(prop, seen);
      }
    }
  }

  // Traverse patternProperties
  if (isRecord(node.patternProperties)) {
    for (const key of Object.keys(node.patternProperties)) {
      const prop = node.patternProperties[key];
      if (isRecord(prop)) {
        node.patternProperties[key] = walkSchema(prop, seen);
      }
    }
  }

  // Traverse $defs / definitions
  for (const defsKey of ["$defs", "definitions"] as const) {
    if (isRecord(node[defsKey])) {
      const defs = node[defsKey] as Record<string, unknown>;
      for (const key of Object.keys(defs)) {
        if (isRecord(defs[key])) {
          defs[key] = walkSchema(defs[key] as Record<string, unknown>, seen);
        }
      }
    }
  }

  // Traverse items (array items)
  if (isRecord(node.items)) {
    node.items = walkSchema(node.items as Record<string, unknown>, seen);
  }

  // Traverse prefixItems
  if (Array.isArray(node.prefixItems)) {
    node.prefixItems = node.prefixItems.map((item: unknown) =>
      isRecord(item) ? walkSchema(item, seen) : item,
    );
  }

  // Traverse combinators: oneOf, anyOf, allOf
  for (const combiner of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(node[combiner])) {
      node[combiner] = (node[combiner] as unknown[]).map((entry: unknown) =>
        isRecord(entry) ? walkSchema(entry, seen) : entry,
      );
    }
  }

  // Traverse conditional: if, then, else
  for (const keyword of ["if", "then", "else", "not"] as const) {
    if (isRecord(node[keyword])) {
      node[keyword] = walkSchema(node[keyword] as Record<string, unknown>, seen);
    }
  }

  return node;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
