import { isContinuationPrompt } from "./core/continuation.ts";
import { resolveDetectorConfig, type DetectorConfig, type DetectorOptions } from "./core/config.ts";
import type { Detection } from "./core/detection.ts";
import { correctionText } from "./message.ts";

/**
 * What to do about one detection.
 *
 * - `ignore`: only emit the `detected` event.
 * - `notify`: also show a notification.
 * - `correct`: send the corrective message. A repeating response is cut off first.
 * - `stop`: cut off a repeating response, send nothing, and stay quiet until the next epoch.
 */
export type AntiRepeatAction = "ignore" | "notify" | "correct" | "stop";

export type PolicyInput = {
  readonly detection: Detection;
  /** Corrections already sent in this epoch. */
  readonly corrections: number;
  /** True when the detection came from a response that is still streaming. */
  readonly activeResponse: boolean;
};

export type AntiRepeatPolicy = (input: PolicyInput) => AntiRepeatAction;

export type AntiRepeatOptions = {
  /** Detect from the start of every session. Default `true`. */
  readonly enabled?: boolean;
  /** Slash command name, or `false` for no command. Default `"anti-repeat"`. */
  readonly command?: string | false;
  /** Footer status key, or `false` for no status. Default `"anti-repeat"`. */
  readonly status?: string | false;
  /** Show notifications. Default `true`. */
  readonly notify?: boolean;
  /** Detector thresholds. Set a detector to `false` to turn it off. */
  readonly detectors?: DetectorOptions;
  /** Says whether a user prompt only asks to keep going. Default: an English phrase list. */
  readonly isContinuation?: (text: string) => boolean;
  /** Chooses the action for each detection. Default: correct once, then stop. */
  readonly policy?: AntiRepeatPolicy;
  /** Builds the corrective message. */
  readonly message?: (detection: Detection) => string;
};

export type ResolvedOptions = {
  readonly enabled: boolean;
  readonly command: string | false;
  readonly status: string | false;
  readonly notify: boolean;
  readonly detectors: DetectorConfig;
  readonly isContinuation: (text: string) => boolean;
  readonly policy: AntiRepeatPolicy;
  readonly message: (detection: Detection) => string;
};

/** Corrects the first detection in an epoch and stops on the next one. */
export const defaultPolicy: AntiRepeatPolicy = ({ corrections }) =>
  corrections === 0 ? "correct" : "stop";

const DEFAULTS: Omit<ResolvedOptions, "detectors"> = {
  command: "anti-repeat",
  enabled: true,
  isContinuation: isContinuationPrompt,
  message: correctionText,
  notify: true,
  policy: defaultPolicy,
  status: "anti-repeat",
};

function choose<T>(value: T | undefined, fallback: T): T {
  return value ?? fallback;
}

/** Fills in defaults. Options set to `undefined` keep their default. */
export function resolveOptions(options: AntiRepeatOptions = {}): ResolvedOptions {
  return {
    command: choose(options.command, DEFAULTS.command),
    detectors: resolveDetectorConfig(options.detectors),
    enabled: choose(options.enabled, DEFAULTS.enabled),
    isContinuation: choose(options.isContinuation, DEFAULTS.isContinuation),
    message: choose(options.message, DEFAULTS.message),
    notify: choose(options.notify, DEFAULTS.notify),
    policy: choose(options.policy, DEFAULTS.policy),
    status: choose(options.status, DEFAULTS.status),
  };
}
