import type { Detection } from "./core/detection.ts";

/** `pi.events` channel where Anti-Repeat reports what it does. */
export const ANTI_REPEAT_EVENT_CHANNEL = "anti-repeat";

/** `pi.events` channel where other extensions can control Anti-Repeat. */
export const ANTI_REPEAT_CONTROL_CHANNEL = "anti-repeat:control";

/** `customType` of the visible corrective message. */
export const ANTI_REPEAT_MESSAGE_TYPE = "anti-repeat";

export const ANTI_REPEAT_PROTOCOL_VERSION = 1;

export type AntiRepeatEventType =
  "detected" | "corrected" | "stopped" | "reset" | "enabled" | "disabled";

/**
 * Emitted on `ANTI_REPEAT_EVENT_CHANNEL`.
 *
 * - `detected`: a detector fired. Every detection emits this first, whatever the policy decides.
 * - `corrected`: Anti-Repeat is sending its corrective message.
 * - `stopped`: Anti-Repeat stopped the run, or will not intervene again until the next epoch.
 *   Extensions that continue runs on their own should pause.
 * - `reset`: a new detection epoch started.
 * - `enabled` and `disabled`: the user or another extension turned detection on or off.
 */
export type AntiRepeatEvent = {
  readonly version: typeof ANTI_REPEAT_PROTOCOL_VERSION;
  readonly type: AntiRepeatEventType;
  readonly epoch: number;
  readonly detection?: Detection;
};

export type AntiRepeatControlAction = "pause" | "resume" | "reset" | "ignore-next-run";

/**
 * Accepted on `ANTI_REPEAT_CONTROL_CHANNEL`.
 *
 * - `pause` and `resume`: stop and restart detection without changing the user's on or off choice.
 * - `reset`: start a new detection epoch.
 * - `ignore-next-run`: do not count the next run. Send it just before restarting a run on purpose,
 *   for example after cutting off a response, so the regenerated text is not counted as a repeat.
 */
export type AntiRepeatControl = {
  readonly version: typeof ANTI_REPEAT_PROTOCOL_VERSION;
  readonly action: AntiRepeatControlAction;
  /** Name of the sending extension, for diagnostics. */
  readonly source: string;
};

/** Data stored in the `details` of the corrective message. */
export type AntiRepeatMessageDetails = {
  readonly version: typeof ANTI_REPEAT_PROTOCOL_VERSION;
  readonly detection: Detection;
};

const CONTROL_ACTIONS: readonly AntiRepeatControlAction[] = [
  "pause",
  "resume",
  "reset",
  "ignore-next-run",
];

function isControlAction(value: unknown): value is AntiRepeatControlAction {
  return CONTROL_ACTIONS.some((action) => action === value);
}

function isSource(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100;
}

/** Returns the control message, or null when the value is not a valid one. */
export function parseControl(value: unknown): AntiRepeatControl | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const version: unknown = Reflect.get(value, "version");
  const action: unknown = Reflect.get(value, "action");
  const source: unknown = Reflect.get(value, "source");
  if (version !== ANTI_REPEAT_PROTOCOL_VERSION || !isControlAction(action) || !isSource(source)) {
    return null;
  }
  return { action, source, version };
}
