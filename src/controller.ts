import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { Detection } from "./core/detection.ts";
import { RepeatDetector } from "./core/index.ts";
import { correctionText, detectionLabel } from "./message.ts";
import type { AntiRepeatAction, ResolvedOptions } from "./options.ts";
import {
  ANTI_REPEAT_EVENT_CHANNEL,
  ANTI_REPEAT_MESSAGE_TYPE,
  ANTI_REPEAT_PROTOCOL_VERSION,
  type AntiRepeatControl,
  type AntiRepeatEvent,
  type AntiRepeatEventType,
  type AntiRepeatMessageDetails,
} from "./protocol.ts";

const MAX_MESSAGE_CHARACTERS = 4_000;
const ACTIONS: readonly AntiRepeatAction[] = ["ignore", "notify", "correct", "stop"];

export type ControllerRuntime = Pick<ExtensionAPI, "events" | "sendMessage">;

export type ControllerContext = Pick<
  ExtensionContext,
  "abort" | "hasPendingMessages" | "isIdle"
> & {
  readonly ui: Pick<ExtensionContext["ui"], "notify" | "setStatus">;
};

/** Adds the stream listener and returns a function that removes it. */
export type StreamSubscriber = () => () => void;

export type InputEvent = {
  readonly source: "extension" | "interactive" | "rpc";
  readonly streamingBehavior?: "followUp" | "steer";
  readonly text: string;
};

export type StreamEvent = {
  readonly assistantMessageEvent: { readonly type: string; readonly delta?: string };
};

export type CorrectionEntry = {
  readonly type: "custom_message";
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
  readonly details: AntiRepeatMessageDetails;
};

export type BoundaryResult = { readonly entries: CorrectionEntry[]; readonly continue: true };

export type AntiRepeatState = "off" | "paused" | "watching" | "corrected" | "stopped";

function isAssistant(message: unknown): boolean {
  return (
    typeof message === "object" && message !== null && Reflect.get(message, "role") === "assistant"
  );
}

function isAction(value: unknown): value is AntiRepeatAction {
  return ACTIONS.some((action) => action === value);
}

/**
 * Connects Pi's lifecycle events to the detectors and carries out the policy.
 *
 * One epoch runs from the last substantive user instruction, reset, or enable. Detection stops for
 * the rest of an epoch after a `stop`. Nothing is persisted.
 */
export class AntiRepeatController {
  private readonly options: ResolvedOptions;
  private readonly runtime: ControllerRuntime;
  private readonly subscribeStream: StreamSubscriber;
  private readonly detector: RepeatDetector;
  private context: ControllerContext | null = null;
  private corrections = 0;
  private enabled = false;
  private epoch = 0;
  private ignoreNextRun = false;
  private nextRunContinuation = false;
  private paused = false;
  private pendingCorrection: Detection | null = null;
  private responseFinished = false;
  private restartRunAtTurn = false;
  private skipRun = false;
  private stopped = false;
  private unsubscribeStream: (() => void) | null = null;

  constructor(
    options: ResolvedOptions,
    runtime: ControllerRuntime,
    subscribeStream: StreamSubscriber,
  ) {
    this.options = options;
    this.runtime = runtime;
    this.subscribeStream = subscribeStream;
    this.detector = new RepeatDetector(options.detectors);
  }

  get state(): AntiRepeatState {
    if (!this.enabled) return "off";
    if (this.paused) return "paused";
    if (this.stopped) return "stopped";
    return this.corrections > 0 ? "corrected" : "watching";
  }

  get statusText(): string {
    switch (this.state) {
      case "off":
        return "Anti-Repeat is off.";
      case "paused":
        return "Anti-Repeat is paused by another extension.";
      case "watching":
        return `Anti-Repeat is watching epoch ${String(this.epoch)}.`;
      case "corrected":
        return "Anti-Repeat sent one correction and will stop the run if the repetition continues.";
      case "stopped":
        return "Anti-Repeat stopped this epoch. Give a new instruction or run reset to watch again.";
    }
  }

  /** True when streamed reasoning of the current response should be checked. */
  private get checkingResponse(): boolean {
    return this.collecting && !this.responseFinished && !this.skipRun;
  }

  /** True when lifecycle events should be recorded. */
  private get collecting(): boolean {
    return this.enabled && !this.paused && !this.stopped;
  }

  // Session and user control -----------------------------------------------------------------

  sessionStart(ctx: ControllerContext): void {
    this.context = ctx;
    this.paused = false;
    this.ignoreNextRun = false;
    this.enabled = this.options.enabled;
    this.startEpoch(false);
    this.refresh();
  }

  sessionShutdown(ctx: ControllerContext): void {
    this.context = ctx;
    this.enabled = false;
    this.startEpoch(false);
    this.refresh();
    this.context = null;
  }

  setEnabled(enabled: boolean, ctx: ControllerContext): void {
    this.context = ctx;
    this.enabled = enabled;
    this.startEpoch(true);
    this.refresh();
    this.emit(enabled ? "enabled" : "disabled");
    this.notify(enabled ? "Anti-Repeat is on." : "Anti-Repeat is off.", "info");
  }

  reset(ctx: ControllerContext): void {
    this.context = ctx;
    if (!this.enabled) {
      this.notify("Anti-Repeat is off. Turn it on first.", "warning");
      return;
    }
    this.startEpoch(true);
    this.refresh();
    this.emit("reset");
    this.notify("Anti-Repeat started a new epoch.", "info");
  }

  control(message: AntiRepeatControl): void {
    switch (message.action) {
      case "pause":
        this.paused = true;
        this.skipRun = this.detector.runOpen || this.skipRun;
        break;
      case "resume":
        this.paused = false;
        break;
      case "reset":
        if (this.enabled) {
          this.startEpoch(true);
          this.emit("reset");
        }
        break;
      case "ignore-next-run":
        this.ignoreNextRun = true;
        break;
    }
    this.refresh();
  }

  // Pi lifecycle ------------------------------------------------------------------------------

  input(event: InputEvent, ctx: ControllerContext): void {
    this.context = ctx;
    if (!this.enabled || this.paused || event.source === "extension") return;
    if (this.isContinuation(event.text)) {
      this.nextRunContinuation = true;
      return;
    }
    const wasActive = this.stopped || this.corrections > 0 || this.detector.runOpen;
    this.startEpoch(true);
    this.refresh();
    if (wasActive) this.emit("reset");
  }

  runStart(): void {
    if (!this.collecting || this.restartRunAtTurn || this.detector.runOpen) return;
    if (this.ignoreNextRun) {
      this.ignoreNextRun = false;
      this.skipRun = true;
    }
    this.detector.startRun(this.nextRunContinuation);
    this.nextRunContinuation = false;
  }

  turnStart(): void {
    if (!this.collecting) return;
    if (this.restartRunAtTurn) {
      // The user gave new direction mid-run: count only what happens from this turn on.
      this.restartRunAtTurn = false;
      this.detector.startRun(false);
      return;
    }
    this.runStart();
  }

  messageStart(message: unknown): void {
    if (!this.collecting || !isAssistant(message)) return;
    this.detector.startReasoning();
    this.responseFinished = false;
  }

  /** Called for every streamed event while the stream listener is subscribed. */
  messageUpdate(event: StreamEvent, ctx: ControllerContext): void {
    const update = event.assistantMessageEvent;
    if (update.type !== "thinking_delta" && update.type !== "thinking_end") return;
    if (!this.checkingResponse) return;
    const detection =
      update.type === "thinking_delta"
        ? this.detector.observeReasoning(update.delta ?? "")
        : this.detector.endReasoning();
    if (detection !== null) this.handleResponseDetection(detection, ctx);
  }

  turnEnd(message: unknown, toolResults: readonly unknown[]): void {
    if (!this.collecting || this.skipRun || this.restartRunAtTurn) return;
    this.runStart();
    this.detector.recordTurn(message, toolResults);
  }

  agentEnd(messages: readonly unknown[]): void {
    if (!this.collecting || this.skipRun || this.restartRunAtTurn) return;
    this.detector.recordRunEnd(messages);
  }

  /** Checks the finished run. A correction is returned for Pi to commit before it continues. */
  beforeSettle(ctx: ControllerContext): BoundaryResult | undefined {
    this.context = ctx;
    const detection = this.closeRun();
    if (detection === null) return undefined;
    const action = this.decide(detection, false);
    if (action === "stop") {
      this.stop(detection, false, ctx);
      return undefined;
    }
    if (action !== "correct") return undefined;
    this.beginCorrection(detection);
    return { continue: true, entries: [this.correctionEntry(detection)] };
  }

  /** Runs after an aborted run, which skips `beforeSettle`, and delivers a pending correction. */
  settled(ctx: ControllerContext): void {
    this.context = ctx;
    const detection = this.closeRun();
    if (detection !== null) {
      const action = this.decide(detection, false);
      if (action === "stop") this.stop(detection, false, ctx);
      if (action === "correct") {
        this.beginCorrection(detection);
        this.pendingCorrection = detection;
      }
    }
    this.responseFinished = false;
    this.restartRunAtTurn = false;
    this.skipRun = false;
    this.deliverPendingCorrection(ctx);
  }

  // Decisions ---------------------------------------------------------------------------------

  private handleResponseDetection(detection: Detection, ctx: ControllerContext): void {
    this.context = ctx;
    this.responseFinished = true;
    const action = this.decide(detection, true);
    if (action === "stop") {
      this.stop(detection, true, ctx);
      return;
    }
    if (action !== "correct") return;
    this.beginCorrection(detection);
    this.pendingCorrection = detection;
    this.skipRun = true;
    ctx.abort();
    this.notify(`Anti-Repeat cut off the response after ${detectionLabel(detection)}.`, "warning");
  }

  /** Emits `detected`, asks the policy, and shows a notification when asked to. */
  private decide(detection: Detection, activeResponse: boolean): AntiRepeatAction {
    this.emit("detected", detection);
    let action: AntiRepeatAction = "notify";
    try {
      const chosen = this.options.policy({
        activeResponse,
        corrections: this.corrections,
        detection,
      });
      if (isAction(chosen)) action = chosen;
    } catch {
      this.notify("The Anti-Repeat policy failed; only notifying.", "error");
    }
    if (action === "notify")
      this.notify(`Anti-Repeat detected ${detectionLabel(detection)}.`, "warning");
    return action;
  }

  private beginCorrection(detection: Detection): void {
    this.corrections += 1;
    this.refresh();
    this.emit("corrected", detection);
  }

  private stop(detection: Detection, activeResponse: boolean, ctx: ControllerContext): void {
    this.stopped = true;
    this.pendingCorrection = null;
    this.detector.discardRun();
    if (activeResponse) {
      this.skipRun = true;
      ctx.abort();
    }
    this.refresh();
    this.emit("stopped", detection);
    this.notify(
      `Anti-Repeat stopped after ${detectionLabel(detection)}. Give a new instruction to continue.`,
      "error",
    );
  }

  private closeRun(): Detection | null {
    if (!this.detector.runOpen) return null;
    if (!this.collecting || this.skipRun) {
      this.detector.discardRun();
      return null;
    }
    return this.detector.finishRun();
  }

  private deliverPendingCorrection(ctx: ControllerContext): void {
    const detection = this.pendingCorrection;
    this.pendingCorrection = null;
    if (detection === null || !this.enabled || this.stopped) return;
    const entry = this.correctionEntry(detection);
    try {
      this.runtime.sendMessage(entry, {
        deliverAs: "followUp",
        triggerTurn: ctx.isIdle() && !ctx.hasPendingMessages(),
      });
    } catch {
      this.stop(detection, false, ctx);
      this.notify("Anti-Repeat could not send its correction.", "error");
    }
  }

  private correctionEntry(detection: Detection): CorrectionEntry {
    let content: string;
    try {
      content = this.options.message(detection);
    } catch {
      content = correctionText(detection);
    }
    if (content.length === 0) content = correctionText(detection);
    return {
      content: content.slice(0, MAX_MESSAGE_CHARACTERS),
      customType: ANTI_REPEAT_MESSAGE_TYPE,
      details: { detection, version: ANTI_REPEAT_PROTOCOL_VERSION },
      display: true,
      type: "custom_message",
    };
  }

  // State helpers -----------------------------------------------------------------------------

  private isContinuation(text: string): boolean {
    try {
      return this.options.isContinuation(text);
    } catch {
      return false;
    }
  }

  /**
   * Starts a new epoch and forgets all evidence. When it happens in the middle of a run, the rest
   * of the current response is not checked and counting restarts at the next turn.
   */
  private startEpoch(duringSession: boolean): void {
    const runInProgress = duringSession && this.detector.runOpen;
    this.epoch += 1;
    this.corrections = 0;
    this.stopped = false;
    this.pendingCorrection = null;
    this.nextRunContinuation = false;
    this.detector.reset();
    this.restartRunAtTurn = runInProgress;
    this.responseFinished = runInProgress;
    if (!duringSession) this.skipRun = false;
  }

  private refresh(): void {
    const want = this.collecting;
    if (want && this.unsubscribeStream === null) this.unsubscribeStream = this.subscribeStream();
    if (!want && this.unsubscribeStream !== null) {
      this.unsubscribeStream();
      this.unsubscribeStream = null;
    }
    if (this.options.status === false || this.context === null) return;
    const state = this.state;
    this.context.ui.setStatus(
      this.options.status,
      state === "off" ? undefined : `anti-repeat: ${state}`,
    );
  }

  private emit(type: AntiRepeatEventType, detection?: Detection): void {
    const event: AntiRepeatEvent =
      detection === undefined
        ? { epoch: this.epoch, type, version: ANTI_REPEAT_PROTOCOL_VERSION }
        : { detection, epoch: this.epoch, type, version: ANTI_REPEAT_PROTOCOL_VERSION };
    try {
      this.runtime.events.emit(ANTI_REPEAT_EVENT_CHANNEL, event);
    } catch {
      // A failing listener in another extension must not change what Anti-Repeat does.
    }
  }

  private notify(message: string, level: "info" | "warning" | "error"): void {
    if (!this.options.notify || this.context === null) return;
    this.context.ui.notify(message, level);
  }
}
