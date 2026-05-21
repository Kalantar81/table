export type SortOrder = 1 | -1;

export type FilterMatchMode =
  | 'startsWith'
  | 'contains'
  | 'notContains'
  | 'endsWith'
  | 'equals'
  | 'notEquals'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'dateIs'
  | 'dateIsNot'
  | 'dateBefore'
  | 'dateAfter';

export type ColumnFilterType = 'text' | 'numeric' | 'date' | 'boolean';

export interface DataTableColumn<T = any> {
  field: keyof T & string;
  header: string;
  sortable?: boolean;
  filterable?: boolean;
  filterType?: ColumnFilterType;
  width?: string;
  align?: 'left' | 'center' | 'right';
  collator?: boolean;
}

export interface ColumnFilterState {
  value: any;
  matchMode: FilterMatchMode;
}

export interface SortState {
  field: string;
  order: SortOrder;
}

export const TEXT_MATCH_MODES: { label: string; value: FilterMatchMode }[] = [
  { label: 'Starts with', value: 'startsWith' },
  { label: 'Contains', value: 'contains' },
  { label: 'Not contains', value: 'notContains' },
  { label: 'Ends with', value: 'endsWith' },
  { label: 'Equals', value: 'equals' },
  { label: 'Not equals', value: 'notEquals' },
];

export const NUMERIC_MATCH_MODES: { label: string; value: FilterMatchMode }[] = [
  { label: 'Equals', value: 'equals' },
  { label: 'Not equals', value: 'notEquals' },
  { label: 'Less than', value: 'lt' },
  { label: 'Less than or equal', value: 'lte' },
  { label: 'Greater than', value: 'gt' },
  { label: 'Greater than or equal', value: 'gte' },
];

export const DATE_MATCH_MODES: { label: string; value: FilterMatchMode }[] = [
  { label: 'Date is', value: 'dateIs' },
  { label: 'Date is not', value: 'dateIsNot' },
  { label: 'Date before', value: 'dateBefore' },
  { label: 'Date after', value: 'dateAfter' },
];

export function defaultMatchMode(type: ColumnFilterType | undefined): FilterMatchMode {
  switch (type) {
    case 'numeric':
      return 'equals';
    case 'date':
      return 'dateIs';
    case 'boolean':
      return 'equals';
    case 'text':
    default:
      return 'startsWith';
  }
}

export function matchModesFor(type: ColumnFilterType | undefined) {
  switch (type) {
    case 'numeric':
      return NUMERIC_MATCH_MODES;
    case 'date':
      return DATE_MATCH_MODES;
    default:
      return TEXT_MATCH_MODES;
  }
}
