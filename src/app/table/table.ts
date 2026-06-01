import { Component, computed, resource } from '@angular/core';
import { httpResource } from '@angular/common/http';

import { DataTable } from './data-table/data-table';
import { TableConfig } from './table-config';
import { extractRows, mapRecord, TableRow } from './field-mapping';

/** Hard ceiling on how many rows we will request, regardless of config. */
const MAX_ENTITIES = 100_000;
/** FakerAPI caps each request at 1000 rows. */
const PAGE_SIZE = 1000;

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
   * Rows fetched from the configured online source and shaped according to the
   * config's `fields` mapping, so the row interface is fully data-driven. The
   * source is paged (PAGE_SIZE rows per request) until `count` (capped at
   * MAX_ENTITIES) rows are collected.
   */
  readonly data = resource({
    params: () => {
      const cfg = this.config.value();
      if (!cfg?.dataUrl) return undefined;
      return {
        url: cfg.dataUrl,
        count: Math.min(Math.max(cfg.count ?? 0, 0), MAX_ENTITIES),
        rowsPath: cfg.rowsPath,
        quantityParam: cfg.quantityParam ?? '_quantity',
        fields: cfg.fields,
      };
    },
    loader: async ({ params, abortSignal }) => {
      const rows: TableRow[] = [];
      for (let fetched = 0; fetched < params.count; fetched += PAGE_SIZE) {
        const quantity = Math.min(PAGE_SIZE, params.count - fetched);
        const url = new URL(params.url);
        if (params.quantityParam) url.searchParams.set(params.quantityParam, String(quantity));
        const res = await fetch(url, { signal: abortSignal });
        if (!res.ok) break; // e.g. rate-limited (HTTP 429) — keep what we already have
        const json: unknown = await res.json();
        for (const record of extractRows(json, params.rowsPath)) {
          rows.push(mapRecord(record, rows.length, params.fields));
        }
      }
      return rows;
    },
  });

  readonly rows = computed<TableRow[]>(() => this.data.value() ?? []);

  trackById = (row: TableRow, index: number) => row['id'] ?? index;
}
