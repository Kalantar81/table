import { Component, computed, resource } from '@angular/core';
import { httpResource } from '@angular/common/http';

import { DataTable } from './data-table/data-table';
import { TableConfig } from './table-config';

interface Customer {
  id: number;
  name: string;
  email: string;
  phone: string;
  gender: string;
  country: string;
  birthday: string;
}

/** FakerAPI person, as returned by https://fakerapi.it/api/v2/persons. */
interface FakerPerson {
  firstname: string;
  lastname: string;
  email: string;
  phone: string;
  gender: string;
  birthday: string;
  address?: { country?: string };
}

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
  /** Table layout (columns, page sizes…) loaded at runtime from public/table.config.json. */
  readonly config = httpResource<TableConfig<Customer>>(() => 'table.config.json');

  /**
   * Rows fetched from the configured online source. FakerAPI returns at most
   * 1000 rows per request, so we page through it until `count` (capped at
   * MAX_ENTITIES) rows are collected.
   */
  readonly data = resource({
    params: () => {
      const cfg = this.config.value();
      if (!cfg?.dataUrl) return undefined;
      return {
        url: cfg.dataUrl,
        count: Math.min(Math.max(cfg.count ?? 0, 0), MAX_ENTITIES),
      };
    },
    loader: async ({ params, abortSignal }) => {
      const rows: Customer[] = [];
      for (let fetched = 0; fetched < params.count; fetched += PAGE_SIZE) {
        const quantity = Math.min(PAGE_SIZE, params.count - fetched);
        const res = await fetch(`${params.url}?_quantity=${quantity}`, { signal: abortSignal });
        if (!res.ok) break; // e.g. rate-limited (HTTP 429) — keep what we already have
        const json: { data?: FakerPerson[] } = await res.json();
        for (const p of json.data ?? []) {
          rows.push({
            id: rows.length + 1,
            name: `${p.firstname} ${p.lastname}`,
            email: p.email,
            phone: p.phone,
            gender: p.gender,
            country: p.address?.country ?? '',
            birthday: p.birthday,
          });
        }
      }
      return rows;
    },
  });

  readonly customers = computed<Customer[]>(() => this.data.value() ?? []);

  trackById = (row: Customer) => row.id;
}
