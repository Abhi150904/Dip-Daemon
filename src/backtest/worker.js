import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

// The worker imports only the pure evaluator, never an Engine, database or broker.
globalThis.fetch = async () => { throw new Error('Evaluation cannot use network providers'); };
const { evaluate } = await tsImport('./engine.ts', import.meta.url);
parentPort.postMessage(evaluate(workerData.dataset, workerData.config));
