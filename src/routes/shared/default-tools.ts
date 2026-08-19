import type { Context } from "hono";
import { getConfig } from "../../config.js";
import type { ClientKeyEntry } from "../../auth/client-key-types.js";
import { isRecord } from "../../translation/shared-utils.js";

export interface ResolveDefaultToolsOptions {
  allowUnauthenticated?: boolean;
  globalDefaultTools?: string[];
}

export function normalizeHostedTool(toolName: string): { type: string } {
  return { type: toolName.trim() };
}

export function resolveDefaultTools(
  c: Context,
  options: ResolveDefaultToolsOptions = {},
): string[] {
  // 1. If request is going to third-party upstream adapter, do not inject hosted tools
  if (options.allowUnauthenticated) {
    return [];
  }

  // 2. Check request-level opt-out headers
  const optOutHeader = (c.req.header("x-codex-default-tools") ?? "").trim().toLowerCase();
  if (
    optOutHeader === "off" ||
    optOutHeader === "false" ||
    optOutHeader === "0" ||
    optOutHeader === "none" ||
    optOutHeader === "disable" ||
    optOutHeader === "disabled"
  ) {
    return [];
  }
  const noDefaultHeader = (c.req.header("x-codex-no-default-tools") ?? "").trim().toLowerCase();
  if (noDefaultHeader === "1" || noDefaultHeader === "true" || noDefaultHeader === "yes") {
    return [];
  }

  // 3. Check client key override
  const authRole = c.get("authRole");
  if (authRole === "client_key") {
    const clientKey = c.get("clientKey") as ClientKeyEntry | undefined;
    if (clientKey && clientKey.default_tools !== undefined && clientKey.default_tools !== null) {
      return clientKey.default_tools;
    }
  }

  // 4. Global configuration
  if (options.globalDefaultTools !== undefined) {
    return options.globalDefaultTools;
  }
  try {
    const config = getConfig();
    return config.model.default_tools ?? [];
  } catch {
    return [];
  }
}

export function mergeDefaultTools<T = Record<string, unknown>>(
  existingTools: T[] | undefined,
  defaultToolNames: string[],
): T[] {
  if (!defaultToolNames || defaultToolNames.length === 0) {
    return existingTools ?? ([] as unknown as T[]);
  }

  const result: unknown[] = Array.isArray(existingTools) ? [...existingTools] : [];

  for (const name of defaultToolNames) {
    const trimmed = name.trim();
    if (!trimmed) continue;

    // Check if tool is already declared
    const alreadyExists = result.some((tool) => {
      if (!isRecord(tool)) return false;
      const type = tool.type;
      if (typeof type !== "string") return false;
      if (type === trimmed) return true;
      if (
        (trimmed === "web_search" || trimmed === "web_search_preview") &&
        (type === "web_search" || type === "web_search_preview" || type === "web_search_20250305")
      ) {
        return true;
      }
      return false;
    });

    if (!alreadyExists) {
      result.push(normalizeHostedTool(trimmed));
    }
  }

  return result as T[];
}
