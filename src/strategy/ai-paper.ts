import type { Model } from "../model/index.js";
import { validEvaluation } from "../model/validation.js";
import { positionQuestions } from "../model/questions.js";
import type { PaperPosition } from "../portfolio/types.js";
import { PaperError } from "../portfolio/types.js";
import { risk } from "../config.js";
import { contextFor } from "../db.js";
import { istDateStr } from "../time.js";
import type { Bar, IndexFeatures, Quote, SymbolFeatures } from "../types.js";
import { stage2State } from "../data/features.js";
import { runStage1, runStage2 } from "./continuation.js";
import { completedBars, type AutomationSettings, type Signal } from "./signals.js";

export interface StrategySnapshot {
  source?: "broker" | "synthetic-fixtures" | "offline-test";
  quotes: Quote[];
  bars: Map<string, Bar[]>;
  features: SymbolFeatures[];
  index: IndexFeatures | null;
  indexTs: number | null;
}

export async function aiSignals(snapshot: StrategySnapshot, positions: PaperPosition[], settings: AutomationSettings, model: Model, now: number): Promise<Signal[]> {
  const probabilities = [risk.stage1MinProb, risk.riskOffHalt, risk.minSetupProb, risk.minSetupConfidence, risk.minEntryScore, risk.minSingleScore, risk.minOneSided, risk.tierASetup, risk.tierAScore, risk.exitNow, risk.takeProfit];
  const weights = [risk.weights?.trend_quality, risk.weights?.flow_alignment, risk.weights?.index_alignment, risk.weights?.liquidity];
  if (probabilities.some(n => !Number.isFinite(n) || n < 0 || n > 1) || weights.some(n => !Number.isFinite(n) || n < 0) || weights.reduce((s, n) => s + n, 0) <= 0 ||
    !Number.isFinite(risk.maxSpreadBps) || risk.maxSpreadBps <= 0 || !Number.isFinite(risk.minRvol) || risk.minRvol < 0 || !Number.isFinite(risk.thesisBroken) || risk.thesisBroken < 0 || risk.thesisBroken > 3) throw new PaperError("Invalid inherited AI risk thresholds");
  if (model.name !== "jev" || !snapshot.index) throw new PaperError("Jev strategy requires MODEL=jev and valid index features");
  const result: Signal[] = [];
  const context = contextFor(istDateStr(now));
  const stage1 = await runStage1(model, snapshot.features, snapshot.index);
  if (!stage1) throw new PaperError("AI stage 1 failed or returned invalid answers");
  for (const quote of snapshot.quotes) {
    const feature = snapshot.features.find(f => f.symbol === quote.symbol);
    if (!feature) continue;
    const history = completedBars(snapshot.bars.get(quote.symbol) ?? [], quote.symbol, now);
    const base = { symbol: quote.symbol, strategy: "jev" as const, strategyVersion: "jev-two-stage-v1",
      modelVersion: stage1.modelVersion, quoteTs: quote.ts, barTs: history[history.length - 1].ts,
      generatedAt: now, expiresAt: now + settings.signalTtlS * 1000, score: 0 };
    const position = positions.find(p => p.symbol === quote.symbol);
    if (position) {
      const entry = position.cost_paise / position.qty / 100;
      const evaluation = await model.evaluate(stage2State(feature, snapshot.index, {
        side: "long", entry, stop: position.stop_paise === null ? null : position.stop_paise / 100,
        unrealisedBps: (quote.ltp / entry - 1) * 10000, minutesHeld: (now - position.opened_at) / 60000,
      }), positionQuestions, "paper-position", quote.symbol);
      if (!validEvaluation(evaluation, positionQuestions)) throw new PaperError("AI position evaluation failed or returned invalid answers");
      const exit = (evaluation.answers.exit_now.noul ?? 0) >= risk.exitNow || (evaluation.answers.thesis.score ?? 3) < risk.thesisBroken || (evaluation.answers.take_profit.noul ?? 0) >= risk.takeProfit || now - position.opened_at >= settings.maxHoldMinutes * 60000;
      result.push(exit ? { ...base, modelVersion: evaluation.modelId, action: "SELL", score: 1, entryPrice: quote.bid || quote.ltp,
        reason: "Validated AI exit/thesis/profit vote or deterministic maximum holding time" } : { ...base, modelVersion: evaluation.modelId, action: "HOLD", reason: "Validated AI position thesis remains intact" });
      continue;
    }
    if (stage1.riskOff >= risk.riskOffHalt || !stage1.longs.some(r => r.symbol === quote.symbol)) {
      result.push({ ...base, action: "HOLD", reason: stage1.riskOff >= risk.riskOffHalt ? "Deterministic risk-off gate" : "Not shortlisted for a long opportunity" });
      continue;
    }
    if (context.get(quote.symbol)?.exclude || context.get(quote.symbol)?.forbidSide === "long") {
      result.push({ ...base, action: "HOLD", reason: "Existing news/event exclusion gate" }); continue;
    }
    if (feature.spreadBps > risk.maxSpreadBps || feature.volume.rvol20d < risk.minRvol) {
      result.push({ ...base, action: "HOLD", reason: "Spread or relative-volume gate rejected candidate" }); continue;
    }
    const candidate = await runStage2(model, feature, snapshot.index, "long");
    if (!candidate) throw new PaperError("AI stage 2 failed or returned invalid answers");
    const distance = Math.max(feature.atr1m * settings.stopAtrMult, quote.ltp * 0.001);
    if (!candidate.passes || distance / quote.ltp * 10000 > settings.maxStopBps) {
      result.push({ ...base, modelVersion: candidate.modelVersion, action: "HOLD", reason: candidate.reject || "ATR stop exceeds maximum distance" }); continue;
    }
    result.push({ ...base, modelVersion: candidate.modelVersion, action: "BUY", score: candidate.entryScore,
      entryPrice: quote.ask || quote.ltp, stopLoss: Math.floor(((quote.ask || quote.ltp) - distance) * 100) / 100,
      reason: `Two-stage long continuation; setup ${candidate.setupProb.toFixed(2)}, confidence ${candidate.setupConf.toFixed(2)}, composite ${candidate.entryScore.toFixed(2)}` });
  }
  return result;
}
