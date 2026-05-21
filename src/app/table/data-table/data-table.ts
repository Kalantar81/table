import { CommonModule } from '@angular/common';
import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  linkedSignal,
  OnDestroy,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  ColumnFilterState,
  ColumnFilterType,
  DataTableColumn,
  FilterMatchMode,
  SortState,
  defaultMatchMode,
  matchModesFor,
} from './data-table-types';

interface PreparedColumnFilter {
  field: string;
  matchMode: FilterMatchMode;
  rawValue: any;
  textValue: string;
  numberValue: number;
  dateMs: number;
}

interface GlobalFilter {
  q: string;
  fields: string[];
}

interface ColumnIndex {
  filterType: ColumnFilterType | undefined;
  collator: boolean;
  raw: any[];
  lower: string[];
  num?: Float64Array;
  ms?: Float64Array;
  categoryIndex?: Map<string, Uint32Array>;
}

interface Dataset<T> {
  rows: T[];
  rowCount: number;
  byField: Map<string, ColumnIndex>;
  allIndices: Uint32Array;
}

const HEAVY_THRESHOLD = 50_000;
const EMPTY_INDICES = new Uint32Array(0);
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

@Component({
  selector: 'app-data-table',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule],
  templateUrl: './data-table.html',
  styleUrl: './data-table.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DataTable<T extends Record<string, any> = any> implements OnDestroy {
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly columns = input.required<DataTableColumn<T>[]>();
  readonly value = input.required<T[]>();
  readonly rowsPerPageOptions = input<number[]>([5, 10, 25, 50]);
  readonly initialRows = input<number>(10);
  readonly stripedRows = input<boolean>(true);
  readonly showGridlines = input<boolean>(false);
  readonly emptyMessage = input<string>('No records found');
  readonly globalFilterFields = input<string[]>([]);
  readonly trackBy = input<(row: T, index: number) => unknown>();
  readonly virtualScroll = input<boolean>(true);
  readonly rowHeight = input<number>(41);
  readonly globalFilterDebounceMs = input<number>(200);

  readonly sort = signal<SortState | null>(null);
  readonly filters = signal<Record<string, ColumnFilterState>>({});
  readonly first = signal<number>(0);
  readonly rows = linkedSignal(() => this.initialRows());
  readonly openFilterField = signal<string | null>(null);

  readonly globalFilterValue = signal<string>('');
  private readonly globalFilter = signal<string>('');
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;

  readonly selectedSearchFields = signal<string[]>([]);
  readonly searchColumnsMenuOpen = signal<boolean>(false);

  readonly loading = signal<boolean>(false);

  private readonly dataset = signal<Dataset<T> | null>(null);
  private readonly sortedIndices = signal<Uint32Array>(EMPTY_INDICES);

  private datasetSeq = 0;
  private pipelineSeq = 0;
  private datasetRaf = 0;
  private pipelineRaf = 0;

  private readonly viewport = viewChild(CdkVirtualScrollViewport);

  readonly selectedSearchColumns = computed(() => {
    const selected = this.selectedSearchFields();
    const cols = this.columns();
    return selected
      .map((f) => cols.find((c) => c.field === f))
      .filter((c): c is DataTableColumn<T> => !!c);
  });

  constructor() {
    effect((onCleanup) => {
      const open = this.openFilterField();
      if (!open) return;
      const handler = (e: MouseEvent) => this.handleDocClick(e);
      document.addEventListener('click', handler, true);
      onCleanup(() => document.removeEventListener('click', handler, true));
    });

    effect((onCleanup) => {
      if (!this.searchColumnsMenuOpen()) return;
      const handler = (e: MouseEvent) => this.handleSearchColumnsDocClick(e);
      document.addEventListener('click', handler, true);
      onCleanup(() => document.removeEventListener('click', handler, true));
    });

    effect(() => {
      const rows = this.value() ?? [];
      const cols = this.columns();
      untracked(() => this.scheduleDatasetBuild(rows, cols));
    });

    effect(() => {
      const ds = this.dataset();
      const prepared = this.preparedFilters();
      const global = this.globalFilterContext();
      const sort = this.sort();
      untracked(() => this.schedulePipeline(ds, prepared, global, sort));
    });

    effect(() => {
      this.preparedFilters();
      this.globalFilter();
      untracked(() => this.first.set(0));
    });
  }

  ngOnDestroy() {
    if (this.debounceHandle) clearTimeout(this.debounceHandle);
    if (this.datasetRaf) cancelAnimationFrame(this.datasetRaf);
    if (this.pipelineRaf) cancelAnimationFrame(this.pipelineRaf);
  }

  private scheduleDatasetBuild(rows: T[], cols: DataTableColumn<T>[]) {
    const seq = ++this.datasetSeq;
    if (this.datasetRaf) cancelAnimationFrame(this.datasetRaf);

    const heavy = rows.length >= HEAVY_THRESHOLD;

    const run = () => {
      this.datasetRaf = 0;
      if (seq !== this.datasetSeq) return;
      const ds = buildDataset(rows, cols);
      ++this.pipelineSeq;
      if (this.pipelineRaf) cancelAnimationFrame(this.pipelineRaf);
      this.pipelineRaf = 0;
      this.dataset.set(ds);
    };

    if (heavy) {
      this.loading.set(true);
      this.datasetRaf = requestAnimationFrame(run);
    } else {
      run();
    }
  }

  private schedulePipeline(
    ds: Dataset<T> | null,
    prepared: PreparedColumnFilter[],
    global: GlobalFilter | null,
    sort: SortState | null,
  ) {
    const seq = ++this.pipelineSeq;
    if (this.pipelineRaf) cancelAnimationFrame(this.pipelineRaf);
    this.pipelineRaf = 0;

    if (!ds) {
      this.sortedIndices.set(EMPTY_INDICES);
      return;
    }

    const heavy = ds.rowCount >= HEAVY_THRESHOLD;

    const run = () => {
      this.pipelineRaf = 0;
      if (seq !== this.pipelineSeq) return;
      const filtered = runFilter(ds, prepared, global);
      if (seq !== this.pipelineSeq) return;
      const sorted = runSort(filtered, ds, sort);
      if (seq !== this.pipelineSeq) return;
      this.sortedIndices.set(sorted);
      this.loading.set(false);
    };

    if (heavy) {
      this.loading.set(true);
      this.pipelineRaf = requestAnimationFrame(run);
    } else {
      run();
    }
  }

  private readonly preparedFilters = computed<PreparedColumnFilter[]>(() => {
    const filters = this.filters();
    const cols = this.columns();
    const out: PreparedColumnFilter[] = [];
    for (const col of cols) {
      const f = filters[col.field];
      if (!f) continue;
      const v = f.value;
      if (v === null || v === undefined || v === '') continue;
      const text = String(v).toLowerCase();
      const num = Number(v);
      const dateMs = new Date(v).getTime();
      out.push({
        field: col.field,
        matchMode: f.matchMode,
        rawValue: v,
        textValue: text,
        numberValue: num,
        dateMs: Number.isFinite(dateMs) ? dateMs : NaN,
      });
    }
    return out;
  });

  private readonly globalFilterContext = computed<GlobalFilter | null>(() => {
    const q = this.globalFilter().trim().toLowerCase();
    if (!q) return null;
    const cols = this.columns();
    const selected = this.selectedSearchFields();
    const input = this.globalFilterFields();
    const fields =
      selected.length > 0 ? selected : input.length > 0 ? input : cols.map((c) => c.field);
    return { q, fields };
  });

  readonly totalRecords = computed<number>(() => this.sortedIndices().length);

  readonly pagedValue = computed<T[]>(() => {
    const idx = this.sortedIndices();
    const ds = this.dataset();
    if (!ds || idx.length === 0) return [];
    const start = this.first();
    const end = Math.min(start + this.rows(), idx.length);
    if (end <= start) return [];
    const out: T[] = new Array(end - start);
    const rows = ds.rows;
    for (let i = start; i < end; i++) {
      out[i - start] = rows[idx[i]];
    }
    return out;
  });

  readonly currentPage = computed<number>(() =>
    Math.floor(this.first() / Math.max(this.rows(), 1)),
  );

  readonly totalPages = computed<number>(() =>
    Math.max(1, Math.ceil(this.totalRecords() / Math.max(this.rows(), 1))),
  );

  readonly pageNumbers = computed<number[]>(() => {
    const total = this.totalPages();
    const current = this.currentPage();
    const window = 2;
    let from = Math.max(0, current - window);
    let to = Math.min(total - 1, current + window);
    if (to - from < window * 2) {
      if (from === 0) to = Math.min(total - 1, from + window * 2);
      else if (to === total - 1) from = Math.max(0, to - window * 2);
    }
    const out: number[] = [];
    for (let i = from; i <= to; i++) out.push(i);
    return out;
  });

  readonly columnTracks = computed(() =>
    this.columns()
      .map((c) => c.width ?? 'minmax(120px, 1fr)')
      .join(' '),
  );

  readonly trackRow = computed(() => {
    const userFn = this.trackBy();
    if (userFn) return (i: number, row: T) => userFn(row, i);
    return (i: number, row: T) => {
      const v = (row as any).id;
      return v !== undefined ? v : i;
    };
  });

  onSort(col: DataTableColumn<T>) {
    if (!col.sortable) return;
    const s = this.sort();
    if (!s || s.field !== col.field) {
      this.sort.set({ field: col.field, order: 1 });
    } else if (s.order === 1) {
      this.sort.set({ field: col.field, order: -1 });
    } else {
      this.sort.set(null);
    }
    this.first.set(0);
  }

  sortIcon(col: DataTableColumn<T>): 'asc' | 'desc' | 'none' {
    const s = this.sort();
    if (!s || s.field !== col.field) return 'none';
    return s.order === 1 ? 'asc' : 'desc';
  }

  toggleFilter(field: string) {
    this.openFilterField.set(this.openFilterField() === field ? null : field);
  }

  closeFilter() {
    this.openFilterField.set(null);
  }

  isFilterActive(field: string): boolean {
    const f = this.filters()[field];
    return !!f && f.value !== null && f.value !== undefined && f.value !== '';
  }

  filterFor(col: DataTableColumn<T>): ColumnFilterState {
    return (
      this.filters()[col.field] ?? {
        value: null,
        matchMode: defaultMatchMode(col.filterType),
      }
    );
  }

  setFilterValue(col: DataTableColumn<T>, value: any) {
    const current = this.filterFor(col);
    this.filters.update((m) => ({ ...m, [col.field]: { ...current, value } }));
  }

  setFilterMatchMode(col: DataTableColumn<T>, matchMode: FilterMatchMode) {
    const current = this.filterFor(col);
    this.filters.update((m) => ({ ...m, [col.field]: { ...current, matchMode } }));
  }

  clearFilter(col: DataTableColumn<T>) {
    this.filters.update((m) => {
      const next = { ...m };
      delete next[col.field];
      return next;
    });
    this.closeFilter();
  }

  matchModes(col: DataTableColumn<T>) {
    return matchModesFor(col.filterType);
  }

  onGlobalFilter(value: string) {
    this.globalFilterValue.set(value);
    if (this.debounceHandle) clearTimeout(this.debounceHandle);
    const ms = this.globalFilterDebounceMs();
    if (ms <= 0) {
      this.globalFilter.set(value);
      return;
    }
    this.debounceHandle = setTimeout(() => this.globalFilter.set(value), ms);
  }

  goToPage(page: number) {
    const safe = Math.min(Math.max(0, page), this.totalPages() - 1);
    this.first.set(safe * this.rows());
  }

  goFirst() {
    this.first.set(0);
  }

  goPrev() {
    this.goToPage(this.currentPage() - 1);
  }

  goNext() {
    this.goToPage(this.currentPage() + 1);
  }

  goLast() {
    this.goToPage(this.totalPages() - 1);
  }

  onRowsChange(rows: number) {
    this.rows.set(Number(rows));
    this.first.set(0);
    requestAnimationFrame(() => this.viewport()?.scrollToOffset(0));
  }

  rangeText(): string {
    const total = this.totalRecords();
    if (total === 0) return 'Showing 0 of 0 entries';
    const start = this.first() + 1;
    const end = Math.min(this.first() + this.rows(), total);
    return `Showing ${start} to ${end} of ${total} entries`;
  }

  private handleDocClick(e: MouseEvent) {
    const target = e.target as Node;
    if (!this.host.nativeElement.contains(target)) {
      this.closeFilter();
      return;
    }
    const overlay = this.host.nativeElement.querySelector('.dt-filter-overlay');
    const trigger = this.host.nativeElement.querySelector('.dt-filter-trigger.is-open');
    if (overlay && overlay.contains(target)) return;
    if (trigger && trigger.contains(target)) return;
    this.closeFilter();
  }

  toggleSearchColumnsMenu() {
    this.searchColumnsMenuOpen.update((v) => !v);
  }

  closeSearchColumnsMenu() {
    this.searchColumnsMenuOpen.set(false);
  }

  isSearchFieldSelected(field: string): boolean {
    return this.selectedSearchFields().includes(field);
  }

  toggleSearchField(field: string) {
    this.selectedSearchFields.update((list) =>
      list.includes(field) ? list.filter((f) => f !== field) : [...list, field],
    );
  }

  removeSearchField(field: string) {
    this.selectedSearchFields.update((list) => list.filter((f) => f !== field));
  }

  clearAllSearchFields() {
    this.selectedSearchFields.set([]);
  }

  private handleSearchColumnsDocClick(e: MouseEvent) {
    const target = e.target as Node;
    if (!this.host.nativeElement.contains(target)) {
      this.closeSearchColumnsMenu();
      return;
    }
    const overlay = this.host.nativeElement.querySelector('.dt-search-cols-overlay');
    const trigger = this.host.nativeElement.querySelector('.dt-search-cols-trigger');
    if (overlay && overlay.contains(target)) return;
    if (trigger && trigger.contains(target)) return;
    this.closeSearchColumnsMenu();
  }

  protected readonly Math = Math;
}

function buildDataset<T extends Record<string, any>>(
  rows: T[],
  cols: DataTableColumn<T>[],
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

function runFilter<T>(
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

function runSort<T>(
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
