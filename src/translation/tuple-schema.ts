/**
 * Tuple schema conversion — bridges JSON Schema `prefixItems` (tuple) to
 * object-based representation that Codex upstream accepts.
 *
 * Request side:  convertTupleSchemas() rewrites prefixItems → properties with numeric keys
 * Response side: reconvertTupleValues() restores {"0":…,"1":…} back to […,…]
 */

type Schema = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── Detection ──────────────────────────────────────────────────────

/** Returns true if the schema tree contains any `prefixItems` node. */
export function hasTupleSchemas(schema: Schema): boolean {
  return walk(schema, new Set());
}

function walk(node: Schema, seen: Set<object>): boolean {
  if (seen.has(node)) return false;
  seen.add(node);

  if (Array.isArray(node.prefixItems)) return true;

  // properties
  if (isRecord(node.properties)) {
    for (const v of Object.values(node.properties)) {
      if (isRecord(v) && walk(v, seen)) return true;
    }
  }

  // items
  if (isRecord(node.items) && walk(node.items as Schema, seen)) return true;

  // combinators
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(node[key])) {
      for (const entry of node[key] as unknown[]) {
        if (isRecord(entry) && walk(entry, seen)) return true;
      }
    }
  }

  // $defs / definitions
  for (const key of ["$defs", "definitions"] as const) {
    if (isRecord(node[key])) {
      for (const v of Object.values(node[key] as Schema)) {
        if (isRecord(v) && walk(v, seen)) return true;
      }
    }
  }

  // conditional
  for (const key of ["if", "then", "else", "not"] as const) {
    if (isRecord(node[key]) && walk(node[key] as Schema, seen)) return true;
  }

  return false;
}

// ── Request-side conversion ────────────────────────────────────────

/**
 * Recursively convert `prefixItems` tuple schemas to equivalent object schemas.
 * Input must be a clone — this function mutates in place and returns the same reference.
 */
export function convertTupleSchemas(node: Schema): Schema {
  return convertWalk(node, new Set());
}

function convertWalk(node: Schema, seen: Set<object>): Schema {
  if (seen.has(node)) return node;
  seen.add(node);

  // Convert this node if it has prefixItems
  if (Array.isArray(node.prefixItems)) {
    const items = node.prefixItems as unknown[];
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (let i = 0; i < items.length; i++) {
      const key = String(i);
      properties[key] = isRecord(items[i]) ? convertWalk(items[i] as Schema, seen) : items[i];
      required.push(key);
    }

    node.type = "object";
    node.properties = properties;
    node.required = required;
    node.additionalProperties = false;
    delete node.prefixItems;
    delete node.items;
    return node;
  }

  // Recurse into properties
  if (isRecord(node.properties)) {
    for (const [k, v] of Object.entries(node.properties)) {
      if (isRecord(v)) node.properties[k] = convertWalk(v, seen);
    }
  }

  // Recurse into items
  if (isRecord(node.items)) {
    node.items = convertWalk(node.items as Schema, seen);
  }

  // Recurse into combinators
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(node[key])) {
      node[key] = (node[key] as unknown[]).map((entry) =>
        isRecord(entry) ? convertWalk(entry, seen) : entry,
      );
    }
  }

  // Recurse into $defs / definitions
  for (const key of ["$defs", "definitions"] as const) {
    if (isRecord(node[key])) {
      const defs = node[key] as Schema;
      for (const [k, v] of Object.entries(defs)) {
        if (isRecord(v)) defs[k] = convertWalk(v, seen);
      }
    }
  }

  // Recurse into conditional
  for (const key of ["if", "then", "else", "not"] as const) {
    if (isRecord(node[key])) {
      node[key] = convertWalk(node[key] as Schema, seen);
    }
  }

  return node;
}

// ── Response-side reconversion ─────────────────────────────────────

/**
 * Schema-guided recursive reconversion: turn {"0":…,"1":…} objects back to arrays
 * wherever the *original* schema had `prefixItems`.
 */
export function reconvertTupleValues(data: unknown, schema: Schema, rootSchema?: Schema): unknown {
  const root = rootSchema ?? schema;

  // Resolve $ref
  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(schema.$ref, root);
    if (resolved) return reconvertTupleValues(data, resolved, root);
    return data;
  }

  // Tuple node: original schema has prefixItems → data should be {"0":…,"1":…} → convert to array
  if (Array.isArray(schema.prefixItems) && isRecord(data)) {
    const items = schema.prefixItems as unknown[];
    const result: unknown[] = [];
    for (let i = 0; i < items.length; i++) {
      const key = String(i);
      const val = data[key];
      const itemSchema = items[i];
      result.push(isRecord(itemSchema) ? reconvertTupleValues(val, itemSchema, root) : val);
    }
    return result;
  }

  // Object with properties → recurse into each property
  if (isRecord(schema.properties) && isRecord(data)) {
    const result: Record<string, unknown> = { ...data };
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in result && isRecord(propSchema)) {
        result[key] = reconvertTupleValues(result[key], propSchema, root);
      }
    }
    return result;
  }

  // Array with items schema → recurse into each element
  if (isRecord(schema.items) && Array.isArray(data)) {
    return data.map((el) => reconvertTupleValues(el, schema.items as Schema, root));
  }

  // Combinators — try to find matching branch (heuristic: first branch that has prefixItems)
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(schema[key])) {
      for (const branch of schema[key] as unknown[]) {
        if (isRecord(branch) && hasTupleSchemas(branch)) {
          return reconvertTupleValues(data, branch, root);
        }
      }
    }
  }

  return data;
}

function resolveRef(ref: string, root: Schema): Schema | undefined {
  // Only handle internal refs: #/$defs/Name or #/definitions/Name
  const match = ref.match(/^#\/(\$defs|definitions)\/(.+)$/);
  if (!match) return undefined;
  const defs = root[match[1]];
  if (!isRecord(defs)) return undefined;
  const resolved = defs[match[2]];
  return isRecord(resolved) ? resolved : undefined;
}
