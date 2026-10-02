/** A repeat found by one of the detectors, with the evidence behind it. */
export type Detection =
  | {
      readonly kind: "reasoning_repeat";
      readonly windowWords: number;
      readonly repeats: number;
      readonly matchedWindows: number;
      readonly wordsObserved: number;
    }
  | {
      readonly kind: "outcome_cycle";
      readonly cycleLength: number;
      readonly repeats: number;
    }
  | {
      readonly kind: "repeated_error";
      readonly repeats: number;
    }
  | {
      readonly kind: "similar_actions";
      readonly runs: number;
      readonly similarity: number;
    };

export type DetectionKind = Detection["kind"];
