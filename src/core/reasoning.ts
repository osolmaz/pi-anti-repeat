import { DEFAULT_REASONING, type ReasoningConfig } from "./config.ts";
import type { Detection } from "./detection.ts";

// Two independent polynomial hashes keep every intermediate product below 2^53, so plain
// JavaScript numbers stay exact. Together they give a 52-bit window key.
const MODULUS_A = 67_108_859;
const MODULUS_B = 67_108_837;
const BASE_A = 31_337;
const BASE_B = 65_599;
const MAX_WORD_CHARACTERS = 128;
const NON_ASCII_WORD_CHARACTER = /^[\p{L}\p{M}\p{N}_]$/u;
// A run of separator characters carries no content. One reserved word per this many separator
// code units turns a punctuation flood into a word stream, at a rate that does not depend on
// where the provider cut the stream. The value is well below MAX_WORD_CHARACTERS because words
// carry meaning worth keeping whole, while separator runs do not.
const SEPARATOR_WORD_CHARACTERS = 16;
// Not a word character, so no real word can collide with it.
const SEPARATOR_WORD = "\u0000";
// Recent window keys kept for period discovery. The bound is fixed so the cost per word does not
// depend on the window size, and it sits above the default window so every period up to the
// window size is found. Recurrences at longer lags are left to the sampled table.
const MAX_PERIOD_TRACKED = 256;

type Occurrence = {
  counted: number;
  lastWord: number;
  evidenced: boolean;
};

function power(base: number, exponent: number, modulus: number): number {
  let result = 1;
  for (let index = 0; index < exponent; index += 1) result = (result * base) % modulus;
  return result;
}

function isAsciiWordCode(code: number): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === 95
  );
}

/**
 * Finds long passages that repeat inside one streamed response.
 *
 * Text arrives in arbitrary chunks. Words are letters, marks, digits, and underscores; case,
 * punctuation, whitespace, and Unicode composition do not matter, apart from long runs of
 * separators, which count as reserved words. Each word is hashed once, and the hash of the last
 * `windowWords` words is updated in place, so the cost per word does not depend on the window
 * size. Two paths produce a detection. Diverse loops are found by the sampled table: only
 * windows whose hash falls in a fixed sample are tracked, and several distinct windows must
 * each repeat. Short-period loops are found directly: the last window index of every recent
 * window key is kept, a repeat at a lag below the window size proves the stream is periodic,
 * and one periodic span of `repeats` non-overlapping windows carries the same evidence as the
 * sampled path needs, without sampling.
 */
export class ReasoningRepeatDetector {
  private readonly config: ReasoningConfig;
  private readonly removeA: number;
  private readonly removeB: number;
  private readonly ringA: Uint32Array;
  private readonly ringB: Uint32Array;
  private readonly tracked = new Map<number, Occurrence>();
  private readonly periodicWindows = new Map<number, number>();
  private carry = "";
  private carryNonAscii = false;
  private detected = false;
  private hashA = 0;
  private hashB = 0;
  private matched = 0;
  private pendingSurrogate = "";
  private periodLag = 0;
  private periodRun = 0;
  private separatorRun = 0;
  private wordA = 0;
  private wordB = 0;
  private words = 0;

  constructor(config: ReasoningConfig = DEFAULT_REASONING) {
    this.config = config;
    this.removeA = power(BASE_A, config.windowWords, MODULUS_A);
    this.removeB = power(BASE_B, config.windowWords, MODULUS_B);
    this.ringA = new Uint32Array(config.windowWords);
    this.ringB = new Uint32Array(config.windowWords);
  }

  get wordsObserved(): number {
    return this.words;
  }

  get trackedWindows(): number {
    return this.tracked.size;
  }

  get periodTracked(): number {
    return this.periodicWindows.size;
  }

  /** Adds one streamed chunk. Returns a detection once, then ignores input until `reset`. */
  observe(input: string): Detection | null {
    if (this.detected || input.length === 0) return null;
    return this.scan(this.takeChunk(input));
  }

  /** Joins a surrogate pair that the previous chunk cut in half, and holds back a new half. */
  private takeChunk(input: string): string {
    const chunk = this.pendingSurrogate + input;
    const last = chunk.charCodeAt(chunk.length - 1);
    const split = last >= 0xd800 && last <= 0xdbff;
    this.pendingSurrogate = split ? chunk.slice(-1) : "";
    return split ? chunk.slice(0, -1) : chunk;
  }

  private scan(chunk: string): Detection | null {
    let start = 0;
    let nonAscii = false;
    let index = 0;
    while (index < chunk.length) {
      const code = chunk.charCodeAt(index);
      const width = this.wordCharacterWidth(chunk, index, code);
      if (width === 0) {
        const detection = this.endSeparator(chunk, start, index, nonAscii);
        if (detection !== null) return detection;
        index += 1;
        start = index;
        nonAscii = false;
        continue;
      }
      this.separatorRun = 0;
      nonAscii ||= code >= 128;
      index += width;
      // Long runs of word characters are split every MAX_WORD_CHARACTERS code units, counted
      // across chunks, so the split does not depend on where the provider cut the stream.
      if (this.carry.length + index - start >= MAX_WORD_CHARACTERS) {
        const detection = this.endWord(chunk, start, index, nonAscii);
        if (detection !== null) return detection;
        start = index;
        nonAscii = false;
      }
    }
    this.carry += chunk.slice(start);
    this.carryNonAscii ||= nonAscii;
    return null;
  }

  /** Ends the current response. A word still in progress is counted. */
  finish(): Detection | null {
    if (this.detected) return null;
    this.pendingSurrogate = "";
    // A separator run must not continue into the next thinking block, which the caller feeds
    // after this without a reset.
    this.separatorRun = 0;
    return this.flushCarry();
  }

  reset(): void {
    this.carry = "";
    this.carryNonAscii = false;
    this.detected = false;
    this.hashA = 0;
    this.hashB = 0;
    this.matched = 0;
    this.pendingSurrogate = "";
    this.periodLag = 0;
    this.periodRun = 0;
    this.periodicWindows.clear();
    this.separatorRun = 0;
    this.words = 0;
    this.ringA.fill(0);
    this.ringB.fill(0);
    this.tracked.clear();
  }

  /** Returns how many code units the word character at `index` uses, or 0 for a separator. */
  private wordCharacterWidth(chunk: string, index: number, code: number): number {
    if (isAsciiWordCode(code)) return 1;
    if (code < 128) return 0;
    const point = chunk.codePointAt(index) ?? code;
    if (!NON_ASCII_WORD_CHARACTER.test(String.fromCodePoint(point))) return 0;
    return point > 0xffff ? 2 : 1;
  }

  /** Ends any word at a separator character, then folds long separator runs into reserved words. */
  private endSeparator(
    chunk: string,
    start: number,
    index: number,
    nonAscii: boolean,
  ): Detection | null {
    const word = this.endWord(chunk, start, index, nonAscii);
    if (word !== null) return word;
    // Long separator runs are degenerate content. Feed them to the window machinery as reserved
    // words so a punctuation flood is detected like any other uniform loop.
    this.separatorRun += 1;
    if (this.separatorRun % SEPARATOR_WORD_CHARACTERS !== 0) return null;
    return this.addWord(SEPARATOR_WORD, false);
  }

  private endWord(chunk: string, start: number, end: number, nonAscii: boolean): Detection | null {
    if (end === start && this.carry.length === 0) return null;
    const word = this.carry + chunk.slice(start, end);
    const wordNonAscii = nonAscii || this.carryNonAscii;
    this.carry = "";
    this.carryNonAscii = false;
    return this.addWord(word, wordNonAscii);
  }

  private flushCarry(): Detection | null {
    if (this.carry.length === 0) return null;
    const word = this.carry;
    const nonAscii = this.carryNonAscii;
    this.carry = "";
    this.carryNonAscii = false;
    return this.addWord(word, nonAscii);
  }

  /** Hashes one word into `wordA` and `wordB`. */
  private hashWord(raw: string, nonAscii: boolean): void {
    const word = nonAscii ? raw.normalize("NFKC").toLowerCase() : raw.toLowerCase();
    // FNV-1a over UTF-16 code units, with two different offsets for the two hashes.
    let fnvA = 0x811c9dc5;
    let fnvB = 0x01000193;
    for (let index = 0; index < word.length; index += 1) {
      const code = word.charCodeAt(index);
      fnvA = Math.imul(fnvA ^ code, 0x01000193);
      fnvB = Math.imul(fnvB ^ code, 0x01000193) ^ (code << 7);
    }
    this.wordA = (fnvA >>> 0) % MODULUS_A;
    this.wordB = (fnvB >>> 0) % MODULUS_B;
  }

  private addWord(raw: string, nonAscii: boolean): Detection | null {
    this.hashWord(raw, nonAscii);
    // The ring starts zeroed, so before the window is full the removed word contributes nothing.
    const slot = this.words % this.config.windowWords;
    const oldA = this.ringA[slot] ?? 0;
    const oldB = this.ringB[slot] ?? 0;
    this.hashA =
      (((this.hashA * BASE_A) % MODULUS_A) +
        MODULUS_A -
        ((oldA * this.removeA) % MODULUS_A) +
        this.wordA) %
      MODULUS_A;
    this.hashB =
      (((this.hashB * BASE_B) % MODULUS_B) +
        MODULUS_B -
        ((oldB * this.removeB) % MODULUS_B) +
        this.wordB) %
      MODULUS_B;
    this.ringA[slot] = this.wordA;
    this.ringB[slot] = this.wordB;
    this.words += 1;

    if (this.words < this.config.windowWords) return null;
    const periodic = this.observePeriodicity();
    if (periodic !== null) return periodic;
    if (this.hashA % this.config.sampleRate !== 0) return null;
    return this.countWindow(this.hashA * MODULUS_B + this.hashB);
  }

  /**
   * Checks the new full window against the recent full windows. A window whose hash matches the
   * hash from `lag` windows back proves the last `windowWords + lag` words are periodic with
   * period `lag`, which natural text never produces, so the match needs no sampling and no
   * non-overlap check. Consecutive matches at one lag extend the periodic span, and a span of
   * `repeats` non-overlapping windows carries the same evidence as the sampled path asks for
   * several distinct windows. That equivalence holds while the lag stays within the window
   * size, so longer recurrences are left to the sampled table. The map keeps the last window
   * index of the most recent keys under a fixed bound, so periods up to the smaller of the
   * window size and the bound are found, whatever the window size.
   */
  private observePeriodicity(): Detection | null {
    const index = this.words - this.config.windowWords;
    const key = this.hashA * MODULUS_B + this.hashB;
    const last = this.periodicWindows.get(key);
    this.periodicWindows.delete(key);
    this.periodicWindows.set(key, index);
    if (this.periodicWindows.size > MAX_PERIOD_TRACKED) {
      const oldest = this.periodicWindows.keys().next();
      if (oldest.done !== true) this.periodicWindows.delete(oldest.value);
    }
    return this.extendPeriodRun(last === undefined ? 0 : index - last);
  }

  /** Extends the periodic run with a match at `lag`, and reports when the span is long enough. */
  private extendPeriodRun(lag: number): Detection | null {
    const periodic = lag !== 0 && lag <= this.config.windowWords ? lag : 0;
    if (periodic === 0) {
      this.periodLag = 0;
      this.periodRun = 0;
      return null;
    }
    this.periodRun = periodic === this.periodLag ? this.periodRun + 1 : 1;
    this.periodLag = periodic;
    if (this.periodRun < (this.config.repeats - 1) * this.config.windowWords - periodic + 1) {
      return null;
    }
    return this.reasoningDetection(periodic);
  }

  /** Reports one detection once, then ignores input until `reset`. */
  private reasoningDetection(period: number | undefined): Detection {
    this.detected = true;
    const detection: Detection = {
      kind: "reasoning_repeat",
      matchedWindows: this.config.matchedWindows,
      repeats: this.config.repeats,
      windowWords: this.config.windowWords,
      wordsObserved: this.words,
    };
    return period === undefined ? detection : { ...detection, period };
  }

  private countWindow(key: number): Detection | null {
    const occurrence = this.tracked.get(key);
    if (occurrence === undefined) {
      if (this.tracked.size >= this.config.maxTrackedWindows) {
        const oldest = this.tracked.keys().next();
        if (oldest.done !== true) this.tracked.delete(oldest.value);
      }
      this.tracked.set(key, { counted: 1, evidenced: false, lastWord: this.words });
      return null;
    }
    if (occurrence.evidenced || this.words - occurrence.lastWord < this.config.windowWords) {
      return null;
    }
    occurrence.counted += 1;
    occurrence.lastWord = this.words;
    if (occurrence.counted < this.config.repeats) return null;
    occurrence.evidenced = true;
    this.matched += 1;
    if (this.matched < this.config.matchedWindows) return null;
    return this.reasoningDetection(undefined);
  }
}
