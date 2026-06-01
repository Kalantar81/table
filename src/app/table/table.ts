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
  /** No data at all could be loaded (the very first chunk failed). */
  readonly loadError = signal<boolean>(false);
  /** Some rows loaded, but the source was cut short (e.g. a chunk kept failing). */
  readonly partial = signal<boolean>(false);
  /** Total rows the current load is aiming for, for progress display. */
  readonly target = signal<number>(0);

  /** Guards against stale in-flight loads when the config changes mid-flight. */
  private loadSeq = 0;
  private inFlight: AbortController | null = null;

  constructor() {
    effect(() => {
      const cfg = this.config.value();
      untracked(() => this.load(cfg));
    });
  }

  /** Re-runs the load with the current config (e.g. after a partial failure). */
  retry() {
    this.load(this.config.value());
  }

  /** Streams rows from the configured source, publishing each page as it lands. */
  private async load(cfg: TableConfig | undefined) {
    this.inFlight?.abort();
    const seq = ++this.loadSeq;

    this.rows.set([]);
    this.loadError.set(false);
    this.partial.set(false);

    if (!cfg?.dataUrl) {
      this.loading.set(false);
      this.target.set(0);
      return;
    }

    const count = Math.min(Math.max(cfg.count ?? 0, 0), MAX_ENTITIES);
    const chunkSize = Math.max(cfg.chunkSize ?? DEFAULT_CHUNK_SIZE, 1);
    const quantityParam = cfg.quantityParam ?? '_quantity';
    const pagination = cfg.pagination;
    const pageStart = pagination?.start ?? 1;
    const abort = new AbortController();
    this.inFlight = abort;
    this.target.set(count);
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

        const res = await this.fetchChunk(url, abort.signal);
        if (seq !== this.loadSeq) return; // superseded by a newer config

        if (!res || !res.ok) {
          // Chunk failed even after retries: surface a hard error if we have
          // nothing yet, otherwise keep the rows we did manage to load.
          if (acc.length === 0) this.loadError.set(true);
          else this.partial.set(true);
          break;
        }

        const json: unknown = await res.json();
        if (seq !== this.loadSeq) return;

        const before = acc.length;
        for (const record of extractRows(json, cfg.rowsPath)) {
          acc.push(mapRecord(record, acc.length, cfg.fields));
        }
        // Publish a fresh array so the table re-renders with the new page.
        this.rows.set(acc.slice());

        // Source returned fewer rows than asked — it is exhausted, stop cleanly.
        if (acc.length === before) break;
      }
    } catch {
      if (seq === this.loadSeq && !abort.signal.aborted) {
        if (acc.length === 0) this.loadError.set(true);
        else this.partial.set(true);
      }
    } finally {
      if (seq === this.loadSeq) this.loading.set(false);
    }
  }

  /**
   * Fetches one chunk, retrying transient failures (network errors, HTTP 429
   * and 5xx) with exponential backoff. Returns the response (which may still be
   * a non-ok one the caller treats as failure) or null on a network error that
   * exhausted all attempts.
   */
  private async fetchChunk(
    url: URL,
    signal: AbortSignal,
    attempts = 3,
  ): Promise<Response | null> {
    let backoff = 500;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url, { signal });
        if (res.ok) return res;
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= attempts) return res;
      } catch (err) {
        if (signal.aborted) throw err;
        if (attempt >= attempts) return null;
      }
      await delay(backoff, signal);
      backoff *= 2;
    }
  }

  trackById = (row: TableRow, index: number) => row['id'] ?? index;
}

/** Resolves after `ms`, or rejects (AbortError) if `signal` aborts first. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}
