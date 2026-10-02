# pi-anti-repeat

pi-anti-repeat is an extension for the [Pi coding agent](https://github.com/earendil-works/pi) that
stops an agent that is stuck repeating itself. It watches the model's streamed thinking and its
finished runs, and when the same work keeps coming back, it cuts the response off and tells the
model to change its approach.

It catches loops inside a single thought as it streams. In one recorded case a model spent 74
seconds writing the same five sentences about 375 times. Replayed through the detector, that
response is stopped after 866 words, about 5 seconds in. It also catches runs that end with the
same outcome or the same error again and again.

## Install

```bash
pi install git:github.com/osolmaz/pi-anti-repeat
```

Run `/reload` in an open Pi session to load it. Add `@<commit>` or `@<tag>` to pin a version.

Anti-Repeat is on from the start of every session. It shows nothing in the footer while it is
only watching; the status line appears after it corrects or stops a run. Use `/anti-repeat off` to turn it off for the
current session. Nothing is saved between sessions.

## Detection and correction

On the first detection in an epoch, Anti-Repeat sends one visible `anti-repeat` message. The
message tells the model to stop the current approach and restate what it has verified before it
chooses a different next action. If the repetition was in streamed thinking, the response is cut off first and the message
starts a new turn. On a second detection in the same epoch, it stops the run and sends nothing else.

An epoch starts with each new instruction from you. Short prompts such as "continue" or "go ahead"
keep the current epoch, so a loop cannot hide behind them.

These checks trigger a detection:

- Three separate 96-word passages each appear three times in one streamed thought. Case,
  punctuation, whitespace, and Unicode composition do not matter.
- The same cycle of one to four run outcomes repeats three times.
- The same error ends three runs in a row.
- Four runs started by "continue" prompts repeat at least 85% of the same actions.

A long run on its own never triggers anything. Work that keeps making different progress continues.

## Commands

```text
/anti-repeat status
/anti-repeat off
/anti-repeat on
/anti-repeat reset
```

`reset` starts a new epoch, which also clears a stop.

## Cost

The thinking check runs on every streamed chunk, so it is built to be cheap. Each word is hashed
once and the window hash is updated in place, so the cost per word does not depend on the window
size. Streaming 1 MB of thinking through the detector takes about 24 ms, or about 0.6 microseconds
per 24-character chunk. The listener is removed while Anti-Repeat is off, paused, or stopped. Memory
stays bounded at 2,048 tracked windows per response and twelve run summaries.

Anti-Repeat never stores raw model output, thinking text, or tool content. The corrective message is the only
session entry it adds.

## Use it from code

Pi distributions can create the extension with their own options instead of installing the default:

```typescript
import { createAntiRepeat } from "pi-anti-repeat";

export default createAntiRepeat({
  enabled: true,
  command: "anti-repeat", // or false for no command
  status: "anti-repeat", // footer status key, or false
  notify: true,
  detectors: {
    reasoning: { windowWords: 96, repeats: 3, matchedWindows: 3 },
    repeatedError: false, // turn one detector off
  },
  policy: ({ detection, corrections, activeResponse }) => (corrections === 0 ? "correct" : "stop"),
  message: (detection) => "You are repeating yourself. Try a different approach.",
  isContinuation: (text) => /^(continue|go on)$/i.test(text.trim()),
});
```

The policy returns `ignore`, `notify`, `correct`, or `stop` for each detection. The default corrects
once and then stops. Invalid options throw when `createAntiRepeat` is called.

The detectors are also available without Pi from `pi-anti-repeat/core`:

```typescript
import { RepeatDetector } from "pi-anti-repeat/core";

const detector = new RepeatDetector();
detector.startReasoning();
for (const delta of stream) {
  const detection = detector.observeReasoning(delta);
  if (detection !== null) break;
}
```

## Events for other extensions

Anti-Repeat reports on the `anti-repeat` channel of `pi.events`. Each event has `version: 1`, a
`type` (`detected`, `corrected`, `stopped`, `reset`, `enabled`, or `disabled`), the current `epoch`,
and the `detection` when there is one. An extension that continues runs on its own should pause when
it sees `stopped`.

Other extensions can control it on the `anti-repeat:control` channel:

```typescript
import { ANTI_REPEAT_CONTROL_CHANNEL } from "pi-anti-repeat/protocol";

pi.events.emit(ANTI_REPEAT_CONTROL_CHANNEL, {
  version: 1,
  action: "ignore-next-run", // or "pause", "resume", "reset"
  source: "my-extension",
});
```

Send `ignore-next-run` just before you restart a run on purpose, for example after cutting off a
response, so the regenerated thinking is not counted as a repeat.

## Development

```bash
npm ci
npm run check
npm run smoke
npm run replay -- ~/.pi/agent/sessions/<dir>/<session>.jsonl
```

`smoke` starts real Pi processes with fake models. In one, the thinking loops and Anti-Repeat
must cut it off. In the other, the same answer comes back three times and Anti-Repeat must correct
it before Pi settles. Both times the model must answer after the correction. `replay` runs the thinking in local session files through the detector and prints which responses
it would flag and how far into each one. It never prints session text. Mutation testing is manual:
`npm run mutate`.

Anti-Repeat needs Pi 0.87.0 or later. The design and the evidence behind the defaults are in
[docs/2026-10-02-anti-repeat-library-plan.md](docs/2026-10-02-anti-repeat-library-plan.md).
