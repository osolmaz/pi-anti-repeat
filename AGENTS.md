# pi-anti-repeat

- Keep the core in `src/core` free of Pi imports. The reasoning detector must not import Node
  either.
- The thinking check runs on every streamed chunk. Keep its cost per word constant and independent
  of the window size, and keep the speed test in `tests/performance.test.ts` passing.
- Use only documented Pi extension APIs. Do not patch Pi or inspect provider payloads.
- Keep all state in memory and bounded. Never persist detector state or raw model, thinking, or tool
  content.
- Send at most one automatic correction per epoch under the default policy, then stop.
- Keep the `anti-repeat` event and `anti-repeat:control` protocol versioned. Change the version only
  for an incompatible payload change.
- Never commit session files or text copied from them. Use synthetic loops in tests.
- Add or update tests for every behavior change.
- Run `npm run check` and `git diff --check` before finishing.
- Keep mutation testing manual unless the user explicitly requests it.
