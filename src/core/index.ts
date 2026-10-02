import { resolveDetectorConfig, type DetectorConfig, type DetectorOptions } from "./config.ts";
import type { Detection } from "./detection.ts";
import { ReasoningRepeatDetector } from "./reasoning.ts";
import { RunHistoryDetector } from "./run-history.ts";
import { RunSummaryBuilder } from "./run-summary.ts";

export * from "./config.ts";
export { isContinuationPrompt } from "./continuation.ts";
export type { Detection, DetectionKind } from "./detection.ts";
export { ReasoningRepeatDetector } from "./reasoning.ts";
export { RunHistoryDetector } from "./run-history.ts";
export {
  actionFeatureSimilarity,
  normalizeVolatileText,
  RunSummaryBuilder,
  type RunSummary,
} from "./run-summary.ts";

/**
 * Detects repeated work from plain data, without Pi.
 *
 * Feed it the deltas of one streamed reasoning block with `observeReasoning`, and the messages of
 * each run with `recordTurn` and `recordRunEnd`. `finishRun` compares the run with earlier runs.
 * All state stays in memory and is bounded.
 */
export class RepeatDetector {
  readonly config: DetectorConfig;
  private readonly reasoning: ReasoningRepeatDetector | null;
  private readonly runs: RunHistoryDetector;
  private run: RunSummaryBuilder | null = null;
  private runContinuation = false;

  constructor(options: DetectorOptions = {}) {
    this.config = resolveDetectorConfig(options);
    this.reasoning =
      this.config.reasoning === false ? null : new ReasoningRepeatDetector(this.config.reasoning);
    this.runs = new RunHistoryDetector(this.config);
  }

  /** True while a run is being recorded. */
  get runOpen(): boolean {
    return this.run !== null;
  }

  /** Starts a new reasoning block. Evidence from the previous block is dropped. */
  startReasoning(): void {
    this.reasoning?.reset();
  }

  observeReasoning(delta: string): Detection | null {
    return this.reasoning?.observe(delta) ?? null;
  }

  endReasoning(): Detection | null {
    return this.reasoning?.finish() ?? null;
  }

  /** Starts recording a run. `continuationPrompt` marks a run started by a "continue" prompt. */
  startRun(continuationPrompt = false): void {
    this.run = new RunSummaryBuilder();
    this.runContinuation = continuationPrompt;
  }

  recordTurn(message: unknown, toolResults: readonly unknown[]): void {
    if (this.run === null) this.startRun();
    this.run?.accountTurn(message, toolResults);
  }

  recordRunEnd(messages: readonly unknown[]): void {
    this.run?.accountAgentEnd(messages);
  }

  /** Closes the current run and compares it with earlier runs. */
  finishRun(): Detection | null {
    const run = this.run;
    if (run === null) return null;
    this.run = null;
    return this.runs.observe(run.finish(this.runContinuation));
  }

  /** Closes the current run without comparing it, for runs that should not count. */
  discardRun(): void {
    this.run = null;
  }

  /** Forgets all runs and reasoning. */
  reset(): void {
    this.reasoning?.reset();
    this.runs.reset();
    this.run = null;
    this.runContinuation = false;
  }
}
