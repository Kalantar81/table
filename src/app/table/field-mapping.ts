/**
 * Declarative mapping from a raw source record (as returned by `dataUrl`) to a
 * table row. Lets the row "interface" be defined in `table.config.json` instead
 * of in TypeScript, so switching data sources is a config change only.
 */
export type FieldMapping =
  /** Shorthand: dot-notation path into the source record, e.g. "address.country". */
  | string
  /** Path with a fallback used when the resolved value is `undefined`. */
  | { path: string; default?: unknown }
  /** `${a} ${b.c}` template interpolated over the source record's paths. */
  | { template: string }
  /** Synthetic 1-based (or `start`-based) row number, ignoring the source. */
  | { type: 'index'; start?: number };

/** A table row whose fields are data-driven rather than statically typed. */
export type TableRow = Record<string, unknown>;

/** Resolves a dot-notation path inside an arbitrary value. */
function valueAtPath(record: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc != null && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, record);
}

/** Replaces every `${path}` in `template` with the source value (missing → ""). */
function interpolate(template: string, record: unknown): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    const v = valueAtPath(record, expr.trim());
    return v == null ? '' : String(v);
  });
}

function mapValue(mapping: FieldMapping, record: unknown, index: number): unknown {
  if (typeof mapping === 'string') {
    return valueAtPath(record, mapping);
  }
  if ('template' in mapping) {
    return interpolate(mapping.template, record);
  }
  if ('type' in mapping) {
    return (mapping.start ?? 1) + index;
  }
  const v = valueAtPath(record, mapping.path);
  return v === undefined ? mapping.default : v;
}

/**
 * Maps a single raw record to a table row according to `fields`. `index` is the
 * zero-based position in the dataset (used by `index` mappings). When `fields`
 * is omitted, the record is passed through unchanged (flat source arrays).
 */
export function mapRecord(
  record: unknown,
  index: number,
  fields?: Record<string, FieldMapping>,
): TableRow {
  if (!fields) return (record ?? {}) as TableRow;
  const row: TableRow = {};
  for (const [field, mapping] of Object.entries(fields)) {
    row[field] = mapValue(mapping, record, index);
  }
  return row;
}

/**
 * Extracts the row array from a fetched JSON envelope. `rowsPath` is a
 * dot-notation path to where the array lives (e.g. "data"); when omitted the
 * top-level value is expected to be the array.
 */
export function extractRows(json: unknown, rowsPath?: string): unknown[] {
  const node = rowsPath ? valueAtPath(json, rowsPath) : json;
  return Array.isArray(node) ? node : [];
}
