import { ColumnFilterType, FilterMatchMode, SortState } from './data-table-types';

export interface PreparedColumnFilter {
  field: string;
  matchMode: FilterMatchMode;
  rawValue: any;
  textValue: string;
  numberValue: number;
  dateMs: number;
}

export interface GlobalFilter {
  q: string;
  fields: string[];
}

export interface ColumnIndex {
  filterType: ColumnFilterType | undefined;
  collator: boolean;
  raw: any[];
  lower: string[];
  num?: Float64Array;
  ms?: Float64Array;
  categoryIndex?: Map<string, Uint32Array>;
}

export interface Dataset<T> {
  rows: T[];
  rowCount: number;
  byField: Map<string, ColumnIndex>;
  allIndices: Uint32Array;
}

/** Minimal column shape needed to build the dataset; transferable to the worker. */
export interface ColumnMeta {
  field: string;
  filterType?: ColumnFilterType;
  collator?: boolean;
}

export const EMPTY_INDICES = new Uint32Array(0);
export const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function buildDataset<T extends Record<string, any>>(
  rows: T[],
  cols: ColumnMeta[],
): Dataset<T> {
  const n = rows.length;
  const byField = new Map<string, ColumnIndex>();
  for (const col of cols) {
    const raw: any[] = new Array(n);
    const lower: string[] = new Array(n);
    let num: Float64Array | undefined;
    let ms: Float64Array | undefined;
    if (col.filterType === 'numeric') num = new Float64Array(n);
    if (col.filterType === 'date') ms = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = rows[i][col.field];
      raw[i] = v;
      lower[i] = v == null ? '' : String(v).toLowerCase();
      if (num) num[i] = v == null ? NaN : Number(v);
      if (ms) ms[i] = v == null ? NaN : new Date(v as any).getTime();
    }
    byField.set(col.field, {
      filterType: col.filterType,
      collator: !!col.collator,
      raw,
      lower,
      num,
      ms,
    });
  }
  const allIndices = new Uint32Array(n);
  for (let i = 0; i < n; i++) allIndices[i] = i;
  return { rows, rowCount: n, byField, allIndices };
}

/** Runs filtering then sorting and returns the resulting row indices. */
export function runPipeline<T>(
  ds: Dataset<T>,
  prepared: PreparedColumnFilter[],
  global: GlobalFilter | null,
  sort: SortState | null,
): Uint32Array {
  const filtered = runFilter(ds, prepared, global);
  return runSort(filtered, ds, sort);
}

export function runFilter<T>(
  ds: Dataset<T>,
  prepared: PreparedColumnFilter[],
  global: GlobalFilter | null,
): Uint32Array {
  if (prepared.length === 0 && !global) return ds.allIndices;

  const n = ds.rowCount;

  if (prepared.length === 1 && !global && isCategoricalEquals(prepared[0], ds)) {
    return getCategoryIndices(ds.byField.get(prepared[0].field)!, prepared[0].textValue);
  }

  const preparedCols: (ColumnIndex | undefined)[] = prepared.map((pf) =>
    ds.byField.get(pf.field),
  );
  const globalCols: (ColumnIndex | undefined)[] = global
    ? global.fields.map((f) => ds.byField.get(f))
    : [];
  const q = global?.q ?? '';

  const out = new Uint32Array(n);
  let count = 0;

  for (let i = 0; i < n; i++) {
    let keep = true;
    for (let j = 0; j < prepared.length; j++) {
      const col = preparedCols[j];
      if (!col || !matchesCell(col, i, prepared[j])) {
        keep = false;
        break;
      }
    }
    if (keep && global) {
      let hit = false;
      for (let j = 0; j < globalCols.length; j++) {
        const col = globalCols[j];
        if (!col) continue;
        if (col.lower[i].includes(q)) {
          hit = true;
          break;
        }
      }
      if (!hit) keep = false;
    }
    if (keep) out[count++] = i;
  }
  return count === n ? ds.allIndices : out.slice(0, count);
}

function isCategoricalEquals<T>(pf: PreparedColumnFilter, ds: Dataset<T>): boolean {
  if (pf.matchMode !== 'equals') return false;
  const col = ds.byField.get(pf.field);
  if (!col) return false;
  return col.filterType === 'text' || col.filterType === undefined;
}

function getCategoryIndices(col: ColumnIndex, valueLower: string): Uint32Array {
  if (!col.categoryIndex) buildCategoryIndex(col);
  return col.categoryIndex!.get(valueLower) ?? EMPTY_INDICES;
}

function buildCategoryIndex(col: ColumnIndex) {
  const lower = col.lower;
  const tmp = new Map<string, number[]>();
  for (let i = 0; i < lower.length; i++) {
    const v = lower[i];
    const arr = tmp.get(v);
    if (arr) arr.push(i);
    else tmp.set(v, [i]);
  }
  const final = new Map<string, Uint32Array>();
  tmp.forEach((arr, k) => final.set(k, Uint32Array.from(arr)));
  col.categoryIndex = final;
}

function matchesCell(col: ColumnIndex, i: number, pf: PreparedColumnFilter): boolean {
  const raw = col.raw[i];
  if (raw === null || raw === undefined) return false;
  switch (pf.matchMode) {
    case 'startsWith':
      return col.lower[i].startsWith(pf.textValue);
    case 'contains':
      return col.lower[i].includes(pf.textValue);
    case 'notContains':
      return !col.lower[i].includes(pf.textValue);
    case 'endsWith':
      return col.lower[i].endsWith(pf.textValue);
    case 'equals':
      if (col.num) return col.num[i] === pf.numberValue;
      if (typeof raw === 'boolean') return raw === pf.rawValue;
      return col.lower[i] === pf.textValue;
    case 'notEquals':
      if (col.num) return col.num[i] !== pf.numberValue;
      if (typeof raw === 'boolean') return raw !== pf.rawValue;
      return col.lower[i] !== pf.textValue;
    case 'lt':
      return (col.num ? col.num[i] : Number(raw)) < pf.numberValue;
    case 'lte':
      return (col.num ? col.num[i] : Number(raw)) <= pf.numberValue;
    case 'gt':
      return (col.num ? col.num[i] : Number(raw)) > pf.numberValue;
    case 'gte':
      return (col.num ? col.num[i] : Number(raw)) >= pf.numberValue;
    case 'dateIs':
      return sameDayMs(col.ms ? col.ms[i] : new Date(raw).getTime(), pf.dateMs);
    case 'dateIsNot':
      return !sameDayMs(col.ms ? col.ms[i] : new Date(raw).getTime(), pf.dateMs);
    case 'dateBefore':
      return (col.ms ? col.ms[i] : new Date(raw).getTime()) < pf.dateMs;
    case 'dateAfter':
      return (col.ms ? col.ms[i] : new Date(raw).getTime()) > pf.dateMs;
    default:
      return true;
  }
}

export function runSort<T>(
  indices: Uint32Array,
  ds: Dataset<T>,
  sort: SortState | null,
): Uint32Array {
  if (!sort) return indices;
  const col = ds.byField.get(sort.field);
  if (!col) return indices;

  const order = sort.order;
  const result = new Uint32Array(indices);

  if (col.num) {
    const num = col.num;
    result.sort((a, b) => {
      const va = num[a];
      const vb = num[b];
      if (Number.isNaN(va)) return Number.isNaN(vb) ? 0 : 1;
      if (Number.isNaN(vb)) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * order;
    });
  } else if (col.ms) {
    const ms = col.ms;
    result.sort((a, b) => {
      const va = ms[a];
      const vb = ms[b];
      if (Number.isNaN(va)) return Number.isNaN(vb) ? 0 : 1;
      if (Number.isNaN(vb)) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * order;
    });
  } else {
    const lower = col.lower;
    if (col.collator) {
      result.sort((a, b) => COLLATOR.compare(lower[a], lower[b]) * order);
    } else {
      result.sort((a, b) => {
        const xa = lower[a];
        const xb = lower[b];
        return (xa < xb ? -1 : xa > xb ? 1 : 0) * order;
      });
    }
  }
  return result;
}

function sameDayMs(cellMs: number, refMs: number): boolean {
  if (!Number.isFinite(cellMs) || !Number.isFinite(refMs)) return false;
  const da = new Date(cellMs);
  const db = new Date(refMs);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}
