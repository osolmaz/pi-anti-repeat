import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { resolveDetectorConfig } from "../src/core/config.ts";
import { ReasoningRepeatDetector } from "../src/core/reasoning.ts";

/** About 1 MB of reasoning that never repeats a long passage. */
function longReasoning(): string {
  const parts: string[] = [];
  let length = 0;
  for (let index = 0; length < 1_000_000; index += 1) {
    const sentence = `step ${String(index)} checks value ${String(index * 7919)} in module m${String(index % 97)}.`;
    parts.push(sentence);
    length += sentence.length + 1;
  }
  return parts.join(" ");
}

const TEXT = longReasoning();

function detectorWith(windowWords: number): ReasoningRepeatDetector {
  const config = resolveDetectorConfig({ reasoning: { windowWords } }).reasoning;
  if (config === false) throw new Error("Expected a reasoning config");
  return new ReasoningRepeatDetector(config);
}

/** Median time to stream `TEXT` in 24-character chunks, in milliseconds. */
function streamTime(windowWords: number): number {
  const samples: number[] = [];
  for (let round = 0; round < 5; round += 1) {
    const detector = detectorWith(windowWords);
    const start = performance.now();
    for (let offset = 0; offset < TEXT.length; offset += 24) {
      detector.observe(TEXT.slice(offset, offset + 24));
    }
    detector.finish();
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  return samples[2] ?? Number.POSITIVE_INFINITY;
}

describe("reasoning detector cost", () => {
  it("streams 1 MB of reasoning well within a frame budget per chunk", () => {
    expect(TEXT.length).toBeGreaterThanOrEqual(1_000_000);
    const milliseconds = streamTime(96);
    const chunks = Math.ceil(TEXT.length / 24);
    // Real streams arrive at a few thousand characters per second; this is far below that cost.
    expect(milliseconds).toBeLessThan(1_000);
    expect((milliseconds * 1_000) / chunks).toBeLessThan(25);
  });

  it("does not get slower with a larger window", () => {
    streamTime(32);
    const small = streamTime(32);
    const large = streamTime(2_048);
    expect(large / small).toBeLessThan(2);
  });
});
