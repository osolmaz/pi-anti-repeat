import { MAX_RUN_HISTORY, type DetectorConfig } from "./config.ts";
import type { Detection } from "./detection.ts";
import { actionFeatureSimilarity, type RunSummary } from "./run-summary.ts";

type RunRules = Pick<DetectorConfig, "outcomeCycle" | "repeatedError" | "similarActions">;

function suffixRepeats(
  history: readonly RunSummary[],
  cycleLength: number,
  repeats: number,
): boolean {
  const required = cycleLength * repeats;
  if (history.length < required) return false;
  const start = history.length - required;
  if (history.slice(start).some((run) => run.truncated)) return false;
  for (let offset = cycleLength; offset < required; offset += 1) {
    const current = history[start + offset];
    const expected = history[start + (offset % cycleLength)];
    if (current?.exactOutcomeHash !== expected?.exactOutcomeHash) return false;
  }
  return true;
}

function outcomeCycle(history: readonly RunSummary[], rules: RunRules): Detection | null {
  const config = rules.outcomeCycle;
  if (config === false) return null;
  const maximum = Math.min(config.maxLength, Math.floor(history.length / config.repeats));
  for (let cycleLength = 1; cycleLength <= maximum; cycleLength += 1) {
    if (suffixRepeats(history, cycleLength, config.repeats)) {
      return { cycleLength, kind: "outcome_cycle", repeats: config.repeats };
    }
  }
  return null;
}

function repeatedError(history: readonly RunSummary[], rules: RunRules): Detection | null {
  const config = rules.repeatedError;
  if (config === false) return null;
  const suffix = history.slice(-config.repeats);
  if (suffix.length !== config.repeats) return null;
  const fingerprint = suffix[0]?.terminalErrorFingerprint;
  if (fingerprint === null || fingerprint === undefined) return null;
  const same = suffix.every(
    (run) => run.terminalError && run.terminalErrorFingerprint === fingerprint,
  );
  return same ? { kind: "repeated_error", repeats: config.repeats } : null;
}

function isComparableContinuation(run: RunSummary): boolean {
  return run.continuationPrompt && run.toolCalls > 0 && !run.truncated;
}

/** Mean similarity of adjacent runs, or null when any pair is below `minimum`. */
function adjacentSimilarity(runs: readonly RunSummary[], minimum: number): number | null {
  let total = 0;
  for (let index = 1; index < runs.length; index += 1) {
    const similarity = actionFeatureSimilarity(
      runs[index - 1]?.actionFeatures ?? [],
      runs[index]?.actionFeatures ?? [],
    );
    if (similarity < minimum) return null;
    total += similarity;
  }
  return total / (runs.length - 1);
}

function similarActions(history: readonly RunSummary[], rules: RunRules): Detection | null {
  const config = rules.similarActions;
  if (config === false) return null;
  const suffix = history.slice(-config.runs);
  if (suffix.length !== config.runs || !suffix.every(isComparableContinuation)) return null;
  const similarity = adjacentSimilarity(suffix, config.similarity);
  return similarity === null ? null : { kind: "similar_actions", runs: config.runs, similarity };
}

/**
 * Keeps summaries of recent runs and reports repeated outcomes, repeated errors, and runs that
 * repeat almost the same actions after a short "continue" prompt. A run count alone never
 * produces a detection.
 */
export class RunHistoryDetector {
  private readonly history: RunSummary[] = [];
  private readonly rules: RunRules;

  constructor(rules: RunRules) {
    this.rules = rules;
  }

  get runCount(): number {
    return this.history.length;
  }

  observe(run: RunSummary): Detection | null {
    this.history.push(run);
    if (this.history.length > MAX_RUN_HISTORY) this.history.shift();
    return (
      outcomeCycle(this.history, this.rules) ??
      repeatedError(this.history, this.rules) ??
      similarActions(this.history, this.rules)
    );
  }

  reset(): void {
    this.history.length = 0;
  }
}
