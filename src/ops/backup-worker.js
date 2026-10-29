import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';
const { inspectBackup } = await tsImport('./backup.ts', import.meta.url);
parentPort.postMessage(inspectBackup(workerData));
