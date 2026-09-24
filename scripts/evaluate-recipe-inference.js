"use strict";

const MAX_LIVE_CALLS = 20;
const DEFAULT_LIVE_CALLS = 8;
const THRESHOLD_MINUTES = 30;

const DURATION_PATTERN = /\b(?:(?:\d+(?:\.\d+)?\s*(?:-|–|—|to)\s*)?\d+(?:\.\d+)?\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?))\b/gi;
const HUMAN_DURATION_PATTERN = /\b(?:overnight|all day|half an hour|quarter of an hour|a few hours?|several hours?|a couple of hours?|a few minutes?|several minutes?)\b/gi;
const ISO_DURATION_PATTERN = /\bP(?:\d+D)?T(?:\d+H)?(?:\d+M)?(?:\d+S)?\b/gi;

function maskRecipeForInference(candidate) {
  let removedDurationPhrases = 0;
  const mask = (value) => String(value || "").replace(ISO_DURATION_PATTERN, () => { removedDurationPhrases++; return "[duration omitted]"; })
    .replace(DURATION_PATTERN, () => { removedDurationPhrases++; return "[duration omitted]"; })
    .replace(HUMAN_DURATION_PATTERN, () => { removedDurationPhrases++; return "[duration omitted]"; })
    .replace(/\s+/g, " ").trim();
  const ingredients = (Array.isArray(candidate?.ingredients) ? candidate.ingredients : []).slice(0, 80).map((line) => mask(line).slice(0, 180));
  const instructions = (Array.isArray(candidate?.instructions) ? candidate.instructions : Array.isArray(candidate?.rawInstructions) ? candidate.rawInstructions : [])
    .slice(0, 30).map((line) => mask(line).slice(0, 700));
  return { ingredients, instructions, removedDurationPhrases };
}

function balancedKnownTimeSample(candidates, { threshold = THRESHOLD_MINUTES, maxCalls = DEFAULT_LIVE_CALLS } = {}) {
  const cap = Math.min(MAX_LIVE_CALLS, Math.max(0, Math.floor(Number(maxCalls) || 0)));
  const perSide = Math.floor(cap / 2);
  const unique = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const time = Number(candidate?.timeMin);
    const url = String(candidate?.finalUrl || candidate?.sourceUrl || "");
    if (!Number.isFinite(time) || time <= 0 || !url || !Array.isArray(candidate?.instructions) || !candidate.instructions.length) continue;
    if (!unique.has(url)) unique.set(url, candidate);
  }
  const rows = [...unique.values()];
  const side = (isShort) => rows.filter((candidate) => (Number(candidate.timeMin) <= threshold) === isShort)
    .sort((a, b) => Number(a.timeMin) - Number(b.timeMin));
  const short = side(true);
  const long = side(false);
  const sampleCount = Math.min(perSide, short.length, long.length);
  if (!sampleCount) return { candidates: [], shortAvailable: short.length, longAvailable: long.length, balancedPerSide: 0 };
  const sample = (values) => {
    if (values.length <= sampleCount) return values;
    return Array.from({ length: sampleCount }, (_, index) => values[Math.floor((index + 0.5) * values.length / sampleCount)]);
  };
  const shortSample = sample(short);
  const longSample = sample(long);
  const interleaved = [];
  for (let index = 0; index < sampleCount; index++) interleaved.push(shortSample[index], longSample[index]);
  return { candidates: interleaved, shortAvailable: short.length, longAvailable: long.length, balancedPerSide: sampleCount };
}

function normalizeEstimate(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 && number <= 1440 ? Math.round(number) : null;
}

async function evaluateRecipeTimeInference(candidates, options = {}) {
  const threshold = Number(options.threshold) > 0 ? Number(options.threshold) : THRESHOLD_MINUTES;
  const maxCalls = Math.min(MAX_LIVE_CALLS, Math.max(0, Math.floor(Number(options.maxCalls) || DEFAULT_LIVE_CALLS)));
  const airChat = options.airChat;
  const sample = balancedKnownTimeSample(candidates, { threshold, maxCalls });
  const result = {
    status: "complete",
    thresholdMin: threshold,
    maxCalls,
    calls: 0,
    shortTruthAvailable: sample.shortAvailable,
    longTruthAvailable: sample.longAvailable,
    balancedPerSide: sample.balancedPerSide,
    sampled: sample.candidates.length,
    shortTruthSampled: sample.balancedPerSide,
    falseSafeCount: 0,
    falseSafeDenominator: 0,
    falseSafeRate: null,
    longTruthSampled: sample.balancedPerSide,
    longTruthEvaluable: 0,
    longTruthCalls: 0,
    trueSafeCount: 0,
    estimatesWithin10Min: 0,
    meanAbsoluteErrorMin: null,
    invalidOutputs: 0,
    durationPhrasesMasked: 0,
    note: "Inferred times are evaluation-only and never enter discovery filtering or production planning.",
  };
  if (!sample.candidates.length) {
    result.status = "insufficient-balanced-known-time-sample";
    return result;
  }
  if (typeof airChat !== "function") {
    result.status = "missing-air-client";
    return result;
  }
  const absoluteErrors = [];
  for (const candidate of sample.candidates.slice(0, maxCalls)) {
    const masked = maskRecipeForInference(candidate);
    result.durationPhrasesMasked += masked.removedDurationPhrases;
    const messages = [
      {
        role: "system",
        content: "Estimate a recipe's total elapsed preparation and cooking time from ingredients and instructions. The recipe title and all explicit duration phrases have been removed. Return only JSON with estimateMin, lowerBoundMin, upperBoundMin, and confidence (low, medium, or high). Use null bounds if there is not enough evidence. Be cautious. This estimate is an experiment and must never be treated as verified source truth.",
      },
      {
        role: "user",
        content: JSON.stringify({ ingredients: masked.ingredients, instructions: masked.instructions }),
      },
    ];
    let estimate = null;
    try {
      result.calls++;
      if (Number(candidate.timeMin) > threshold) result.longTruthCalls++;
      const response = await airChat(messages, { model: options.model, maxTokens: 180, wantJson: true, temperature: 0 });
      if (!response?.ok) {
        result.status = "model-error";
        result.modelFailureStatus = response?.failure?.status || "unknown";
        break;
      }
      const envelope = response.data?.choices?.[0]?.message?.content;
      const parsed = typeof envelope === "string" ? JSON.parse(envelope) : envelope;
      estimate = {
        estimateMin: normalizeEstimate(parsed?.estimateMin),
        lowerBoundMin: normalizeEstimate(parsed?.lowerBoundMin),
        upperBoundMin: normalizeEstimate(parsed?.upperBoundMin),
        confidence: ["low", "medium", "high"].includes(String(parsed?.confidence).toLowerCase()) ? String(parsed.confidence).toLowerCase() : "low",
      };
      if (estimate.lowerBoundMin == null || estimate.upperBoundMin == null || estimate.lowerBoundMin > estimate.upperBoundMin ||
          estimate.estimateMin == null || estimate.estimateMin < estimate.lowerBoundMin || estimate.estimateMin > estimate.upperBoundMin) {
        estimate = null;
      }
    } catch {
      estimate = null;
    }
    if (!estimate) { result.invalidOutputs++; continue; }
    const truth = Number(candidate.timeMin);
    if (truth > threshold) result.longTruthEvaluable++;
    const predictedSafe = estimate.upperBoundMin <= threshold && estimate.confidence !== "low";
    if (truth <= threshold && predictedSafe) result.trueSafeCount++;
    if (truth > threshold && predictedSafe) result.falseSafeCount++;
    const error = Math.abs(estimate.estimateMin - truth);
    absoluteErrors.push(error);
    if (error <= 10) result.estimatesWithin10Min++;
  }
  result.falseSafeDenominator = result.longTruthEvaluable;
  result.falseSafeRate = result.falseSafeDenominator ? result.falseSafeCount / result.falseSafeDenominator : null;
  result.meanAbsoluteErrorMin = absoluteErrors.length ? Number((absoluteErrors.reduce((sum, value) => sum + value, 0) / absoluteErrors.length).toFixed(2)) : null;
  return result;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const value = Buffer.concat(chunks).toString("utf8").trim();
  return value ? JSON.parse(value) : null;
}

module.exports = { balancedKnownTimeSample, evaluateRecipeTimeInference, maskRecipeForInference };

if (require.main === module) {
  (async () => {
    const input = await readStdin();
    if (!input || !Array.isArray(input.candidates)) {
      process.stdout.write(`${JSON.stringify({ status: "skipped", reason: "provide verified candidates as JSON on stdin" })}\n`);
      return;
    }
    const server = require("../server");
    if (!process.env.VOYAGER_KEY) {
      process.stdout.write(`${JSON.stringify({ status: "skipped", reason: "VOYAGER_KEY is not configured", sampleCandidates: input.candidates.length })}\n`);
      return;
    }
    const requestedCalls = Math.min(MAX_LIVE_CALLS, Math.max(1, Number(process.env.RCP_INFERENCE_MAX_CALLS) || DEFAULT_LIVE_CALLS));
    const evaluation = await evaluateRecipeTimeInference(input.candidates, {
      maxCalls: requestedCalls,
      model: server.AIR_MODEL,
      airChat: server.airChat,
    });
    process.stdout.write(`${JSON.stringify({ ...evaluation, model: server.AIR_MODEL })}\n`);
  })().catch((error) => {
    process.stdout.write(`${JSON.stringify({ status: "error", message: String(error?.message || error).slice(0, 200) })}\n`);
    process.exitCode = 1;
  });
}
