import { SortState } from './data-table-types';
import { ColumnMeta, GlobalFilter, PreparedColumnFilter } from './data-table.pipeline';

/** Loads a fresh dataset into the worker. `rows` is structured-cloned across. */
export interface DatasetRequest {
  type: 'dataset';
  datasetSeq: number;
  rows: Record<string, any>[];
  cols: ColumnMeta[];
}

/**
 * Appends freshly-arrived rows to the dataset already held by the worker,
 * extending its index in place. Only the new tail is sent (not the full set),
 * so progressive loading stays linear. Ignored if `datasetSeq` is stale.
 */
export interface AppendRequest {
  type: 'append';
  datasetSeq: number;
  rows: Record<string, any>[];
  cols: ColumnMeta[];
}

/** Asks the worker to filter + sort the current dataset. */
export interface PipelineRequest {
  type: 'pipeline';
  datasetSeq: number;
  pipelineSeq: number;
  prepared: PreparedColumnFilter[];
  global: GlobalFilter | null;
  sort: SortState | null;
}

export type WorkerRequest = DatasetRequest | AppendRequest | PipelineRequest;

/** Resulting row indices for a pipeline request; `indices.buffer` is transferred. */
export interface PipelineResult {
  type: 'result';
  datasetSeq: number;
  pipelineSeq: number;
  indices: Uint32Array;
}

export type WorkerResponse = PipelineResult;
