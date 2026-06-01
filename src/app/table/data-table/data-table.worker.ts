/// <reference lib="webworker" />

import { buildDataset, Dataset, EMPTY_INDICES, runPipeline } from './data-table.pipeline';
import { PipelineResult, WorkerRequest } from './data-table.worker-types';

let dataset: Dataset<Record<string, any>> | null = null;
let datasetSeq = -1;

addEventListener('message', ({ data }: MessageEvent<WorkerRequest>) => {
  if (data.type === 'dataset') {
    datasetSeq = data.datasetSeq;
    dataset = buildDataset(data.rows, data.cols);
    return;
  }

  if (data.type === 'pipeline') {
    // Ignore requests aimed at a dataset we no longer hold.
    if (!dataset || data.datasetSeq !== datasetSeq) return;

    const computed = runPipeline(dataset, data.prepared, data.global, data.sort);
    // Copy before transferring: the pipeline may return buffers owned by the
    // dataset (allIndices / category indexes) that must stay intact for reuse.
    const indices = computed === EMPTY_INDICES ? new Uint32Array(0) : computed.slice();

    const response: PipelineResult = {
      type: 'result',
      datasetSeq: data.datasetSeq,
      pipelineSeq: data.pipelineSeq,
      indices,
    };
    postMessage(response, [indices.buffer]);
  }
});
