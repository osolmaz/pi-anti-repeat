# Development

These are the commands for working on pi-anti-repeat itself:

```bash
npm ci
npm run check
npm run smoke
npm run replay -- ~/.pi/agent/sessions/<dir>/<session>.jsonl
```

`smoke` starts real Pi processes with fake models. In one, the thinking loops and Anti-Repeat must
cut it off. In the other, the same answer comes back three times and Anti-Repeat must correct it
before Pi settles. Both times the model must answer after the correction.

`replay` runs the thinking in local session files through the detector and prints which responses
it would flag and how far into each one. It never prints session text.

The thinking check hashes each word once and updates the window hash in place, so its cost per word
does not depend on the window size. `tests/performance.test.ts` keeps that speed in check. Mutation
testing is manual: `npm run mutate`.

The design and the evidence behind the defaults are in the
[library plan](2026-10-02-anti-repeat-library-plan.md).
