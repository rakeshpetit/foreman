---
status: accepted (decided 2026-10-26 in the M0-M1 review fixes; built in M1)
---

# A failed Workup stays at Workup and costs a Round

M1-T03 said a failed Stage "goes back to implement". For Workup that is wrong. Workup writes the acceptance test and foreman shows it failing before Implement (ADR 0006), so a failed Workup means there is no red test yet. Sending the Task to Implement would start the code with nothing to drive it. CONTEXT also defines a Round as the rework caused by a failed review, a failed Gate or an Owner rejection, and does not say whether a failed Workup is one of those.

## Decisions

- **A failed Workup goes back to Workup.** Implement, and Review after it, only fail back to Implement, as before. `route("workup", "FAIL", task)` is `goto workup`; every other failing Stage is `goto implement`.
- **A failed Workup costs a Round.** `round_stage` and `round_total` both go up by one.
  - A Workup that fails is the Agent Stage failing its own check (no test, or a test that does not go red). In M4 that check is the `red_before` Gate (M4-T04), and a failed Gate costs a Round in CONTEXT. Counting the Agent's failure the same way keeps the two consistent.
  - The Breaker (ADR 0006) bounds Rounds first. If Workup retries were free, a Task could loop at Workup until the time or token caps (M10) stop it.
  - A Round is a pass of rework, and writing the test again is rework.
- `round_stage` counts the Rounds caused by the Stage that sent the Task back. A Workup pass resets it to 0, and `round_total` keeps every Round.
- TASKS.md (M1-T03) keeps its original wording. This ADR supersedes it for Workup.

## Considered options

- **Failed Workup goes to Implement (M1-T03 as written):** rejected. Implement would run with no failing test, which breaks the red-before rule.
- **Failed Workup goes back to Workup without costing a Round:** rejected. It is the only retry loop the Breaker could not see.

## Consequences

- When the Breaker lands (M5), it counts Workup retries in the same limits as review and Gate Rounds.
- CONTEXT's definition of **Round** is not changed. A failed Workup counts because it is a failed Stage check, and in M4 a failed `red_before` Gate. If Workup ever becomes a Stage with no check, revisit this.
- With the configured Pipeline (M2-T02), "a Stage's pass resets `round_stage`" means every Stage except one that another Stage's `on_fail` sends the Task back to. In `defaults/pipeline.toml` that includes Workup, because the `red` Gate fails back to it, so every Workup pass keeps the count, including after a Workup that only failed itself. Workup and `red` failures therefore share one `round_stage` counter. M5-T05 (Breaker) should track the causing Stage if it needs them apart.
