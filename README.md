# pi-loop-guard

pi-loop-guard is an extension for the [Pi coding agent](https://github.com/earendil-works/pi) that
stops an agent that is stuck in a loop. When you turn it on, it notices when the agent keeps
repeating the same work and tells the model to change its approach before more time is lost.

Loop Guard watches streamed reasoning and finalized agent turns after you enable it. It uses deterministic, bounded fingerprints and action features. It does not call another model, inspect the filesystem, use the network, or scan the complete session transcript.

## Install

```bash
pi install git:github.com/osolmaz/pi-loop-guard
```

Run `/reload` in an open Pi session to load it. Add `@<commit>` or `@<tag>` to the source to pin a
version.

## Commands

```text
/loop-guard on
/loop-guard off
/loop-guard status
/loop-guard reset
/loop-guard nudge
```

The extension starts off after every load, reload, or session replacement. `/loop-guard on` starts a fresh in-memory detection epoch. A substantive user instruction also starts a fresh epoch. Short continuation prompts remain in the current epoch.

## Detection

Loop Guard intervenes after one of these bounded conditions:

- Three separate 96-token reasoning windows each appear three times while one assistant response is streaming.
- An exact outcome cycle of length one through four repeats three times.
- The same terminal error occurs three times.
- Four continuation-led episodes have at least 85% adjacent action similarity.

Turn and episode counts alone never trigger an intervention. Long agent runs continue while their reasoning, outcomes, actions, and errors remain materially distinct.

Matching on streamed reasoning ignores differences in letter case, and it splits words on punctuation and whitespace. Fuzzy action similarity never triggers by itself.

## Intervention policy

The first detection sends one visible `pi-loop-guard` message. It tells the model to stop the current approach and restate what it has verified. The model must then name the work that turned out wrong and choose a materially different action. A streamed-reasoning detection aborts the looping provider response immediately, then starts one corrective follow-up after Pi settles. Other active-run detections are delivered as steering.

A second detection in the same epoch trips the guard. It does not send another model message. If the agent is active, Loop Guard aborts it and waits for substantive user direction or `/loop-guard reset`.

Loop Guard emits `pi-loop-guard` events on `pi.events` with a `nudge` or `trip` action and `version: 1`. An extension that queues its own automatic runs can listen for them and pause before it starts another run.

## State and performance

Disabled handlers return before collecting detector state. Enabled episode state is bounded to twelve digests, sixteen turns per episode, thirty-two tool actions per episode, and 256 hashed action features. Streamed reasoning state keeps one 96-token rolling window and at most 2,048 content-selected hashes. Loop Guard keeps no raw model output, reasoning text, or tool content.

The package persists no settings or detector state. The visible intervention message is the only session entry it adds.

## Development

```bash
npm run check
npm run slophammer
```

Mutation testing remains manual:

```bash
npm run mutate
```
