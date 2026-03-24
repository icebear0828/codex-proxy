/**
 * Structured YAML file mutation — parse, mutate, write back.
 *
 * Avoids fragile regex-based replacements.
 * Note: js-yaml.dump() does not preserve comments.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import yaml from "js-yaml";

/**
 * Load a YAML file, apply a mutator function, and atomically write it back.
 * Uses tmp-file + rename for crash safety.
 * Creates the file (and parent directories) if it doesn't exist.
 */
export function mutateYaml(filePath: string, mutator: (data: Record<string, unknown>) => void): void {
  let data: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, "utf-8");
    data = (yaml.load(raw) as Record<string, unknown>) ?? {};
  } else {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  mutator(data);
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, yaml.dump(data, { lineWidth: -1, quotingType: '"' }), "utf-8");
  renameSync(tmp, filePath);
}
