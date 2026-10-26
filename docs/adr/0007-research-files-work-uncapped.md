---
status: accepted (grilled to shared understanding 2026-10-26; not yet built)
---

# Research files its own Tasks without a cap; Origin and a Growth alert keep it visible

The article throttled its Research department after self-generated issues swamped the humans and duplicated earlier work. Foreman still files work on its own, because the Owner wants gaps found and closed, not just reported. A finding inside the approved Spec is treated as finishing the job already approved. A finding outside the Spec is new scope and goes through the Owner.

## Decisions

- **Per-Task Research** runs after a Task merges into the Milestone branch (in Manual Mode, after `approve`), so it sees approved code. It is a light pass: Sonnet, reading the Task diff, Spec, Plan and open Tasks, returning **at most 3 findings**.
- **Per-Milestone Research** is an optional, deeper Opus pass across the whole Milestone, before Milestone verify. Both are Stages in `pipeline.toml` and can be turned off.
- **A finding inside the Spec** becomes a Task with `origin = research` and its parent Task, auto-admitted to the current Milestone. **There is no cap.**
- **A finding outside the Spec** becomes a **Proposal** for the Owner to admit or drop on Telegram.
- **Every finding is checked for duplicates** against existing Tasks and Proposals before it is filed.
- **Visibility instead of limits:** `STATUS.md` shows planned vs research Tasks per Milestone, and a non-blocking **Growth alert** (ntfy) fires when research Tasks pass +50% of a Milestone's planned Tasks.
- **Product gaps only** in v1: Spec coverage, tests, edge cases, docs, security. Suggestions to change foreman's own prompts, Gates or config are deferred to v2 (as Proposals tagged `process`), because they change the Gates themselves.

## Considered options

- **Everything to a Proposed inbox:** rejected, because gaps inside an approved Spec should not need a second Approval.
- **A growth cap per Milestone and a cap on open Proposals (as in the article):** rejected by the Owner. Origin tagging and the Growth alert were preferred over hard stops.

## Consequences

- A Milestone can keep growing (research Tasks spawning research Tasks) and never reach Milestone Approval. The Growth alert is the only signal, and the Owner decides whether to step in.
- Each Task costs one more Run.
