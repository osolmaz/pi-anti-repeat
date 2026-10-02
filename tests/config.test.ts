import { describe, expect, it } from "vitest";

import {
  DEFAULT_OUTCOME_CYCLE,
  DEFAULT_REASONING,
  DEFAULT_REPEATED_ERROR,
  DEFAULT_SIMILAR_ACTIONS,
  resolveDetectorConfig,
} from "../src/core/config.ts";

describe("resolveDetectorConfig", () => {
  it("uses the documented defaults", () => {
    expect(resolveDetectorConfig()).toEqual({
      outcomeCycle: DEFAULT_OUTCOME_CYCLE,
      reasoning: DEFAULT_REASONING,
      repeatedError: DEFAULT_REPEATED_ERROR,
      similarActions: DEFAULT_SIMILAR_ACTIONS,
    });
  });

  it("merges partial options and turns detectors off", () => {
    const config = resolveDetectorConfig({
      outcomeCycle: false,
      reasoning: { windowWords: 64 },
      repeatedError: { repeats: 2 },
      similarActions: { similarity: 0.9 },
    });
    expect(config.outcomeCycle).toBe(false);
    expect(config.reasoning).toEqual({ ...DEFAULT_REASONING, windowWords: 64 });
    expect(config.repeatedError).toEqual({ repeats: 2 });
    expect(config.similarActions).toEqual({ runs: 4, similarity: 0.9 });
  });

  it.each([
    [{ reasoning: { windowWords: 4 } }, "reasoning.windowWords"],
    [{ reasoning: { repeats: 1.5 } }, "reasoning.repeats"],
    [{ reasoning: { sampleRate: 0 } }, "reasoning.sampleRate"],
    [{ outcomeCycle: { maxLength: 4, repeats: 4 } }, "outcomeCycle.repeats times"],
    [{ repeatedError: { repeats: 1 } }, "repeatedError.repeats"],
    [{ similarActions: { similarity: 0 } }, "similarActions.similarity"],
    [{ similarActions: { similarity: 1.5 } }, "similarActions.similarity"],
  ])("rejects %j", (options, message) => {
    expect(() => resolveDetectorConfig(options)).toThrow(message);
  });
});
