import { describe, expect, it } from "vitest";

import type { Detection } from "../src/core/detection.ts";
import { correctionText, detectionLabel } from "../src/message.ts";

const detections: Detection[] = [
  { kind: "reasoning_repeat", matchedWindows: 3, repeats: 3, windowWords: 96, wordsObserved: 887 },
  { cycleLength: 2, kind: "outcome_cycle", repeats: 3 },
  { kind: "repeated_error", repeats: 3 },
  { kind: "similar_actions", runs: 4, similarity: 0.912 },
];

describe("correctionText", () => {
  it.each(detections)("gives short actionable evidence for $kind", (detection) => {
    const text = correctionText(detection);
    expect(text).toContain("Stop the current approach.");
    expect(text).toContain("Choose one materially different next action.");
    expect(text).toContain("Evidence:");
    expect(text.length).toBeLessThan(1_000);
    expect(detectionLabel(detection).length).toBeGreaterThan(0);
  });

  it("rounds action similarity to a percentage", () => {
    expect(correctionText({ kind: "similar_actions", runs: 4, similarity: 0.912 })).toContain(
      "91%",
    );
  });
});
