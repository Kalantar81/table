import { CommonModule } from '@angular/common';
import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { CdkDrag, CdkDragDrop, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
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
  DataTableColumn,
  FilterMatchMode,
  SortState,
  defaultMatchMode,
  matchModesFor,
} from './data-table-types';
import {
  appendDataset,
  buildDataset,
  Dataset,
  EMPTY_INDICES,
  GlobalFilter,
  PreparedColumnFilter,
  runPipeline,
} from './data-table.pipeline';
import { WorkerResponse } from './data-table.worker-types';

const HEAVY_THRESHOLD = 50_000;

@Component({
  selector: 'app-data-table',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, CdkDropList, CdkDrag],
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
  readonly tableWidth = input<string>('');
  readonly tableHeight = input<string>('');
  readonly horizontalScroll = input<boolean>(false);
  readonly reorderableColumns = input<boolean>(true);

  /**
   * User-controlled column order, as a list of fields. Resets to the order of
   * the `columns` input whenever it changes, then is mutated by drag-and-drop.
   */
  readonly columnOrder = linkedSignal<DataTableColumn<T>[], string[]>({
    source: () => this.columns(),
    computation: (cols) => cols.map((c) => c.field),
  });

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

  /**
   * Last `value`/`columns` handed to the dataset builder. Used to recognise
   * when a new `value` is just the previous one with rows appended (chunked
   * loading), so only the new tail is rebuilt instead of the whole dataset.
   */
  private lastRows: T[] | null = null;
  private lastLen = 0;
  private lastCols: DataTableColumn<T>[] | null = null;

  /** Off-main-thread filter/sort engine; null when Worker is unavailable (SSR/tests). */
  private readonly worker = createPipelineWorker();

  private readonly viewport = viewChild(CdkVirtualScrollViewport);
  private readonly headEl = viewChild<ElementRef<HTMLElement>>('headEl');

  /** Columns in the user-defined display order (driven by `columnOrder`). */
  readonly displayColumns = computed<DataTableColumn<T>[]>(() => {
    const cols = this.columns();
    const order = this.columnOrder();
    const byField = new Map(cols.map((c) => [c.field, c]));
    const ordered = order
      .map((f) => byField.get(f))
      .filter((c): c is DataTableColumn<T> => !!c);
    return ordered.length === cols.length ? ordered : cols;
  });

  readonly selectedSearchColumns = computed(() => {
    const selected = this.selectedSearchFields();
    const cols = this.columns();
    return selected
      .map((f) => cols.find((c) => c.field === f))
      .filter((c): c is DataTableColumn<T> => !!c);
  });

  constructor() {
    if (this.worker) {
      this.worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) =>
        this.onWorkerMessage(data);
    }

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
    this.worker?.terminate();
  }

  private scheduleDatasetBuild(rows: T[], cols: DataTableColumn<T>[]) {
    if (this.datasetRaf) cancelAnimationFrame(this.datasetRaf);
    this.datasetRaf = 0;

    // An append is the previous value with rows added at the end: same columns,
    // strictly longer, and the shared prefix's endpoints are identity-equal.
    const prevRows = this.lastRows;
    const prevLen = this.lastLen;
    const isAppend =
      cols === this.lastCols &&
      prevRows !== null &&
      prevLen > 0 &&
      rows.length > prevLen &&
      rows[0] === prevRows[0] &&
      rows[prevLen - 1] === prevRows[prevLen - 1];

    this.lastRows = rows;
    this.lastLen = rows.length;
    this.lastCols = cols;

    const heavy = rows.length >= HEAVY_THRESHOLD;

    if (this.worker) {
      // The worker owns the full search index; the main thread keeps only a
      // thin dataset for rendering paged rows. On append we ship just the new
      // tail so the worker extends its index instead of rebuilding it.
      if (heavy) this.loading.set(true);
      const meta = cols.map((c) => ({
        field: c.field,
        filterType: c.filterType,
        collator: c.collator,
      }));
      ++this.pipelineSeq;
      if (isAppend) {
        this.worker.postMessage({
          type: 'append',
          datasetSeq: this.datasetSeq,
          rows: rows.slice(prevLen),
          cols: meta,
        });
      } else {
        this.worker.postMessage({ type: 'dataset', datasetSeq: ++this.datasetSeq, rows, cols: meta });
      }
      this.dataset.set({ rows, rowCount: rows.length, byField: new Map(), allIndices: EMPTY_INDICES });
      return;
    }

    const seq = ++this.datasetSeq;
    const run = () => {
      this.datasetRaf = 0;
      if (seq !== this.datasetSeq) return;
      const prev = this.dataset();
      const ds =
        isAppend && prev ? appendDataset(prev, rows.slice(prevLen), cols) : buildDataset(rows, cols);
      ++this.pipelineSeq;
      if (this.pipelineRaf) cancelAnimationFrame(this.pipelineRaf);
      this.pipelineRaf = 0;
      this.dataset.set(isAppend && prev ? { ...ds } : ds);
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

    if (this.worker) {
      // Filtering (incl. global search) and sorting run off the main thread.
      if (heavy) this.loading.set(true);
      this.worker.postMessage({
        type: 'pipeline',
        datasetSeq: this.datasetSeq,
        pipelineSeq: seq,
        prepared,
        global,
        sort,
      });
      return;
    }

    const run = () => {
      this.pipelineRaf = 0;
      if (seq !== this.pipelineSeq) return;
      const sorted = runPipeline(ds, prepared, global, sort);
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

  private onWorkerMessage(data: WorkerResponse) {
    if (data.type !== 'result') return;
    // Drop results superseded by a newer request.
    if (data.pipelineSeq !== this.pipelineSeq) return;
    this.sortedIndices.set(data.indices);
    this.loading.set(false);
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

  readonly columnTracks = computed(() => {
    // With horizontal scroll on, columns keep fixed widths so the grid can
    // grow past the container; otherwise they flex to fill the available width.
    const fallback = this.horizontalScroll() ? '150px' : 'minmax(120px, 1fr)';
    return this.displayColumns()
      .map((c) => c.width ?? fallback)
      .join(' ');
  });

  onColumnDrop(event: CdkDragDrop<DataTableColumn<T>[]>) {
    if (event.previousIndex === event.currentIndex) return;
    this.columnOrder.update((order) => {
      const next = [...order];
      moveItemInArray(next, event.previousIndex, event.currentIndex);
      return next;
    });
  }

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

  /**
   * Keeps the (clipped) header aligned with the body's horizontal scroll
   * position. The body owns the horizontal scrollbar so the vertical one
   * stays pinned to the visible right edge; the header just follows along.
   */
  onBodyScroll(target: EventTarget | null) {
    if (!this.horizontalScroll()) return;
    const head = this.headEl()?.nativeElement;
    if (head) head.style.transform = `translateX(${-(target as HTMLElement).scrollLeft}px)`;
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

/**
 * Creates the dedicated worker that runs filtering (including global search)
 * and sorting off the main thread. Returns null when Worker is not available
 * (e.g. server-side rendering or unit tests) so callers fall back to sync work.
 */
function createPipelineWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./data-table.worker', import.meta.url));
  } catch {
    return null;
  }
}
