import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { AntiRepeatController, type BoundaryResult } from "../src/controller.ts";
import { resolveOptions, type AntiRepeatOptions, type PolicyInput } from "../src/options.ts";
import {
  ANTI_REPEAT_CONTROL_CHANNEL,
  ANTI_REPEAT_EVENT_CHANNEL,
  ANTI_REPEAT_MESSAGE_TYPE,
  type AntiRepeatControlAction,
  type AntiRepeatEvent,
} from "../src/protocol.ts";

type Sent = { message: { content: unknown; customType: string }; options: unknown };

function createHarness(
  options: AntiRepeatOptions = {},
  context: { idle?: boolean; pending?: boolean; sendFails?: boolean } = {},
) {
  const events = createEventBus();
  const emitted: AntiRepeatEvent[] = [];
  events.on(ANTI_REPEAT_EVENT_CHANNEL, (event) => emitted.push(event as AntiRepeatEvent));
  const sent: Sent[] = [];
  const runtime = {
    events,
    sendMessage: (message: Sent["message"], sendOptions?: unknown) => {
      if (context.sendFails === true) throw new Error("delivery failed");
      sent.push({ message, options: sendOptions });
    },
  };
  let subscriptions = 0;
  let active = 0;
  const subscribe = () => {
    subscriptions += 1;
    active += 1;
    return () => {
      active -= 1;
    };
  };
  const ctx = {
    abort: vi.fn(),
    hasPendingMessages: () => context.pending ?? false,
    isIdle: () => context.idle ?? true,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
  const controller = new AntiRepeatController(resolveOptions(options), runtime, subscribe);
  return {
    ctx,
    controller,
    emitted,
    events,
    sent,
    get activeSubscriptions() {
      return active;
    },
    get subscriptions() {
      return subscriptions;
    },
  };
}

type Harness = ReturnType<typeof createHarness>;

function toolTurn(command: string, result: string) {
  const id = `call-${command}`;
  return {
    message: {
      content: [{ arguments: { cmd: command }, id, name: "exec_command", type: "toolCall" }],
      role: "assistant",
      stopReason: "toolUse",
    },
    toolResults: [
      {
        content: [{ text: result, type: "text" }],
        isError: false,
        role: "toolResult",
        toolCallId: id,
        toolName: "exec_command",
      },
    ],
  };
}

/** Runs one complete agent run and returns what `agent_before_settle` returned. */
function run(
  harness: Harness,
  command: string,
  result = "same",
  prompt = "continue",
): BoundaryResult | undefined {
  harness.controller.input({ source: "interactive", text: prompt }, harness.ctx);
  harness.controller.runStart();
  harness.controller.turnStart();
  const turn = toolTurn(command, result);
  harness.controller.turnEnd(turn.message, turn.toolResults);
  harness.controller.agentEnd([turn.message, ...turn.toolResults]);
  const boundary = harness.controller.beforeSettle(harness.ctx);
  harness.controller.settled(harness.ctx);
  return boundary;
}

function repeatedThinking(prefix: string): string {
  const passage = Array.from({ length: 176 }, (_, index) => `${prefix}${String(index)}`).join(" ");
  return `${passage} ${passage} ${passage}`;
}

function stream(harness: Harness, thinking: string, chunk = 64): void {
  harness.controller.messageStart({ role: "assistant" });
  for (let offset = 0; offset < thinking.length; offset += chunk) {
    harness.controller.messageUpdate(
      {
        assistantMessageEvent: {
          delta: thinking.slice(offset, offset + chunk),
          type: "thinking_delta",
        },
      },
      harness.ctx,
    );
  }
  harness.controller.messageUpdate(
    { assistantMessageEvent: { type: "thinking_end" } },
    harness.ctx,
  );
}

function started(options: AntiRepeatOptions = {}, context = {}): Harness {
  const harness = createHarness(options, context);
  harness.controller.sessionStart(harness.ctx);
  return harness;
}

function control(harness: Harness, action: AntiRepeatControlAction): void {
  harness.controller.control({ action, source: "test", version: 1 });
}

describe("AntiRepeatController defaults", () => {
  it("watches from the start of a session and listens to the stream once", () => {
    const harness = started();
    expect(harness.controller.state).toBe("watching");
    expect(harness.activeSubscriptions).toBe(1);
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "anti-repeat",
      "anti-repeat: watching",
    );

    harness.controller.reset(harness.ctx);
    expect(harness.subscriptions).toBe(1);
  });

  it("does nothing and does not listen when started off", () => {
    const harness = started({ enabled: false });
    for (let index = 0; index < 6; index += 1)
      expect(run(harness, "python scan.py")).toBeUndefined();
    stream(harness, repeatedThinking("off"));

    expect(harness.controller.state).toBe("off");
    expect(harness.activeSubscriptions).toBe(0);
    expect(harness.emitted).toEqual([]);
    expect(harness.ctx.abort).not.toHaveBeenCalled();
  });
});

describe("AntiRepeatController run detections", () => {
  it("returns one correction for Pi to commit and continue", () => {
    const harness = started();
    expect(run(harness, "python scan.py")).toBeUndefined();
    expect(run(harness, "python scan.py")).toBeUndefined();
    const boundary = run(harness, "python scan.py");

    expect(boundary?.continue).toBe(true);
    expect(boundary?.entries).toHaveLength(1);
    expect(boundary?.entries[0]).toMatchObject({
      customType: ANTI_REPEAT_MESSAGE_TYPE,
      details: { detection: { kind: "outcome_cycle" }, version: 1 },
      display: true,
      type: "custom_message",
    });
    expect(harness.sent).toEqual([]);
    expect(harness.controller.state).toBe("corrected");
    expect(harness.emitted.map((event) => event.type)).toEqual(["detected", "corrected"]);
  });

  it("stops instead of sending a second correction", () => {
    const harness = started();
    for (let index = 0; index < 3; index += 1) run(harness, "python scan.py");
    let last: BoundaryResult | undefined;
    for (let index = 0; index < 3; index += 1) last = run(harness, "python scan.py");

    expect(last).toBeUndefined();
    expect(harness.controller.state).toBe("stopped");
    expect(harness.activeSubscriptions).toBe(0);
    expect(harness.emitted.map((event) => event.type)).toEqual([
      "detected",
      "corrected",
      "detected",
      "stopped",
    ]);
  });

  it("keeps the epoch across continuation prompts and resets it on new instructions", () => {
    const harness = started();
    run(harness, "python scan.py");
    run(harness, "python scan.py");
    run(harness, "python scan.py", "same", "now try the second dataset");
    expect(run(harness, "python scan.py")).toBeUndefined();
    expect(run(harness, "python scan.py")?.continue).toBe(true);
  });

  it("catches similar actions after continuation prompts", () => {
    const harness = started();
    let last: BoundaryResult | undefined;
    for (const position of [60, 70, 80, 90]) {
      last = run(
        harness,
        `python3 subset_scan.py --position ${String(position)} --cap ${String(position * 1_000_000)}`,
        `position ${String(position)} gave a different measurement`,
      );
    }
    expect(last?.entries[0]?.content).toContain('after a "continue" prompt');
  });

  it("ignores input from extensions for epochs", () => {
    const harness = started();
    run(harness, "python scan.py");
    run(harness, "python scan.py");
    harness.controller.input({ source: "extension", text: "a different instruction" }, harness.ctx);
    expect(run(harness, "python scan.py")?.continue).toBe(true);
  });

  it("checks a run that was aborted by the user when it settles", () => {
    const harness = started();
    run(harness, "python scan.py");
    run(harness, "python scan.py");
    harness.controller.input({ source: "interactive", text: "continue" }, harness.ctx);
    harness.controller.runStart();
    const turn = toolTurn("python scan.py", "same");
    harness.controller.turnEnd(turn.message, turn.toolResults);
    harness.controller.agentEnd([turn.message, ...turn.toolResults]);
    harness.controller.settled(harness.ctx);

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });
});

describe("AntiRepeatController streamed reasoning", () => {
  it("cuts off repeating reasoning and sends one correction after settling", () => {
    const harness = started();
    harness.controller.runStart();
    stream(harness, repeatedThinking("density"), 7);

    expect(harness.ctx.abort).toHaveBeenCalledOnce();
    expect(harness.sent).toEqual([]);
    expect(harness.controller.beforeSettle(harness.ctx)).toBeUndefined();

    harness.controller.settled(harness.ctx);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.message.customType).toBe(ANTI_REPEAT_MESSAGE_TYPE);
    expect(harness.sent[0]?.message.content).toEqual(
      expect.stringContaining("passages of your reasoning"),
    );
    expect(harness.sent[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(harness.controller.state).toBe("corrected");
  });

  it("stops on a second repeat without another correction", () => {
    const harness = started();
    harness.controller.runStart();
    stream(harness, repeatedThinking("first"), 31);
    harness.controller.settled(harness.ctx);
    harness.controller.runStart();
    stream(harness, repeatedThinking("second"), 29);
    harness.controller.settled(harness.ctx);

    expect(harness.ctx.abort).toHaveBeenCalledTimes(2);
    expect(harness.sent).toHaveLength(1);
    expect(harness.controller.state).toBe("stopped");
  });

  it("does not start a turn when other work is queued", () => {
    const harness = started({}, { pending: true });
    harness.controller.runStart();
    stream(harness, repeatedThinking("queued"));
    harness.controller.settled(harness.ctx);
    expect(harness.sent[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: false });
  });

  it("stops safely when the correction cannot be sent", () => {
    const harness = started({}, { sendFails: true });
    harness.controller.runStart();
    stream(harness, repeatedThinking("delivery"));
    harness.controller.settled(harness.ctx);

    expect(harness.sent).toEqual([]);
    expect(harness.controller.state).toBe("stopped");
    expect(harness.emitted.map((event) => event.type)).toContain("stopped");
  });

  it("ignores repeated answer text", () => {
    const harness = started();
    harness.controller.messageStart({ role: "assistant" });
    harness.controller.messageUpdate(
      { assistantMessageEvent: { delta: repeatedThinking("answer"), type: "text_delta" } },
      harness.ctx,
    );
    expect(harness.ctx.abort).not.toHaveBeenCalled();
  });

  it("drops partial evidence when the user steers, and counts again from the next turn", () => {
    const harness = started({}, { idle: false });
    const passage = Array.from({ length: 176 }, (_, index) => `partial${String(index)}`).join(" ");
    harness.controller.runStart();
    stream(harness, `${passage} ${passage}`);
    harness.controller.input(
      { source: "interactive", streamingBehavior: "steer", text: "prove a different lemma" },
      harness.ctx,
    );
    harness.controller.messageUpdate(
      { assistantMessageEvent: { delta: ` ${passage}`, type: "thinking_delta" } },
      harness.ctx,
    );
    expect(harness.ctx.abort).not.toHaveBeenCalled();

    harness.controller.turnStart();
    stream(harness, repeatedThinking("next"));
    expect(harness.ctx.abort).toHaveBeenCalledOnce();
  });

  it("drops a pending correction when the session shuts down", () => {
    const harness = started();
    harness.controller.runStart();
    stream(harness, repeatedThinking("shutdown"));
    harness.controller.sessionShutdown(harness.ctx);
    harness.controller.settled(harness.ctx);

    expect(harness.sent).toEqual([]);
    expect(harness.controller.state).toBe("off");
    expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("anti-repeat", undefined);
  });
});

describe("AntiRepeatController options", () => {
  it.each([
    ["ignore", 0],
    ["notify", 1],
  ] as const)("only reports when the policy says %s", (action, notifications) => {
    const harness = started({ policy: () => action });
    for (let index = 0; index < 3; index += 1)
      expect(run(harness, "python scan.py")).toBeUndefined();

    expect(harness.emitted.map((event) => event.type)).toEqual(["detected"]);
    expect(harness.ctx.ui.notify).toHaveBeenCalledTimes(notifications);
    expect(harness.controller.state).toBe("watching");
  });

  it("can stop at the first detection and passes the evidence to the policy", () => {
    const policy = vi.fn(() => "stop" as const);
    const harness = started({ policy });
    harness.controller.runStart();
    stream(harness, repeatedThinking("policy"));

    const input = policy.mock.calls[0] as unknown as [PolicyInput] | undefined;
    expect(input?.[0].activeResponse).toBe(true);
    expect(input?.[0].corrections).toBe(0);
    expect(input?.[0].detection.kind).toBe("reasoning_repeat");
    expect(harness.ctx.abort).toHaveBeenCalledOnce();
    expect(harness.controller.state).toBe("stopped");
  });

  it("falls back to notifying when the policy fails or returns nonsense", () => {
    const failing = started({
      policy: () => {
        throw new Error("broken");
      },
    });
    const nonsense = started({ policy: () => "explode" as unknown as "stop" });
    for (const harness of [failing, nonsense]) {
      for (let index = 0; index < 3; index += 1)
        expect(run(harness, "python scan.py")).toBeUndefined();
      expect(harness.controller.state).toBe("watching");
    }
  });

  it("uses a custom message, and the default when it fails or is empty", () => {
    const custom = started({ message: () => "Try something else." });
    const failing = started({
      message: () => {
        throw new Error("broken");
      },
    });
    const empty = started({ message: () => "" });
    const long = started({ message: () => "x".repeat(10_000) });
    const results = [custom, failing, empty, long].map((harness) => {
      run(harness, "python scan.py");
      run(harness, "python scan.py");
      return run(harness, "python scan.py")?.entries[0]?.content ?? "";
    });

    expect(results[0]).toBe("Try something else.");
    expect(results[1]).toContain("Anti-Repeat detected repeated work.");
    expect(results[2]).toContain("Anti-Repeat detected repeated work.");
    expect(results[3]).toHaveLength(4_000);
  });

  it("treats a failing continuation check as a new instruction", () => {
    const harness = started({
      isContinuation: () => {
        throw new Error("broken");
      },
    });
    run(harness, "python scan.py");
    run(harness, "python scan.py");
    expect(run(harness, "python scan.py")).toBeUndefined();
  });

  it("can run without status or notifications", () => {
    const harness = started({ notify: false, status: false });
    harness.controller.runStart();
    stream(harness, repeatedThinking("quiet"));
    harness.controller.settled(harness.ctx);
    harness.controller.reset(harness.ctx);

    expect(harness.sent).toHaveLength(1);
    expect(harness.ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("keeps working when another extension's listener throws", () => {
    const harness = started();
    harness.events.on(ANTI_REPEAT_EVENT_CHANNEL, () => {
      throw new Error("listener failed");
    });
    run(harness, "python scan.py");
    run(harness, "python scan.py");
    expect(run(harness, "python scan.py")?.continue).toBe(true);
  });
});

describe("AntiRepeatController control", () => {
  it("turns off, removes the listener, and turns on again", () => {
    const harness = started();
    harness.controller.setEnabled(false, harness.ctx);
    expect(harness.controller.state).toBe("off");
    expect(harness.activeSubscriptions).toBe(0);
    harness.controller.reset(harness.ctx);
    expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Anti-Repeat is off. Turn it on first.",
      "warning",
    );

    harness.controller.setEnabled(true, harness.ctx);
    expect(harness.controller.state).toBe("watching");
    expect(harness.activeSubscriptions).toBe(1);
    expect(harness.emitted.map((event) => event.type)).toEqual(["disabled", "enabled"]);
  });

  it("pauses and resumes for another extension, discarding the paused run", () => {
    const harness = started();
    run(harness, "python scan.py");
    run(harness, "python scan.py");
    harness.controller.runStart();
    control(harness, "pause");
    expect(harness.controller.state).toBe("paused");
    expect(harness.activeSubscriptions).toBe(0);
    expect(harness.controller.beforeSettle(harness.ctx)).toBeUndefined();
    harness.controller.settled(harness.ctx);

    control(harness, "resume");
    expect(harness.activeSubscriptions).toBe(1);
    expect(run(harness, "python scan.py")?.continue).toBe(true);
  });

  it("does not count a run that another extension restarts on purpose", () => {
    const harness = started();
    run(harness, "python scan.py");
    run(harness, "python scan.py");
    control(harness, "ignore-next-run");
    expect(run(harness, "python scan.py")).toBeUndefined();
    expect(run(harness, "python scan.py")?.continue).toBe(true);
  });

  it("starts a new epoch on a reset message", () => {
    const harness = started();
    run(harness, "python scan.py");
    run(harness, "python scan.py");
    control(harness, "reset");
    expect(run(harness, "python scan.py")).toBeUndefined();
    expect(harness.emitted.map((event) => event.type)).toEqual(["reset"]);
    expect(harness.emitted[0]?.epoch).toBeGreaterThan(1);
  });

  it("uses the documented control channel name", () => {
    expect(ANTI_REPEAT_CONTROL_CHANNEL).toBe("anti-repeat:control");
  });

  it("reports its state in plain words", () => {
    const harness = started();
    expect(harness.controller.statusText).toContain("watching");
    control(harness, "pause");
    expect(harness.controller.statusText).toContain("paused");
    control(harness, "resume");
    for (let index = 0; index < 3; index += 1) run(harness, "python scan.py");
    expect(harness.controller.statusText).toContain("sent one correction");
    for (let index = 0; index < 3; index += 1) run(harness, "python scan.py");
    expect(harness.controller.statusText).toContain("stopped");
    harness.controller.setEnabled(false, harness.ctx);
    expect(harness.controller.statusText).toBe("Anti-Repeat is off.");
  });
});
