import { Component, effect, signal, untracked } from '@angular/core';
import { httpResource } from '@angular/common/http';

import { DataTable } from './data-table/data-table';
import { TableConfig } from './table-config';
import { extractRows, mapRecord, TableRow } from './field-mapping';

/** Hard ceiling on how many rows we will request, regardless of config. */
const MAX_ENTITIES = 100_000;
/** Rows requested per chunk when `chunkSize` is not set in the config. */
const DEFAULT_CHUNK_SIZE = 500;

@Component({
  selector: 'app-table',
  standalone: true,
  imports: [DataTable],
  templateUrl: './table.html',
  styleUrl: './table.less',
})
export class Table {
  /** Table layout (columns, page sizes, row mapping…) loaded at runtime from public/table.config.json. */
  readonly config = httpResource<TableConfig>(() => 'table.config.json');

  /**
   * Rows fetched from the configured online source, shaped according to the
   * config's `fields` mapping. The source is paged (PAGE_SIZE rows per request)
   * and each page is published as soon as it arrives, so the first chunk renders
   * after a single round-trip (~1s) instead of waiting for all pages.
   */
  readonly rows = signal<TableRow[]>([]);
  /** True while pages are still being fetched (the first ones may already be shown). */
  readonly loading = signal<boolean>(false);
  readonly loadError = signal<boolean>(false);

  /** Guards against stale in-flight loads when the config changes mid-flight. */
  private loadSeq = 0;
  private inFlight: AbortController | null = null;

  constructor() {
    effect(() => {
      const cfg = this.config.value();
      untracked(() => this.load(cfg));
    });
  }

  /** Streams rows from the configured source, publishing each page as it lands. */
  private async load(cfg: TableConfig | undefined) {
    this.inFlight?.abort();
    const seq = ++this.loadSeq;

    this.rows.set([]);
    this.loadError.set(false);

    if (!cfg?.dataUrl) {
      this.loading.set(false);
      return;
    }

    const count = Math.min(Math.max(cfg.count ?? 0, 0), MAX_ENTITIES);
    const chunkSize = Math.max(cfg.chunkSize ?? DEFAULT_CHUNK_SIZE, 1);
    const quantityParam = cfg.quantityParam ?? '_quantity';
    const pagination = cfg.pagination;
    const pageStart = pagination?.start ?? 1;
    const abort = new AbortController();
    this.inFlight = abort;
    this.loading.set(true);

    const acc: TableRow[] = [];
    try {
      let page = 0;
      for (let fetched = 0; fetched < count; fetched += chunkSize, page++) {
        const quantity = Math.min(chunkSize, count - fetched);
        const url = new URL(cfg.dataUrl);
        if (quantityParam) url.searchParams.set(quantityParam, String(quantity));
        if (pagination?.param) {
          // "offset" sends rows already fetched; "page" sends an incrementing
          // page number starting at `pageStart`.
          const value = pagination.mode === 'offset' ? fetched : pageStart + page;
          url.searchParams.set(pagination.param, String(value));
        }

        const res = await fetch(url, { signal: abort.signal });
        if (seq !== this.loadSeq) return; // superseded by a newer config
        if (!res.ok) break; // e.g. rate-limited (HTTP 429) — keep what we have

        const json: unknown = await res.json();
        if (seq !== this.loadSeq) return;

        for (const record of extractRows(json, cfg.rowsPath)) {
          acc.push(mapRecord(record, acc.length, cfg.fields));
        }
        // Publish a fresh array so the table re-renders with the new page.
        this.rows.set(acc.slice());
      }
    } catch {
      if (seq === this.loadSeq && !abort.signal.aborted) this.loadError.set(true);
    } finally {
      if (seq === this.loadSeq) this.loading.set(false);
    }
  }

  trackById = (row: TableRow, index: number) => row['id'] ?? index;
}
