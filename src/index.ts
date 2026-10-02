import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { AntiRepeatController, type ControllerContext } from "./controller.ts";
import { resolveOptions, type AntiRepeatOptions } from "./options.ts";
import { ANTI_REPEAT_CONTROL_CHANNEL, parseControl } from "./protocol.ts";

export type { AntiRepeatState } from "./controller.ts";
export type { Detection, DetectionKind, DetectorOptions } from "./core/index.ts";
export { correctionText, detectionLabel } from "./message.ts";
export {
  defaultPolicy,
  type AntiRepeatAction,
  type AntiRepeatOptions,
  type AntiRepeatPolicy,
  type PolicyInput,
} from "./options.ts";
export * from "./protocol.ts";

const SUBCOMMANDS = ["on", "off", "status", "reset"] as const;

export function runCommand(
  args: string,
  controller: AntiRepeatController,
  ctx: ControllerContext,
  command: string,
): void {
  switch (args.trim().toLowerCase()) {
    case "on":
      controller.setEnabled(true, ctx);
      return;
    case "off":
      controller.setEnabled(false, ctx);
      return;
    case "status":
      ctx.ui.notify(controller.statusText, "info");
      return;
    case "reset":
      controller.reset(ctx);
      return;
    default:
      ctx.ui.notify(`Usage: /${command} on|off|status|reset`, "warning");
  }
}

function registerCommand(
  pi: ExtensionAPI,
  controller: AntiRepeatController,
  command: string,
): void {
  pi.registerCommand(command, {
    description: "Turn repeat detection on or off, show its status, or start a new epoch",
    getArgumentCompletions: (prefix) => {
      const matches = SUBCOMMANDS.filter((name) => name.startsWith(prefix));
      return matches.length === 0 ? null : matches.map((name) => ({ label: name, value: name }));
    },
    handler: (args, ctx) => {
      runCommand(args, controller, ctx, command);
      return Promise.resolve();
    },
  });
}

/**
 * Creates the Anti-Repeat extension with the given options. Invalid options throw here, when the
 * extension is created, instead of during a session.
 */
export function createAntiRepeat(options: AntiRepeatOptions = {}): ExtensionFactory {
  const resolved = resolveOptions(options);
  return (pi: ExtensionAPI) => {
    // The stream listener is the only per-chunk work, so it is attached only while detecting.
    const subscribeStream = () =>
      pi.on("message_update", (event, ctx) => {
        controller.messageUpdate(event, ctx);
      });
    const controller = new AntiRepeatController(resolved, pi, subscribeStream);

    if (resolved.command !== false) registerCommand(pi, controller, resolved.command);
    pi.events.on(ANTI_REPEAT_CONTROL_CHANNEL, (data) => {
      const message = parseControl(data);
      if (message !== null) controller.control(message);
    });
    pi.on("session_start", (_event, ctx) => {
      controller.sessionStart(ctx);
    });
    pi.on("session_shutdown", (_event, ctx) => {
      controller.sessionShutdown(ctx);
    });
    pi.on("input", (event, ctx) => {
      controller.input(event, ctx);
    });
    pi.on("agent_start", () => {
      controller.runStart();
    });
    pi.on("turn_start", () => {
      controller.turnStart();
    });
    pi.on("message_start", (event) => {
      controller.messageStart(event.message);
    });
    pi.on("turn_end", (event) => {
      controller.turnEnd(event.message, event.toolResults);
    });
    pi.on("agent_end", (event) => {
      controller.agentEnd(event.messages);
    });
    pi.on("agent_before_settle", (_event, ctx) => controller.beforeSettle(ctx));
    pi.on("agent_settled", (_event, ctx) => {
      controller.settled(ctx);
    });
  };
}

/** Anti-Repeat with default options. */
export default createAntiRepeat();
