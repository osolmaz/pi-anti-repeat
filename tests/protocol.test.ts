import { describe, expect, it } from "vitest";

import { parseControl } from "../src/protocol.ts";

describe("parseControl", () => {
  it.each(["pause", "resume", "reset", "ignore-next-run"] as const)("accepts %s", (action) => {
    expect(parseControl({ action, source: "localpi", version: 1 })).toEqual({
      action,
      source: "localpi",
      version: 1,
    });
  });

  it.each([
    null,
    "pause",
    [],
    { action: "pause", source: "x", version: 2 },
    { action: "explode", source: "x", version: 1 },
    { action: "pause", source: "", version: 1 },
    { action: "pause", source: "x".repeat(101), version: 1 },
    { action: "pause", version: 1 },
  ])("rejects %j", (value) => {
    expect(parseControl(value)).toBeNull();
  });
});
