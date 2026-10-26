---
status: accepted (grilled to shared understanding 2026-10-26; not yet built)
---

# Quality comes from code Gates, test integrity, a Breaker, and Owner-approved Amendments

Each Task runs: Workup → Implement → Gates → Review(s) → Verify → merge → Research. Each of those Stages is configurable (ADR 0004). The rules below take the article's gates, and the failures that led to them, and make every limit configurable.

## Decisions

- **Test integrity:**
  - Workup writes the acceptance test and foreman shows it **failing before** Implement.
  - It must pass after.
  - Test changes are **separate commits**.
  - A Gate fails if tests are deleted, skipped or weakened.
  - A new E2E test failing on the base commit (`e2e_red_before`) is a per-repo setting, **off by default**, because it doubles a slow suite.
- **Gates foreman checks itself:** red then green, the repo's check command passes, the diff is under the size ceiling, test integrity, and Evidence exists with a PASS Verdict.
- **Several reviewers per Stage** (for example standards, spec and security), combined by `require = "all" | "any"`.
- **Breaker** (configurable):
  - at most 3 Rounds per review Stage, and 6 across a Task;
  - a wall-clock cap and a token cap per Stage.
  - When it trips, the Agent writes a **Handoff** (situation, what was tried, blocker, decision needed), the Task is parked as an Escalation, and the Owner is told on Telegram.
- **Precedents:** the Owner can tag a reply `#precedent`. It is appended to `precedents.md`, which planners and reviewers must read before escalating.
- **Scope control:**
  - An implementer can return the `SCOPE_CHANGE` Verdict, and going over the size ceiling triggers it automatically.
  - The Task is parked, the Planner drafts an **Amendment**, Plan review checks it, and the Owner approves it on Telegram before work resumes.
- **Fast lane:** Tasks estimated under about 30 lines skip a separate Workup and get one review Round.

## Considered options

- **No round limit, trusting reviewers to converge:** rejected. The article saw a one-line fix take eleven Rounds over two days.

## Consequences

- The Owner will see Escalations early on, while the limits are being tuned. Precedents are meant to reduce them over time.
