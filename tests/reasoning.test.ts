import { describe, expect, it } from "vitest";

import {
  DEFAULT_REASONING,
  resolveDetectorConfig,
  type ReasoningConfig,
} from "../src/core/config.ts";
import type { Detection } from "../src/core/detection.ts";
import { ReasoningRepeatDetector } from "../src/core/reasoning.ts";

function detector(options: Partial<ReasoningConfig> = {}): ReasoningRepeatDetector {
  const config = resolveDetectorConfig({ reasoning: options }).reasoning;
  if (config === false) throw new Error("Expected a reasoning config");
  return new ReasoningRepeatDetector(config);
}

function passage(prefix = "reasoning"): string {
  return Array.from({ length: 176 }, (_, index) => `${prefix}${String(index)}`).join(" ");
}

function observeChunks(
  target: ReasoningRepeatDetector,
  chunks: readonly string[],
): Detection | null {
  for (const chunk of chunks) {
    const detection = target.observe(chunk);
    if (detection !== null) return detection;
  }
  return target.finish();
}

function irregularChunks(value: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  let width = 1;
  while (offset < value.length) {
    chunks.push(value.slice(offset, offset + width));
    offset += width;
    width = (width * 7) % 43 || 1;
  }
  return chunks;
}

/** The shape of the recorded loop: a short cycle of status sentences repeated many times. */
function statusLoop(cycles: number): string {
  const cycle = [
    "The pending job queued and the script is waiting for the next poll result.",
    "Current state: the recovery script was served and the output file is still empty.",
    "Let me stop re-invoking stale sessions and check the output once more.",
    "Wait, I already ran the job, so the earlier result must be from the old session.",
    "OK, run the pending job again and poll the output file after it finishes.",
  ].join(" ");
  return Array.from({ length: cycles }, () => cycle).join(" ");
}

/** Long reasoning that keeps moving: every sentence names a new step and new values. */
function variedReasoning(sentences: number): string {
  const verbs = ["inspect", "compare", "measure", "rewrite", "verify", "trace", "profile", "split"];
  const objects = ["parser", "cache", "queue", "schema", "router", "index", "worker", "client"];
  return Array.from({ length: sentences }, (_, index) => {
    const verb = verbs[index % verbs.length] ?? "check";
    const object = objects[(index * 3) % objects.length] ?? "module";
    return `Step ${String(index)}: ${verb} the ${object} near line ${String(index * 17)} and note result ${String(index * 31)}.`;
  }).join(" ");
}

describe("ReasoningRepeatDetector", () => {
  it("detects three long repeated passages", () => {
    const repeated = passage();
    const detection = observeChunks(detector(), [`${repeated} ${repeated} ${repeated}`]);

    expect(detection).toMatchObject({
      kind: "reasoning_repeat",
      matchedWindows: DEFAULT_REASONING.matchedWindows,
      repeats: DEFAULT_REASONING.repeats,
      windowWords: DEFAULT_REASONING.windowWords,
    });
  });

  it("gives the same result for any chunk boundaries", () => {
    const repeated = passage("chunk");
    const input = `${repeated}\n${repeated}\n${repeated}`;

    const whole = observeChunks(detector(), [input]);
    const characters = observeChunks(detector(), Array.from(input));
    const irregular = observeChunks(detector(), irregularChunks(input));

    expect(whole).not.toBeNull();
    expect(characters).toEqual(whole);
    expect(irregular).toEqual(whole);
  });

  it("ignores case, punctuation, whitespace, and Unicode composition", () => {
    const composed = Array.from({ length: 176 }, (_, index) => `Café${String(index)}`).join(" ");
    const decomposed = composed.normalize("NFD").toUpperCase().replaceAll(" ", ",\n\t");
    const detection = observeChunks(
      detector(),
      irregularChunks(`${composed} ${decomposed} ${composed}`),
    );

    expect(detection?.kind).toBe("reasoning_repeat");
  });

  it("splits long words at the same place whatever the chunk boundaries", () => {
    const longWord = "x".repeat(300);
    const text = Array.from({ length: 120 }, (_, index) => `${longWord}${String(index)}`).join(" ");
    const whole = detector();
    const characters = detector();
    observeChunks(whole, [text]);
    observeChunks(characters, Array.from(text));

    expect(characters.wordsObserved).toBe(whole.wordsObserved);
    expect(whole.wordsObserved).toBeGreaterThan(120);
  });

  it("reads letters outside the Basic Multilingual Plane when a chunk splits them", () => {
    const letter = "𝐀"; // U+1D400, one letter stored as two UTF-16 code units.
    const words = Array.from({ length: 176 }, (_, index) => `${letter}${String(index)}`).join(" ");
    const input = `${words} ${words} ${words}`;

    const whole = observeChunks(detector(), [input]);
    const units = observeChunks(detector(), input.split(""));

    expect(whole?.kind).toBe("reasoning_repeat");
    expect(units).toEqual(whole);
  });

  it("does not fire after only two occurrences", () => {
    const repeated = passage("twice");
    expect(observeChunks(detector(), [`${repeated} ${repeated}`])).toBeNull();
  });

  it("does not fire on short repeated phrases or ordinary planning", () => {
    const planning = [
      "First inspect the repository and identify the relevant module.",
      "Then add focused tests for the behavior under review.",
      "Run formatting type checking and the package test suite.",
      "Finally summarize the evidence and any remaining limitation.",
      "First inspect the repository and identify the relevant module.",
      "Then stop because the requested review is complete.",
    ].join(" ");
    expect(observeChunks(detector(), [planning])).toBeNull();
  });

  it("does not fire on long reasoning that keeps moving", () => {
    expect(observeChunks(detector(), irregularChunks(variedReasoning(3_000)))).toBeNull();
  });

  it("catches a recorded-style status loop within the first 1,000 words", () => {
    const detection = observeChunks(detector(), irregularChunks(statusLoop(375)));

    expect(detection?.kind).toBe("reasoning_repeat");
    if (detection?.kind !== "reasoning_repeat") throw new Error("Expected a detection");
    expect(detection.wordsObserved).toBeLessThan(1_000);
  });

  it("catches a cycle of long passages before the third cycle ends", () => {
    const preface = passage("preface").split(" ").slice(0, 40).join(" ");
    const cycle = [passage("density"), passage("overlap"), passage("reconsider")].join(" ");
    const detection = observeChunks(
      detector(),
      irregularChunks(`${preface} ${cycle} ${cycle} ${cycle} ${cycle}`),
    );

    if (detection?.kind !== "reasoning_repeat") throw new Error("Expected a detection");
    expect(detection.wordsObserved).toBeLessThan(
      preface.split(" ").length + cycle.split(" ").length * 3,
    );
  });

  it("follows configured window sizes and counts", () => {
    const small = detector({ matchedWindows: 1, repeats: 2, sampleRate: 1, windowWords: 8 });
    const words = "alpha beta gamma delta epsilon zeta eta theta";
    expect(observeChunks(small, [`${words} ${words}`])).toMatchObject({
      kind: "reasoning_repeat",
      matchedWindows: 1,
      repeats: 2,
      windowWords: 8,
    });
  });

  it("reports once and then ignores input until reset", () => {
    const target = detector();
    const repeated = passage("once");
    expect(target.observe(`${repeated} ${repeated} ${repeated}`)).not.toBeNull();
    expect(target.observe(`${repeated} ${repeated} ${repeated}`)).toBeNull();
    expect(target.finish()).toBeNull();
  });

  it("keeps tracked state bounded on long unique streams", () => {
    const target = detector();
    for (let index = 0; index < 50_000; index += 1) {
      expect(target.observe(`unique${String(index)} `)).toBeNull();
    }

    expect(target.trackedWindows).toBeLessThanOrEqual(DEFAULT_REASONING.maxTrackedWindows);
    expect(target.wordsObserved).toBe(50_000);
  });

  it("forgets every word on reset, including the last window", () => {
    const target = detector({ matchedWindows: 1, repeats: 2, sampleRate: 1, windowWords: 8 });
    const words = "one two three four five six seven eight";
    expect(observeChunks(target, [words])).toBeNull();
    expect(target.trackedWindows).toBeGreaterThan(0);

    target.reset();

    expect(target.trackedWindows).toBe(0);
    expect(target.wordsObserved).toBe(0);
    // Words left in the ring would corrupt the first window after a reset and hide this repeat.
    const fresh = detector({ matchedWindows: 1, repeats: 2, sampleRate: 1, windowWords: 8 });
    const expected = observeChunks(fresh, [`${words} ${words}`]);
    expect(expected?.kind).toBe("reasoning_repeat");
    expect(observeChunks(target, [`${words} ${words}`])).toEqual(expected);
  });

  it("ignores empty chunks", () => {
    const target = detector();
    expect(target.observe("")).toBeNull();
    expect(target.wordsObserved).toBe(0);
  });
});
