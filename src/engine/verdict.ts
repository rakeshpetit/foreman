/** The Verdicts an Agent may give (CONTEXT: Verdict). The one list: AGENT.md, the Runner, the store and `route` all use it. */
export const VERDICTS = ["PASS", "FAIL", "BLOCKED", "SCOPE_CHANGE"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** The Verdicts `route` can act on. `BLOCKED` and `SCOPE_CHANGE` wait for M5-T06 and M5-T08. */
export type RoutedVerdict = "PASS" | "FAIL";

export function isRouted(verdict: Verdict): verdict is RoutedVerdict {
  return verdict === "PASS" || verdict === "FAIL";
}
