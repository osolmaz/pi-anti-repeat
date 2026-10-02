// A fake model for `npm run smoke`: its first response loops inside its thinking, and its second
// response changes course. It makes no network calls.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking } from "@earendil-works/pi-ai";

const cycle = [
  "The pending job queued and the script is waiting for the next poll result.",
  "Current state: the recovery script was served and the output file is still empty.",
  "Let me stop re-invoking stale sessions and check the output once more.",
  "Wait, I already ran the job, so the earlier result must be from the old session.",
  "OK, run the pending job again and poll the output file after it finishes.",
].join(" ");
const loop = Array.from({ length: 375 }, () => cycle).join(" ");

export default function (pi: ExtensionAPI) {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "loop", reasoning: true }],
    tokensPerSecond: 4_000,
  });
  faux.setResponses([
    fauxAssistantMessage([fauxThinking(loop), fauxText("still polling")]),
    fauxAssistantMessage([
      fauxThinking("The polling is not working. I should ask the user."),
      fauxText("I am stuck: the job output never appears. What should I check next?"),
    ]),
  ]);
  pi.registerProvider(faux.provider);
}
