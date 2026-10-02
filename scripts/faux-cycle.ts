// A fake model for `npm run smoke`: it gives the same answer to three prompts, then changes course
// after Anti-Repeat's correction. It makes no network calls.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "loop", reasoning: true }],
    tokensPerSecond: 100_000,
  });
  const same = () =>
    fauxAssistantMessage([fauxText("The job is still pending. I will check again.")]);
  faux.setResponses([
    same(),
    same(),
    same(),
    fauxAssistantMessage([fauxText("I keep getting the same result. What should I change?")]),
  ]);
  pi.registerProvider(faux.provider);
}
