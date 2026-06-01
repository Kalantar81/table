import { DataTableColumn } from './data-table/data-table-types';
import { FieldMapping, TableRow } from './field-mapping';

/**
 * Runtime table configuration loaded from `public/table.config.json`.
 * Drives how many columns are shown, their header titles, and the
 * rows-per-page options — without rebuilding the app.
 */
export interface TableConfig<T = TableRow> {
  /** Columns to render. Their count and order define the table layout. */
  columns: DataTableColumn<T>[];
  /**
   * URL of the online source the row data is fetched from. When omitted, no
   * data is requested.
   */
  dataUrl?: string;
  /**
   * Dot-notation path inside the fetched JSON where the row array lives, e.g.
   * "data". When omitted, the response itself is expected to be the array.
   */
  rowsPath?: string;
  /**
   * Name of the query parameter used to request a page size from `dataUrl`.
   * Defaults to "_quantity" (FakerAPI). Set to "" to disable the size param.
   */
  quantityParam?: string;
  /**
   * How many rows to request per chunk (i.e. the page size sent via
   * `quantityParam`). Data is fetched in chunks of this size until `count` is
   * reached, and each chunk is rendered as soon as it arrives. Defaults to 500.
   */
  chunkSize?: number;
  /**
   * How the source paginates across chunks. When omitted, every chunk is
   * requested with the same params (suitable for mocks like FakerAPI). For a
   * real backend, set this so each chunk carries its page/offset.
   */
  pagination?: {
    /** Query param carrying the page number or row offset, e.g. "page" or "offset". */
    param: string;
    /**
     * "page" sends an incrementing page number (starting at `start`); "offset"
     * sends the count of rows already fetched. Defaults to "page".
     */
    mode?: 'page' | 'offset';
    /** Index of the first page in "page" mode (usually 1 or 0). Defaults to 1. */
    start?: number;
  };
  /**
   * Maps each output row field to how it is extracted from a raw source
   * record. Defines the row "interface" entirely in config — switching data
   * sources only requires editing this. When omitted, raw records are used
   * as-is. The keys here should match the `field`s used by `columns`.
   */
  fields?: Record<string, FieldMapping>;
  /**
   * How many entities to load from `dataUrl`. Capped at 100 000 by the host
   * component; the source is paged to reach this amount.
   */
  count?: number;
  /** Page-size options shown in the rows-per-page selector. */
  rowsPerPageOptions?: number[];
  /** Initially selected page size. */
  initialRows?: number;
  /** Row height in pixels (used by virtual scroll). */
  rowHeight?: number;
  /** Enable CDK virtual scrolling. */
  virtualScroll?: boolean;
  /** Outer table width as a CSS length, e.g. "100%" or "960px". */
  width?: string;
  /** Outer table height as a CSS length, e.g. "600px". */
  height?: string;
  /**
   * Allow the table to scroll horizontally when columns are wider than the
   * container. When enabled, columns keep their fixed widths instead of
   * shrinking to fit.
   */
  horizontalScroll?: boolean;
}
