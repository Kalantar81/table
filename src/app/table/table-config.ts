import { DataTableColumn } from './data-table/data-table-types';

/**
 * Runtime table configuration loaded from `public/table.config.json`.
 * Drives how many columns are shown, their header titles, and the
 * rows-per-page options — without rebuilding the app.
 */
export interface TableConfig<T = any> {
  /** Columns to render. Their count and order define the table layout. */
  columns: DataTableColumn<T>[];
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
