import type { Detection } from "./core/detection.ts";

function evidence(detection: Detection): string {
  switch (detection.kind) {
    case "reasoning_repeat":
      return `${String(detection.matchedWindows)} separate ${String(detection.windowWords)}-word passages of your reasoning each appeared ${String(detection.repeats)} times in one response.`;
    case "outcome_cycle":
      return `The same ${String(detection.cycleLength)}-run cycle of outcomes repeated ${String(detection.repeats)} times.`;
    case "repeated_error":
      return `The same error ended ${String(detection.repeats)} runs in a row.`;
    case "similar_actions":
      return `${String(detection.runs)} runs after a "continue" prompt repeated ${String(Math.round(detection.similarity * 100))}% of the same actions.`;
  }
}

/** The default corrective message sent to the model. */
export function correctionText(detection: Detection): string {
  return [
    "Anti-Repeat detected repeated work.",
    "",
    `Evidence: ${evidence(detection)}`,
    "",
    "Stop the current approach. Do not rerun or slightly vary the same attempt.",
    "Before using more tools:",
    "1. Restate the objective and the facts you have verified.",
    "2. Name the actions you repeated and the claims that turned out wrong.",
    "3. Decide whether the current path is blocked.",
    "4. Choose one materially different next action.",
    "",
    "If no defensible new action exists, stop and ask the user.",
  ].join("\n");
}

/** A short description for notifications, such as "repeated reasoning". */
export function detectionLabel(detection: Detection): string {
  switch (detection.kind) {
    case "reasoning_repeat":
      return "repeated reasoning";
    case "outcome_cycle":
      return `a repeated ${String(detection.cycleLength)}-run cycle`;
    case "repeated_error":
      return "a repeated error";
    case "similar_actions":
      return "repeated actions";
  }
}
