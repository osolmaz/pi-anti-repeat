export type ReasoningConfig = {
  /** Words in one compared window of streamed reasoning. */
  readonly windowWords: number;
  /** Times one window must appear, without overlapping itself, to count as repeated. */
  readonly repeats: number;
  /** Distinct repeated windows needed before one response is reported. */
  readonly matchedWindows: number;
  /** One in this many windows is tracked, chosen by the window's own hash. */
  readonly sampleRate: number;
  /** Upper bound on tracked windows per response. */
  readonly maxTrackedWindows: number;
};

export type OutcomeCycleConfig = {
  /** Times the same cycle of run outcomes must repeat. */
  readonly repeats: number;
  /** Longest cycle, in runs, that is checked. */
  readonly maxLength: number;
};

export type RepeatedErrorConfig = {
  /** Consecutive runs that must end with the same error. */
  readonly repeats: number;
};

export type SimilarActionsConfig = {
  /** Consecutive continuation-led runs that are compared. */
  readonly runs: number;
  /** Minimum similarity, from 0 to 1, between each adjacent pair of runs. */
  readonly similarity: number;
};

export type DetectorConfig = {
  readonly reasoning: ReasoningConfig | false;
  readonly outcomeCycle: OutcomeCycleConfig | false;
  readonly repeatedError: RepeatedErrorConfig | false;
  readonly similarActions: SimilarActionsConfig | false;
};

export type DetectorOptions = {
  readonly reasoning?: Partial<ReasoningConfig> | false;
  readonly outcomeCycle?: Partial<OutcomeCycleConfig> | false;
  readonly repeatedError?: Partial<RepeatedErrorConfig> | false;
  readonly similarActions?: Partial<SimilarActionsConfig> | false;
};

export const DEFAULT_REASONING: ReasoningConfig = {
  windowWords: 96,
  repeats: 3,
  matchedWindows: 3,
  sampleRate: 8,
  maxTrackedWindows: 2_048,
};

export const DEFAULT_OUTCOME_CYCLE: OutcomeCycleConfig = { repeats: 3, maxLength: 4 };
export const DEFAULT_REPEATED_ERROR: RepeatedErrorConfig = { repeats: 3 };
export const DEFAULT_SIMILAR_ACTIONS: SimilarActionsConfig = { runs: 4, similarity: 0.85 };

/** Run summaries kept for the run detectors. */
export const MAX_RUN_HISTORY = 12;

function integer(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer from ${String(minimum)} to ${String(maximum)}`,
    );
  }
  return value;
}

function resolveReasoning(options: Partial<ReasoningConfig>): ReasoningConfig {
  const merged = { ...DEFAULT_REASONING, ...options };
  return {
    windowWords: integer("reasoning.windowWords", merged.windowWords, 8, 4_096),
    repeats: integer("reasoning.repeats", merged.repeats, 2, 64),
    matchedWindows: integer("reasoning.matchedWindows", merged.matchedWindows, 1, 64),
    sampleRate: integer("reasoning.sampleRate", merged.sampleRate, 1, 1_024),
    maxTrackedWindows: integer("reasoning.maxTrackedWindows", merged.maxTrackedWindows, 16, 65_536),
  };
}

function resolveOutcomeCycle(options: Partial<OutcomeCycleConfig>): OutcomeCycleConfig {
  const merged = { ...DEFAULT_OUTCOME_CYCLE, ...options };
  const repeats = integer("outcomeCycle.repeats", merged.repeats, 2, MAX_RUN_HISTORY);
  const maxLength = integer("outcomeCycle.maxLength", merged.maxLength, 1, MAX_RUN_HISTORY);
  if (repeats * maxLength > MAX_RUN_HISTORY) {
    throw new RangeError(
      `outcomeCycle.repeats times outcomeCycle.maxLength must be at most ${String(MAX_RUN_HISTORY)}`,
    );
  }
  return { repeats, maxLength };
}

function resolveSimilarActions(options: Partial<SimilarActionsConfig>): SimilarActionsConfig {
  const merged = { ...DEFAULT_SIMILAR_ACTIONS, ...options };
  const runs = integer("similarActions.runs", merged.runs, 2, MAX_RUN_HISTORY);
  if (!(merged.similarity > 0 && merged.similarity <= 1)) {
    throw new RangeError("similarActions.similarity must be greater than 0 and at most 1");
  }
  return { runs, similarity: merged.similarity };
}

function resolveRepeatedError(options: Partial<RepeatedErrorConfig>): RepeatedErrorConfig {
  const merged = { ...DEFAULT_REPEATED_ERROR, ...options };
  return { repeats: integer("repeatedError.repeats", merged.repeats, 2, MAX_RUN_HISTORY) };
}

function optional<T, R>(
  value: Partial<T> | false | undefined,
  resolve: (value: Partial<T>) => R,
): R | false {
  return value === false ? false : resolve(value ?? {});
}

/** Fills in defaults and rejects values outside the supported ranges. */
export function resolveDetectorConfig(options: DetectorOptions = {}): DetectorConfig {
  return {
    reasoning: optional(options.reasoning, resolveReasoning),
    outcomeCycle: optional(options.outcomeCycle, resolveOutcomeCycle),
    repeatedError: optional(options.repeatedError, resolveRepeatedError),
    similarActions: optional(options.similarActions, resolveSimilarActions),
  };
}
