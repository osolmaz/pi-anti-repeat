---
title: Anti-Repeat library plan
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-10-02
---

# Anti-Repeat library plan

This plan turns the Loop Guard extension into `pi-anti-repeat`, a Pi package that other Pi
distributions can install unchanged or configure from code. It records the design that was
agreed before implementation and the evidence behind its defaults.

## Evidence

A real loop came from GLM-5.3-Flash with maximum thinking. One response streamed 79,030 characters
of thinking over 74 seconds, and those characters held only 18 distinct sentences. A cycle of five
sentences repeated about 375 times. The original 96-word window detector fired after 887 words when
the thinking was replayed in chunks of 8 to 200 characters, about 5 seconds into the stream. The
rolling-hash detector in this plan fires after 866 words and costs about 0.6 microseconds per
24-character chunk, 16 times less than the original.

Both detectors ran over the thinking in 200 local sessions, which held 4,025 responses with at least
4,000 characters of thinking. Each fired 4 times, and all 4 were real repeats in the looping session. Three of them came after the user had told the model to stop
looping, so a second detection must stop the run instead of sending another message.

Session files are private and stay out of this repository. Tests use synthetic loops of the same
shape.

## Package shape

The package ships TypeScript source that Pi loads directly. It has three entry points:

- `pi-anti-repeat/core` contains the detectors. They take plain data and import nothing from Pi.
  They run synchronously in bounded memory. The reasoning detector imports nothing from Node either.
- `pi-anti-repeat` is the extension. `createAntiRepeat(options)` returns an extension factory, and
  the default export is that factory with default options.
- `pi-anti-repeat/protocol` holds the event channel names and versioned payload types for other
  extensions.

## Detection

The reasoning detector splits streamed thinking into words and hashes each word once. It keeps a
rolling hash of the last 96 words in a fixed ring buffer. Each word costs a constant number of
arithmetic operations, independent of the window size. Windows are sampled by their own hash, so
the same text is always sampled. A bounded table counts non-overlapping occurrences of each sampled
window. Three windows that each appear three times in one response produce a detection.

The run detectors keep the existing rules. They report an exact outcome cycle of length one
through four that repeats three times, or the same terminal error three times. They also report
four continuation-led runs with at least 85% action similarity. They run once per run over at most twelve summaries.

Every threshold is an option. The defaults are the values above.

## Policy and delivery

A policy chooses one action for each detection: `ignore`, `notify`, `correct`, or `stop`. The
default policy corrects the first detection in an epoch and stops on the second.

Delivery follows Pi's run lifecycle:

- A reasoning repeat aborts the response with `ctx.abort()`. An abort skips `agent_before_settle`,
  so the corrective message is sent from `agent_settled` as a follow-up that starts a new turn.
- Run detections are checked in `agent_before_settle`. A correction returns the message as a
  `custom_message` entry with `continue: true`, so Pi commits it and continues in one step.
- A stop aborts an active response and sends nothing else.

A substantive user instruction starts a new epoch. Short continuation prompts such as "continue"
stay in the current epoch, and the continuation check is an option.

## Activation and control

The extension is on by default. `/anti-repeat on|off|status|reset` changes only the current
session, and nothing is saved. While the extension is off or paused, it removes its stream
listener.

It emits versioned events on the `anti-repeat` channel of `pi.events`: `detected`, `corrected`,
`stopped`, `reset`, `enabled`, and `disabled`. It accepts versioned control messages on
`anti-repeat:control`: `pause`, `resume`, `reset`, and `ignore-next-run`. Each control message
names its sender. An extension that restarts a run on purpose sends `ignore-next-run` so that the
regenerated thinking is not counted.

## Contract impact

The visible corrective message is the only session entry the extension adds. It keeps no other
persistent data and touches no Pi internals. It uses only documented events and extension calls, which all exist in Pi 0.87.0 and
later.

## Verification

- Unit tests for the core detectors, the policy and the protocol parser, plus the controller.
- A synthetic loop shaped like the recorded one must be detected before 1,000 words, and varied
  long reasoning must not be detected.
- A speed test checks that the cost per word does not grow with the window size.
- `npm run replay -- <session.jsonl...>` replays local sessions. It reports each detection with how
  far into the stream it fired, plus the time per chunk.
- An RPC smoke test loads the package in Pi and checks the command and the default state.

## Rollout

1. Implement the plan in this repository, then review and merge it.
2. Tag `v0.1.0`.
3. Pin the merged commit in OnurPi through the `anti-repeat` wrapper package, enabled by default.
4. Integrate localpi separately with a generated factory file and `ignore-next-run` from its
   restart features.
5. Publish to npm only after separate approval.
