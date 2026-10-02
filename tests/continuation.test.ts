import { describe, expect, it } from "vitest";

import { isContinuationPrompt } from "../src/core/continuation.ts";

describe("isContinuationPrompt", () => {
  it.each([
    "continue",
    "Continue please",
    "go on",
    "keep going",
    "you decide",
    "you choose",
    "do it now",
    "continue, you choose",
    "please continue and you decide now",
    "go ahead, then proceed",
  ])("treats %s as a continuation", (prompt) => {
    expect(isContinuationPrompt(prompt)).toBe(true);
  });

  it.each([
    "continue with a proof",
    "continue and",
    "continue, choose problem 488",
    "you choose the next test",
    "check the tests",
    "use a different method",
    "",
    `continue ${"please ".repeat(40)}`,
  ])("treats %s as a new instruction", (prompt) => {
    expect(isContinuationPrompt(prompt)).toBe(false);
  });
});
