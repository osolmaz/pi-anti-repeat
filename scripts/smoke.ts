// End-to-end checks in a real Pi process, with fake models and no network calls.
//
// Usage: npm run smoke
//
// Each scenario starts the Pi from devDependencies in RPC mode with this package and a fake model.
// - `faux-loop.ts` loops inside one streamed thought. Anti-Repeat must cut the response off, send
//   its correction as a follow-up, and let the model answer in a new turn.
// - `faux-cycle.ts` gives the same answer three times. Anti-Repeat must commit its correction in
//   `agent_before_settle` and let Pi continue to a new answer.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const timeoutMs = 60_000;

type Scenario = {
  readonly name: string;
  readonly model: string;
  readonly prompts: readonly string[];
};
type Seen = { aborted: boolean; corrected: boolean; answered: boolean; runs: number };

const SCENARIOS: readonly Scenario[] = [
  { model: "faux-loop.ts", name: "looping thought", prompts: ["check the recovery job"] },
  {
    model: "faux-cycle.ts",
    name: "repeated runs",
    prompts: ["check the job", "continue", "continue"],
  },
];

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
  if (type === "message_end") recordMessage(field(event, "message"), seen);
  if (type === "entry_appended") recordMessage(field(event, "entry"), seen);
  if (type === "agent_end") seen.runs += 1;
}

function runScenario(scenario: Scenario): Promise<Seen> {
  const args = ["--no-install", "pi", "--mode", "rpc", "--no-session", "-ne"];
  args.push(
    "-e",
    root,
    "-e",
    `${root}scripts/${scenario.model}`,
    "--provider",
    "faux",
    "--model",
    "loop",
  );
  const pi = spawn("npx", args, { cwd: root, stdio: ["pipe", "pipe", "inherit"] });
  const seen: Seen = { aborted: false, answered: false, corrected: false, runs: 0 };
  let sent = 0;
  const send = () => {
    const message = scenario.prompts[sent];
    if (message === undefined) return;
    sent += 1;
    pi.stdin.write(`${JSON.stringify({ id: String(sent), message, type: "prompt" })}\n`);
  };
  return new Promise((resolve) => {
    const timer = setTimeout(() => pi.kill(), timeoutMs);
    createInterface({ input: pi.stdout }).on("line", (line) => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      record(event, seen);
      if (field(event, "type") === "agent_end" && sent < scenario.prompts.length) send();
      if (seen.answered) pi.kill();
    });
    pi.on("exit", () => {
      clearTimeout(timer);
      resolve(seen);
    });
    send();
  });
}

async function main(): Promise<void> {
  for (const scenario of SCENARIOS) {
    const seen = await runScenario(scenario);
    const ok =
      seen.corrected && seen.answered && (scenario.model !== "faux-loop.ts" || seen.aborted);
    console.log(
      `smoke: ${scenario.name}: ${ok ? "ok" : "FAILED"} (aborted=${String(seen.aborted)} corrected=${String(seen.corrected)} answered=${String(seen.answered)} runs=${String(seen.runs)})`,
    );
    if (!ok) process.exitCode = 1;
  }
}

await main();
