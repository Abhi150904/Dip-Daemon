import type { EvalResult } from "./jev.js";
import type { Question } from "./questions.js";

const finite = (n: unknown, min: number, max: number): n is number => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
export function validEvaluation(result: EvalResult, questions: Record<string, Question>): boolean {
  if (!result.ok || !result.answers || !result.modelId || !finite(result.latencyMs, 0, Number.MAX_SAFE_INTEGER) || !finite(result.tokens, 0, Number.MAX_SAFE_INTEGER)) return false;
  for (const [key, question] of Object.entries(questions)) {
    const answer = result.answers[key];
    if (!answer || (answer.confidence !== undefined && !finite(answer.confidence, 0, 1))) return false;
    if (question.type === "noul") {
      if (answer.type !== "noul" || !finite(answer.noul, 0, 1)) return false;
    } else if (question.type === "score") {
      if (answer.type !== "score" || !finite(answer.score, 0, question.criteria.length - 1)) return false;
    } else {
      if (answer.type !== "choice" || typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice) || !answer.probabilities) return false;
      const probabilities = answer.probabilities;
      const keys = Object.keys(question.criteria);
      if (Object.keys(probabilities).length !== keys.length || keys.some(k => !finite(probabilities[k], 0, 1))) return false;
      if (Math.abs(keys.reduce((s, k) => s + probabilities[k], 0) - 1) > 0.02) return false;
    }
  }
  return true;
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model object");
  return value as Record<string, unknown>;
}

/** Normalize provider aliases, but never coerce strings or invent missing answers. */
export function parseEvaluation(raw: unknown, questions: Record<string, Question>, fallbackModelId = "typesafe-ai/jev-unversioned"): Omit<EvalResult, "latencyMs" | "ok"> {
  const root = record(raw);
  const input = record(root.answers ?? root.data);
  const confidence = root.providerMetadata ? record(record(root.providerMetadata).typesafe ?? {}) : {};
  const confidenceMap = confidence.confidence ? record(confidence.confidence) : {};
  const answers: EvalResult["answers"] = {};
  for (const [key, question] of Object.entries(questions)) {
    const a = record(input[key]);
    if (a.type !== undefined && a.type !== question.type && !(question.type === "noul" && a.type === "boolean")) throw new Error("Model answer type does not match question");
    const c = a.confidence ?? confidenceMap[key];
    if (c !== undefined && !finite(c, 0, 1)) throw new Error("Invalid model confidence");
    if (question.type === "noul") {
      const n = a.noul ?? a.probability;
      if (!finite(n, 0, 1)) throw new Error("Invalid model probability");
      answers[key] = { type: "noul", noul: n, confidence: c };
    } else if (question.type === "score") {
      if (!finite(a.score, 0, question.criteria.length - 1)) throw new Error("Invalid model score");
      answers[key] = { type: "score", score: a.score, confidence: c };
    } else {
      if (typeof a.choice !== "string") throw new Error("Missing model choice");
      const probabilities: Record<string, number> = {};
      for (const [k, n] of Object.entries(record(a.probabilities))) {
        if (!finite(n, 0, 1)) throw new Error("Invalid model distribution");
        probabilities[k] = n;
      }
      answers[key] = { type: "choice", choice: a.choice, probabilities, confidence: c };
    }
  }
  const usage = root.usage ? record(root.usage) : {};
  const tokens = usage.inputTokens ?? usage.input_tokens ?? usage.totalTokens ?? 0;
  if (!finite(tokens, 0, Number.MAX_SAFE_INTEGER) || !Number.isInteger(tokens)) throw new Error("Invalid model usage");
  const response = root.response ? record(root.response) : {};
  const modelId = response.modelId ?? root.model ?? fallbackModelId;
  if (typeof modelId !== "string" || modelId.length === 0 || modelId.length > 200) throw new Error("Invalid model identity");
  const result = { answers, tokens, modelId };
  if (!validEvaluation({ ...result, ok: true, latencyMs: 0 }, questions)) throw new Error("Incomplete or invalid model response");
  return result;
}
