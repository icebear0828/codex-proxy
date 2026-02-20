/**
 * Structured YAML file mutation — parse, mutate, write back.
 *
 * Avoids fragile regex-based replacements.
 * Note: js-yaml.dump() does not preserve comments.
 */

import { readFileSync, writeFileSync, renameSync } from "fs";
import yaml from "js-yaml";

/**
 * Load a YAML file, apply a mutator function, and atomically write it back.
 * Uses tmp-file + rename for crash safety.
 */
export function mutateYaml(filePath: string, mutator: (data: any) => void): void {
  const raw = readFileSync(filePath, "utf-8");
  const data = yaml.load(raw);
  mutator(data);
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, yaml.dump(data, { lineWidth: -1, quotingType: '"' }), "utf-8");
  renameSync(tmp, filePath);
}
