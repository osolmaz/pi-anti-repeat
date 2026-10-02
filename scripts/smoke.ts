// End-to-end check in a real Pi process, with a fake model and no network calls.
//
// Usage: npm run smoke
//
// It starts the Pi from devDependencies in RPC mode with this package and `faux-loop.ts`, sends one
// prompt, and checks that Anti-Repeat cuts off the looping response, commits its correction, and
// lets the model answer in a new turn.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const timeoutMs = 60_000;

type Seen = { aborted: boolean; corrected: boolean; answered: boolean; notices: string[] };

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

function recordMessage(message: unknown, seen: Seen): void {
  if (field(message, "customType") === "anti-repeat") seen.corrected = true;
  if (field(message, "role") !== "assistant") return;
  const stopReason = field(message, "stopReason");
  if (stopReason === "aborted") seen.aborted = true;
  if (stopReason === "stop" && seen.corrected) seen.answered = true;
}

function record(event: unknown, seen: Seen): void {
  const type = field(event, "type");
  if (type === "extension_ui_request" && field(event, "method") === "notify") {
    seen.notices.push(String(field(event, "message")));
  }
  if (type === "message_end") recordMessage(field(event, "message"), seen);
}

function main(): void {
  const pi = spawn(
    "npx",
    [
      "--no-install",
      "pi",
      "--mode",
      "rpc",
      "--no-session",
      "-ne",
      "-e",
      root,
      "-e",
      `${root}scripts/faux-loop.ts`,
      "--provider",
      "faux",
      "--model",
      "loop",
    ],
    { cwd: root, stdio: ["pipe", "pipe", "inherit"] },
  );
  const seen: Seen = { aborted: false, answered: false, corrected: false, notices: [] };
  const timer = setTimeout(() => {
    console.error("smoke: timed out");
    pi.kill();
    process.exitCode = 1;
  }, timeoutMs);
  const lines = createInterface({ input: pi.stdout });
  lines.on("line", (line) => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    record(event, seen);
    if (seen.answered) {
      clearTimeout(timer);
      pi.kill();
    }
  });
  pi.on("exit", () => {
    clearTimeout(timer);
    const ok = seen.aborted && seen.corrected && seen.answered;
    console.log(
      `smoke: aborted=${String(seen.aborted)} corrected=${String(seen.corrected)} answered=${String(seen.answered)}`,
    );
    for (const notice of seen.notices) console.log(`smoke: notice: ${notice}`);
    if (!ok) process.exitCode = 1;
  });
  pi.stdin.write(
    `${JSON.stringify({ id: "1", message: "check the recovery job", type: "prompt" })}\n`,
  );
}

main();
