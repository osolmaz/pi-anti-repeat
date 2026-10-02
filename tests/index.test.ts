import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import antiRepeat, { createAntiRepeat, runCommand } from "../src/index.ts";
import { AntiRepeatController } from "../src/controller.ts";
import { resolveOptions } from "../src/options.ts";
import { ANTI_REPEAT_CONTROL_CHANNEL } from "../src/protocol.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Command = {
  handler: (args: string, ctx: unknown) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => unknown;
};

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Command>();
  const events = createEventBus();
  const sendMessage = vi.fn();
  const pi = {
    events,
    on: (name: string, handler: Handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {
        handlers.set(
          name,
          (handlers.get(name) ?? []).filter((item) => item !== handler),
        );
      };
    },
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    sendMessage,
  };
  const ctx = {
    abort: vi.fn(),
    hasPendingMessages: () => false,
    isIdle: () => true,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
  const fire = (name: string, event: unknown = {}) =>
    (handlers.get(name) ?? []).map((handler) => handler(event, ctx));
  return { commands, ctx, events, fire, handlers, pi: pi as unknown as ExtensionAPI, sendMessage };
}

describe("createAntiRepeat", () => {
  it("exports a default factory that registers the command and lifecycle handlers", () => {
    const fake = fakePi();
    void antiRepeat(fake.pi);

    expect([...fake.commands.keys()]).toEqual(["anti-repeat"]);
    for (const name of [
      "session_start",
      "session_shutdown",
      "input",
      "agent_start",
      "turn_start",
      "message_start",
      "turn_end",
      "agent_end",
      "agent_before_settle",
      "agent_settled",
    ]) {
      expect(fake.handlers.get(name)).toHaveLength(1);
    }
    expect(fake.handlers.get("message_update") ?? []).toHaveLength(0);
  });

  it("attaches the stream listener only while detecting", async () => {
    const fake = fakePi();
    void createAntiRepeat()(fake.pi);
    fake.fire("session_start");
    expect(fake.handlers.get("message_update")).toHaveLength(1);

    await fake.commands.get("anti-repeat")?.handler("off", fake.ctx);
    expect(fake.handlers.get("message_update")).toHaveLength(0);
    await fake.commands.get("anti-repeat")?.handler("on", fake.ctx);
    expect(fake.handlers.get("message_update")).toHaveLength(1);
  });

  it("cuts off a repeating response through Pi's events", () => {
    const fake = fakePi();
    void createAntiRepeat()(fake.pi);
    fake.fire("session_start");
    fake.fire("agent_start");
    fake.fire("message_start", { message: { role: "assistant" } });
    const passage = Array.from({ length: 176 }, (_, index) => `loop${String(index)}`).join(" ");
    fake.fire("message_update", {
      assistantMessageEvent: { delta: `${passage} ${passage} ${passage}`, type: "thinking_delta" },
    });
    expect(fake.ctx.abort).toHaveBeenCalledOnce();

    expect(fake.fire("agent_before_settle")).toEqual([undefined]);
    fake.fire("agent_settled");
    expect(fake.sendMessage).toHaveBeenCalledOnce();
  });

  it("returns the boundary result from agent_before_settle", () => {
    const fake = fakePi();
    void createAntiRepeat()(fake.pi);
    fake.fire("session_start");
    let results: unknown[] = [];
    for (let index = 0; index < 3; index += 1) {
      fake.fire("agent_start");
      fake.fire("turn_end", {
        message: { role: "assistant", stopReason: "stop" },
        toolResults: [],
      });
      fake.fire("agent_end", { messages: [] });
      results = fake.fire("agent_before_settle");
      fake.fire("agent_settled");
    }
    expect(results[0]).toMatchObject({ continue: true });
  });

  it("accepts valid control messages and ignores others", () => {
    const fake = fakePi();
    void createAntiRepeat()(fake.pi);
    fake.fire("session_start");
    fake.events.emit(ANTI_REPEAT_CONTROL_CHANNEL, { action: "explode", source: "x", version: 1 });
    expect(fake.handlers.get("message_update")).toHaveLength(1);
    fake.events.emit(ANTI_REPEAT_CONTROL_CHANNEL, { action: "pause", source: "x", version: 1 });
    expect(fake.handlers.get("message_update")).toHaveLength(0);
  });

  it("can start off, rename the command, or have no command", () => {
    const renamed = fakePi();
    void createAntiRepeat({ command: "repeats", enabled: false })(renamed.pi);
    renamed.fire("session_start");
    expect([...renamed.commands.keys()]).toEqual(["repeats"]);
    expect(renamed.handlers.get("message_update") ?? []).toHaveLength(0);

    const none = fakePi();
    void createAntiRepeat({ command: false })(none.pi);
    expect(none.commands.size).toBe(0);
  });

  it("completes subcommands", () => {
    const fake = fakePi();
    void createAntiRepeat()(fake.pi);
    const complete = fake.commands.get("anti-repeat")?.getArgumentCompletions;
    expect(complete?.("o")).toEqual([
      { label: "on", value: "on" },
      { label: "off", value: "off" },
    ]);
    expect(complete?.("zzz")).toBeNull();
  });

  it("rejects invalid options when created", () => {
    expect(() => createAntiRepeat({ detectors: { reasoning: { windowWords: 1 } } })).toThrow(
      "reasoning.windowWords",
    );
  });
});

describe("runCommand", () => {
  it("handles each subcommand and explains usage", () => {
    const controller = new AntiRepeatController(
      resolveOptions(),
      { events: createEventBus(), sendMessage: vi.fn() },
      () => () => undefined,
    );
    const ctx = {
      abort: vi.fn(),
      hasPendingMessages: () => false,
      isIdle: () => true,
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    };
    controller.sessionStart(ctx);
    runCommand("status", controller, ctx, "anti-repeat");
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("watching"), "info");
    runCommand(" RESET ", controller, ctx, "anti-repeat");
    expect(ctx.ui.notify).toHaveBeenLastCalledWith("Anti-Repeat started a new epoch.", "info");
    runCommand("maybe", controller, ctx, "anti-repeat");
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      "Usage: /anti-repeat on|off|status|reset",
      "warning",
    );
  });
});
