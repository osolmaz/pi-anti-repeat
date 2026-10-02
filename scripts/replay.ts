// Replays the streamed reasoning in Pi session files through the reasoning detector.
//
// Usage: npm run replay -- [--chunk 24] <session.jsonl...>
//
// It prints one line per response that the detector flags, with how far into the response it
// fired, and a summary with the detector's time per chunk. Session text is never printed.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { DEFAULT_REASONING } from "../src/core/config.ts";
import { ReasoningRepeatDetector } from "../src/core/reasoning.ts";

type Totals = { chunks: number; flagged: number; milliseconds: number; responses: number };

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

function thinkingText(item: unknown): string {
  if (field(item, "type") !== "thinking") return "";
  const thinking = field(item, "thinking");
  return typeof thinking === "string" ? thinking : "";
}

function reasoningOf(line: string): string | null {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  const message = field(row, "message");
  const content = field(message, "content");
  if (field(message, "role") !== "assistant" || !Array.isArray(content)) return null;
  const text = content.map(thinkingText).join("");
  return text.length === 0 ? null : text;
}

function replayFile(path: string, chunk: number, totals: Totals): void {
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, index) => {
    const text = reasoningOf(line);
    if (text === null) return;
    totals.responses += 1;
    const detector = new ReasoningRepeatDetector(DEFAULT_REASONING);
    const start = performance.now();
    let firedAt = -1;
    for (let offset = 0; offset < text.length && firedAt < 0; offset += chunk) {
      totals.chunks += 1;
      if (detector.observe(text.slice(offset, offset + chunk)) !== null) firedAt = offset + chunk;
    }
    if (firedAt < 0 && detector.finish() !== null) firedAt = text.length;
    totals.milliseconds += performance.now() - start;
    if (firedAt < 0) return;
    totals.flagged += 1;
    const share = ((Math.min(firedAt, text.length) / text.length) * 100).toFixed(1);
    console.log(
      `${path}:${String(index + 1)} flagged after ${String(detector.wordsObserved)} words, ${share}% of ${String(text.length)} characters`,
    );
  });
}

function parseArgs(args: readonly string[]): { chunk: number; files: string[] } {
  const chunkFlag = args.indexOf("--chunk");
  const chunk = chunkFlag < 0 ? 24 : Number(args[chunkFlag + 1]);
  const files = args.filter((_, index) => index !== chunkFlag && index !== chunkFlag + 1);
  return { chunk, files: chunkFlag < 0 ? [...args] : files };
}

function main(args: readonly string[]): void {
  const { chunk, files } = parseArgs(args);
  if (files.length === 0 || !Number.isInteger(chunk) || chunk < 1) {
    console.error("usage: npm run replay -- [--chunk N] <session.jsonl...>");
    process.exitCode = 2;
    return;
  }
  const totals: Totals = { chunks: 0, flagged: 0, milliseconds: 0, responses: 0 };
  for (const file of files) replayFile(file, chunk, totals);
  const perChunk = totals.chunks === 0 ? 0 : (totals.milliseconds * 1_000) / totals.chunks;
  console.log(
    `${String(totals.responses)} responses with reasoning, ${String(totals.flagged)} flagged, ` +
      `${totals.milliseconds.toFixed(1)} ms in the detector, ${perChunk.toFixed(2)} us per ${String(chunk)}-character chunk`,
  );
}

main(process.argv.slice(2));
