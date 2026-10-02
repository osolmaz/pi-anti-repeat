import { describe, expect, it } from "vitest";

import { MAX_RUN_HISTORY, resolveDetectorConfig } from "../src/core/config.ts";
import { RunHistoryDetector } from "../src/core/run-history.ts";
import type { RunSummary } from "../src/core/run-summary.ts";

const CONTINUATION_CHURN_COUNT = 4;

function detectorWith(options: Parameters<typeof resolveDetectorConfig>[0] = {}) {
  return new RunHistoryDetector(resolveDetectorConfig(options));
}

function episode(
  hash: string,
  options: Partial<Omit<RunSummary, "exactOutcomeHash">> = {},
): RunSummary {
  return {
    actionFeatures: [1, 2, 3, 4],
    continuationPrompt: false,
    exactOutcomeHash: `v1:${hash}`,
    terminalError: false,
    terminalErrorFingerprint: null,
    toolCalls: 1,
    truncated: false,
    turns: 1,
    ...options,
  };
}

describe("RunHistoryDetector", () => {
  it("detects exact cycles of length one through four after three repetitions", () => {
    for (let cycleLength = 1; cycleLength <= 4; cycleLength += 1) {
      const detector = detectorWith();
      let decision = null;
      for (let repetition = 0; repetition < 3; repetition += 1) {
        for (let index = 0; index < cycleLength; index += 1) {
          decision = detector.observe(episode(`cycle-${String(index)}`));
        }
      }
      expect(decision).toEqual({ cycleLength, kind: "outcome_cycle", repeats: 3 });
    }
  });

  it("does not call a changing sequence an exact cycle", () => {
    const detector = detectorWith();
    for (let index = 0; index < 7; index += 1) {
      expect(detector.observe(episode(`unique-${String(index)}`))).toBeNull();
    }
  });

  it("does not compare truncated outcomes as exact cycles", () => {
    const detector = detectorWith();
    for (let index = 0; index < 3; index += 1) {
      expect(detector.observe(episode("same", { truncated: true }))).toBeNull();
    }
  });

  it("detects the same normalized terminal error three times", () => {
    const detector = detectorWith();
    let decision = null;
    for (let index = 0; index < 3; index += 1) {
      decision = detector.observe(
        episode(`error-${String(index)}`, {
          terminalError: true,
          terminalErrorFingerprint: "v1:same-error",
        }),
      );
    }
    expect(decision).toEqual({ kind: "repeated_error", repeats: 3 });
  });

  it("requires matching error fingerprints", () => {
    const detector = detectorWith();
    for (let index = 0; index < 3; index += 1) {
      expect(
        detector.observe(
          episode(`error-${String(index)}`, {
            terminalError: true,
            terminalErrorFingerprint: `v1:error-${String(index)}`,
          }),
        ),
      ).toBeNull();
    }
  });

  it("detects continuation-led action churn", () => {
    const detector = detectorWith();
    let decision = null;
    for (let index = 0; index < CONTINUATION_CHURN_COUNT; index += 1) {
      decision = detector.observe(
        episode(`variant-${String(index)}`, {
          actionFeatures:
            index % 2 === 0 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
          continuationPrompt: true,
        }),
      );
    }
    expect(decision?.kind).toBe("similar_actions");
    if (decision?.kind === "similar_actions") {
      expect(decision.similarity).toBeGreaterThanOrEqual(0.85);
    }
  });

  it("does not trigger fuzzy matching for truncated episodes", () => {
    const detector = detectorWith();
    for (let index = 0; index < CONTINUATION_CHURN_COUNT; index += 1) {
      expect(
        detector.observe(
          episode(`truncated-${String(index)}`, {
            continuationPrompt: true,
            truncated: true,
          }),
        ),
      ).toBeNull();
    }
  });

  it("does not trigger fuzzy matching without continuation prompts", () => {
    const detector = detectorWith();
    for (let index = 0; index < CONTINUATION_CHURN_COUNT; index += 1) {
      expect(detector.observe(episode(`variant-${String(index)}`))).toBeNull();
    }
  });

  it("does not trigger continuation matching without tool actions", () => {
    const detector = detectorWith();
    for (let index = 0; index < CONTINUATION_CHURN_COUNT; index += 1) {
      expect(
        detector.observe(
          episode(`variant-${String(index)}`, {
            actionFeatures: [],
            continuationPrompt: true,
            toolCalls: 0,
          }),
        ),
      ).toBeNull();
    }
  });

  it("allows long histories of distinct work while keeping bounded state", () => {
    const detector = detectorWith();
    for (let index = 0; index < 4_228; index += 1) {
      expect(detector.observe(episode(`long-${String(index)}`))).toBeNull();
    }
    expect(detector.runCount).toBe(MAX_RUN_HISTORY);
    detector.reset();
    expect(detector.runCount).toBe(0);
  });

  it("follows configured thresholds and lets a detector be turned off", () => {
    const strict = detectorWith({ outcomeCycle: { maxLength: 1, repeats: 2 } });
    expect(strict.observe(episode("same"))).toBeNull();
    expect(strict.observe(episode("same"))).toEqual({
      cycleLength: 1,
      kind: "outcome_cycle",
      repeats: 2,
    });

    const off = detectorWith({ outcomeCycle: false, repeatedError: false, similarActions: false });
    for (let index = 0; index < 6; index += 1) {
      expect(
        off.observe(
          episode("same", {
            continuationPrompt: true,
            terminalError: true,
            terminalErrorFingerprint: "v1:same",
          }),
        ),
      ).toBeNull();
    }
  });
});
