---
status: accepted (grilled to shared understanding 2026-10-26; not yet built)
---

# SQLite holds the state machine; markdown in the Target repo holds the narrative

Foreman needs two kinds of record: state it queries and locks ("what Stage is T-12 in, how many Rounds, what is stalled?"), and prose that Agents and the Owner read and diff (Spec, Plan, reviews, Handoffs). Each goes where it fits.

## Decisions

- **SQLite** (foreman's own local data directory, gitignored) holds Requests, Milestones, Tasks, Stages, Rounds, leases, Approvals, Consent, and **every Run**: Agent, model, tokens in/out, cache, peak context, cost, duration and Verdict. Every Run is kept for retrospectives and later analysis.
- **Markdown** lives in the Target repo under `.foreman/R-<n>/`: `spec.md`, `plan.md`, the Tasks, a report from each Stage, Handoffs, Evidence, and a `summary.md` for each Task. It is **committed alongside the code**, as the article's archive branch is, so the reasoning for a change travels with the change.
- **`precedents.md`** is append-only.
- **`STATUS.md`** is generated from SQLite after every state change. It is the only monitoring UI in v1. A web dashboard can read the same database later.

## Considered options

- **SQLite only:** rejected, because plans and reviews are prose that people read and diff.
- **Markdown with YAML frontmatter only:** rejected, because locking, leases and "what is stuck?" become fragile once a Sweeper and an orchestrator touch the same files.

## Consequences

- There are two sources of truth, divided by kind: if they disagree about state, SQLite wins, and about content, markdown wins.
- The SQLite file is not backed up off-machine. Losing it loses state and Run history, but not the narrative, which is in git.
- Target repos get a `.foreman/` directory in their history.
