import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { syntheticDataset } from "../src/backtest/data.js";

const output = resolve(process.argv[2] ?? "data/backtest-fixture.json");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(syntheticDataset(), null, 2) + "\n", { flag: "wx" });
console.log(`Synthetic evaluation dataset written to ${output}; no real market prices or model output.`);
