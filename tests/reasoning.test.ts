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

/** The recorded collapse: one token repeated behind a separator, like `= the = the = the`. */
function tokenLoop(token: string, cycles: number): string {
  return `= ${token}`.repeat(cycles);
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
    if (detection?.kind !== "reasoning_repeat") throw new Error("Expected a detection");
    // Only the periodic path reports a period.
    expect(detection.period).toBeUndefined();
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

  it("catches a recorded-style status loop at the exact periodic span", () => {
    const detection = observeChunks(detector(), irregularChunks(statusLoop(375)));

    expect(detection?.kind).toBe("reasoning_repeat");
    if (detection?.kind !== "reasoning_repeat") throw new Error("Expected a detection");
    // The cycle is periodic from the first word, so the span fills at repeats windows. The
    // detector counts "re-invoking" as two words, making the cycle 71 words long.
    const cycleWords = statusLoop(1).match(/[\p{L}\p{N}_]+/gu)?.length ?? 0;
    expect(detection.wordsObserved).toBe(DEFAULT_REASONING.repeats * DEFAULT_REASONING.windowWords);
    expect(detection.period).toBe(cycleWords);
  });
});

describe("ReasoningRepeatDetector uniform loops", () => {
  it("catches a single-word loop whatever the window hash samples", () => {
    const detection = observeChunks(detector(), irregularChunks(tokenLoop("the", 2_000)));

    expect(detection).toMatchObject({ kind: "reasoning_repeat", period: 1 });
    if (detection?.kind !== "reasoning_repeat") throw new Error("Expected a detection");
    // The span must hold repeats non-overlapping windows, so the fire word is exact.
    expect(detection.wordsObserved).toBe(DEFAULT_REASONING.repeats * DEFAULT_REASONING.windowWords);
  });

  it("catches a two-word loop whatever the window hash samples", () => {
    const detection = observeChunks(detector(), irregularChunks(tokenLoop("alpha bravo", 1_000)));

    expect(detection).toMatchObject({ kind: "reasoning_repeat", period: 2 });
    if (detection?.kind !== "reasoning_repeat") throw new Error("Expected a detection");
    expect(detection.wordsObserved).toBe(DEFAULT_REASONING.repeats * DEFAULT_REASONING.windowWords);
  });

  it("catches short-period loops at their exact span", () => {
    const words8 = "alpha bravo charlie delta echo foxtrot golf hotel ";
    const words9 = `${words8}india `;
    const detection8 = observeChunks(detector(), irregularChunks(words8.repeat(500)));
    const detection9 = observeChunks(detector(), irregularChunks(words9.repeat(500)));

    expect(detection8).toMatchObject({ kind: "reasoning_repeat", period: 8 });
    expect(detection9).toMatchObject({ kind: "reasoning_repeat", period: 9 });
    if (detection8?.kind !== "reasoning_repeat" || detection9?.kind !== "reasoning_repeat") {
      throw new Error("Expected a detection");
    }
    expect(detection8.wordsObserved).toBe(
      DEFAULT_REASONING.repeats * DEFAULT_REASONING.windowWords,
    );
    expect(detection9.wordsObserved).toBe(
      DEFAULT_REASONING.repeats * DEFAULT_REASONING.windowWords,
    );
  });
});

describe("ReasoningRepeatDetector period boundaries", () => {
  it("catches every period up to the window size within the span", () => {
    for (let period = 1; period <= DEFAULT_REASONING.windowWords; period += 1) {
      const cycle = `${Array.from({ length: period }, (_, index) => `w${String(index)}`).join(" ")} `;
      const detection = observeChunks(detector(), irregularChunks(cycle.repeat(500)));

      expect(detection?.kind).toBe("reasoning_repeat");
      if (detection?.kind !== "reasoning_repeat") throw new Error(`period ${String(period)}`);
      // Small periods are caught by the periodic path at exactly the span, with the period
      // reported; larger ones may be caught earlier by the sampled table, which reports no
      // period. Either way the span never has to grow past repeats windows.
      expect(detection.wordsObserved).toBeLessThanOrEqual(
        DEFAULT_REASONING.repeats * DEFAULT_REASONING.windowWords,
      );
      if (detection.period !== undefined) expect(detection.period).toBe(period);
    }
  });

  it("hands periods past the window size to the sampled table", () => {
    const cycle = `${Array.from({ length: 97 }, (_, index) => `w${String(index)}`).join(" ")} `;
    const detection = observeChunks(detector(), irregularChunks(cycle.repeat(40)));

    expect(detection?.kind).toBe("reasoning_repeat");
    if (detection?.kind !== "reasoning_repeat") throw new Error("Expected a detection");
    expect(detection.period).toBeUndefined();
  });

  it("finds periods at the tracked bound with a larger window", () => {
    const config = resolveDetectorConfig({ reasoning: { windowWords: 512 } }).reasoning;
    if (config === false) throw new Error("Expected a reasoning config");
    const cycle = `${Array.from({ length: 256 }, (_, index) => `v${String(index)}`).join(" ")} `;
    const detection = observeChunks(
      new ReasoningRepeatDetector(config),
      irregularChunks(cycle.repeat(40)),
    );

    expect(detection).toMatchObject({
      kind: "reasoning_repeat",
      period: 256,
      wordsObserved: 1_536,
    });
  });
});

describe("ReasoningRepeatDetector uniform loop detections", () => {
  it("catches a response that collapses into a punctuation flood", () => {
    const preface = variedReasoning(10);
    const prefaceWords = preface.trim().split(/\s+/).length;
    const collapsed = `${preface}\n${"= ".repeat(8_000)}`;

    const detection = observeChunks(detector(), irregularChunks(collapsed));

    expect(detection?.kind).toBe("reasoning_repeat");
    if (detection?.kind !== "reasoning_repeat") throw new Error("Expected a detection");
    expect(detection.wordsObserved).toBe(
      prefaceWords + DEFAULT_REASONING.repeats * DEFAULT_REASONING.windowWords,
    );
  });

  it("gives the same collapse detection for any chunk boundaries", () => {
    const collapsed = `${variedReasoning(10)}\n${"= ".repeat(8_000)}`;

    const whole = observeChunks(detector(), [collapsed]);
    const characters = observeChunks(detector(), Array.from(collapsed));

    expect(whole?.kind).toBe("reasoning_repeat");
    expect(characters).toEqual(whole);
  });

  it("catches an emoji flood split across surrogate halves", () => {
    const collapsed = `${variedReasoning(10)}\n${"\u{1F600}".repeat(4_000)}`;

    const whole = observeChunks(detector(), [collapsed]);
    // split("") cuts every emoji into two surrogate halves, which takeChunk must rejoin.
    const characters = observeChunks(detector(), collapsed.split(""));

    expect(whole?.kind).toBe("reasoning_repeat");
    expect(characters).toEqual(whole);
  });

  it("restarts the periodic span after the run breaks", () => {
    const target = detector();
    // One word short of the fire span, then one breaking word. The marker differs per segment,
    // so no window recurs for the sampled table either, and nothing may fire. The all-"the"
    // window recurs, but one distinct window cannot reach the three distinct windows the
    // sampled path needs.
    const broken = Array.from(
      { length: 40 },
      (_, index) =>
        `${"the ".repeat(DEFAULT_REASONING.repeats * DEFAULT_REASONING.windowWords - 1)}marker${String(index)} `,
    ).join("");
    expect(observeChunks(target, irregularChunks(broken))).toBeNull();

    const detection = observeChunks(target, irregularChunks(tokenLoop("the", 300)));
    if (detection?.kind !== "reasoning_repeat") throw new Error("Expected a detection");
    expect(detection.wordsObserved).toBe(
      41 * DEFAULT_REASONING.repeats * DEFAULT_REASONING.windowWords,
    );
  });

  it("catches the same collapse again after reset", () => {
    const target = detector();
    const loop = tokenLoop("the", 2_000);
    expect(observeChunks(target, irregularChunks(loop))?.kind).toBe("reasoning_repeat");

    target.reset();

    expect(target.wordsObserved).toBe(0);
    expect(observeChunks(target, irregularChunks(loop))?.kind).toBe("reasoning_repeat");
  });

  it("ends a separator run at finish so the next thinking block starts clean", () => {
    const target = detector();
    target.observe("=".repeat(10));
    expect(target.finish()).toBeNull();
    target.observe("=".repeat(10));
    target.finish();
    expect(target.wordsObserved).toBe(0);

    const joined = detector();
    joined.observe("=".repeat(10));
    joined.observe("=".repeat(10));
    joined.finish();
    expect(joined.wordsObserved).toBe(1);
  });
});

describe("ReasoningRepeatDetector punctuation handling", () => {
  it("does not fire while a punctuation flood is shorter than one window", () => {
    const collapsed = `${variedReasoning(20)}\n${"= ".repeat(500)}\n${variedReasoning(20)}`;
    expect(observeChunks(detector(), irregularChunks(collapsed))).toBeNull();
  });

  it("does not fire on isolated rules inside moving reasoning", () => {
    const prose = variedReasoning(600);
    const ruled = `${prose}\n\n${"-".repeat(72)}\n\n${"=".repeat(72)}\n\n done.`;
    expect(observeChunks(detector(), irregularChunks(ruled))).toBeNull();
  });

  it("does not fire on tables, indented code, or a small matrix", () => {
    const table = Array.from(
      { length: 40 },
      (_, index) =>
        `| cell ${String(index)} a | cell ${String(index)} b | cell ${String(index)} c |`,
    ).join("\n");
    const code = Array.from(
      { length: 40 },
      (_, index) =>
        `${" ".repeat(18)}value ${String(index)} = compute(input ${String(index)}, flag ${String(index)});`,
    ).join("\n");
    const matrix = Array.from({ length: 11 }, () => "0 ".repeat(11)).join("\n");
    const prose = [table, code, matrix, variedReasoning(100)].join("\n\n");

    expect(observeChunks(detector(), irregularChunks(prose))).toBeNull();
  });

  it("fires on a matrix large enough to be a flood of one token", () => {
    const matrix = Array.from({ length: 32 }, () => "0 ".repeat(32)).join("\n");
    expect(observeChunks(detector(), irregularChunks(matrix))?.kind).toBe("reasoning_repeat");
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
    // Recent window keys for period discovery are bounded independently of the window size.
    expect(target.periodTracked).toBeLessThanOrEqual(256);
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
