const CONTINUATION_CLAUSES = [
  "keep going",
  "carry on",
  "go ahead",
  "you decide",
  "you choose",
  "proceed",
  "continue",
  "resume",
  "go on",
  "do it",
] as const;
const CONTINUATION_JOINERS = ["and", "then"] as const;
const POLITE_WORDS = ["please", "now"] as const;

function consumePrefix(value: string, candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    if (value === candidate) return "";
    if (value.startsWith(`${candidate} `)) return value.slice(candidate.length + 1);
  }
  return undefined;
}

function trimPoliteWords(value: string): string {
  let remaining = value;
  let changed = true;
  while (changed && remaining.length > 0) {
    changed = false;
    for (const word of POLITE_WORDS) {
      if (remaining === word) return "";
      if (remaining.startsWith(`${word} `)) {
        remaining = remaining.slice(word.length + 1);
        changed = true;
      }
      if (remaining.endsWith(` ${word}`)) {
        remaining = remaining.slice(0, -(word.length + 1));
        changed = true;
      }
    }
  }
  return remaining;
}

/**
 * Says whether an English prompt only tells the agent to keep going, such as "continue" or
 * "go ahead, you decide". Such prompts keep the current detection epoch; any other prompt from the
 * user starts a new one.
 */
export function isContinuationPrompt(text: string): boolean {
  if (text.length > 200) return false;
  let remaining = trimPoliteWords(
    text
      .normalize("NFKC")
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{N}\s]+/gu, " ")
      .replaceAll(/\s+/gu, " ")
      .trim(),
  );
  let clauses = 0;
  while (remaining.length > 0 && clauses < 3) {
    const afterClause = consumePrefix(remaining, CONTINUATION_CLAUSES);
    if (afterClause === undefined) return false;
    clauses += 1;
    remaining = trimPoliteWords(afterClause);
    const afterJoiner = consumePrefix(remaining, CONTINUATION_JOINERS);
    if (afterJoiner === "") return false;
    if (afterJoiner !== undefined) remaining = trimPoliteWords(afterJoiner);
  }
  return clauses > 0 && remaining.length === 0;
}
